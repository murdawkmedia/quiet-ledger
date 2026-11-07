import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_PREVIEW_HEADERS,CSV_PREVIEW_LEGACY_HEADERS,previewInvoiceCsv} from '../shared/csv-preview.js';

const encode=(cells:string[])=>cells.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(',');
const header=()=>encode([...CSV_PREVIEW_HEADERS]);
const row=(overrides:Record<string,string>={})=>{
 const values:{[name:string]:string}={...{
  Invoice:'INV-FICTIONAL-1',Customer:'Fictional Studio',Title:'Fictional service',Currency:'CAD',Total:'10.00','Effective total':'10.00','Pricing method':'','Original tax':'0','Effective tax':'0','Method discount':'0','Method premium':'0','Method tax adjustment':'0',Paid:'3.00',Credited:'2.00',Due:'5.00',Overpaid:'0.00',State:'partially_paid',Mode:'live','Issue date':'2026-11-06','Due date':'2026-12-06',Agreement:'',
 },...overrides};
 if(!('Effective total'in overrides))values['Effective total']=overrides.Total??'10.00';
 return CSV_PREVIEW_HEADERS.map(name=>values[name]);
};
const csv=(...records:string[][])=>[header(),...records.map(encode)].join('\r\n')+'\r\n';
/** Worked example: issued 283500, lightning −10% on the 200000 eligible base → effective 262500. */
const pricedRow=(overrides:Record<string,string>={})=>row({
 Invoice:'INV-PRICED-1',Total:'2835.00','Effective total':'2625.00','Pricing method':'lightning','Original tax':'135.00','Effective tax':'125.00','Method discount':'200.00','Method premium':'0.00','Method tax adjustment':'-10.00',Paid:'0.00',Credited:'0.00',Due:'2625.00',Overpaid:'0.00',State:'unpaid',Agreement:'1b6f9c2a-5f4e-4f3a-9d2b-7c8e6a5b4d3c',...overrides,
});

test('CSV preview recognizes exported balances with quoted text, BOM, embedded newlines and exact minor units',()=>{
 const result=previewInvoiceCsv('\ufeff'+csv(row({Customer:'Fictional, "Studio"',Title:'First line\nSecond line',Total:'90071992547409.91',Paid:'0',Credited:'0',Due:'90071992547409.91',State:'unpaid'})));
 assert.equal(result.rows[0].classification,'new');assert.equal(result.rows[0].record?.customerName,'Fictional, "Studio"');assert.equal(result.rows[0].record?.title,'First line\nSecond line');
 assert.equal(result.rows[0].record?.balance.total,Number.MAX_SAFE_INTEGER);assert.equal(result.notice,'Preview only; no records imported');
});

test('matches only supplied existing numbers and marks every duplicate record',()=>{
 const result=previewInvoiceCsv(csv(row(),row({Invoice:'INV-DUP'}),row({Invoice:'INV-DUP'}),row({Invoice:'INV-NEW'})),[{number:'INV-FICTIONAL-1'}]);
 assert.deepEqual(result.rows.map(row=>row.classification),['existing','duplicate','duplicate','new']);assert.deepEqual(result.counts,{existing:1,duplicate:2,new:1,invalid:0});
 assert(result.rows[1].issues.some(issue=>/duplicate/i.test(issue)));
});

test('whole won and state/amount equations are validated without rounding',()=>{
 const result=previewInvoiceCsv(csv(row({Currency:'KRW',Total:'144001',Paid:'0',Credited:'0',Due:'144001',Overpaid:'0',State:'unpaid'}),row({Invoice:'INV-KRW-INVALID',Currency:'KRW',Total:'144.00'}),row({Invoice:'INV-MISMATCH',Due:'5.01'}),row({Invoice:'INV-WRONG-STATE',State:'paid'})));
 assert.equal(result.rows[0].record?.balance.total,144001);assert.deepEqual(result.rows.map(row=>row.classification),['new','invalid','invalid','invalid']);
 assert(result.rows[1].issues.some(issue=>/whole/i.test(issue)));assert(result.rows[2].issues.some(issue=>/balance/i.test(issue)));assert(result.rows[3].issues.some(issue=>/state/i.test(issue)));
});

test('voids, full credits and overpayments stay distinct',()=>{
 const result=previewInvoiceCsv(csv(row({Invoice:'INV-VOID',Paid:'0',Credited:'2',Due:'0',State:'void'}),row({Invoice:'INV-CREDIT',Paid:'0',Credited:'10',Due:'0',State:'credited'}),row({Invoice:'INV-OVER',Paid:'12',Credited:'0',Due:'0',Overpaid:'2',State:'paid'})));
 assert.deepEqual(result.rows.map(row=>row.classification),['new','new','new']);assert.equal(result.rows[2].record?.balance.overpaid,200);
});

test('rejects invalid currency, precision, unsafe integers, mode, dates and missing fields per record',()=>{
 const changes:Record<string,string>[]=[{Currency:'BTC'},{Total:'10.001'},{Paid:'=2+1'},{Due:'90071992547409.92'},{Mode:'test'},{'Issue date':'2026-02-30'},{Invoice:''},{Total:'0',Paid:'0',Credited:'0',Due:'0',State:'unpaid'}];
 const records=changes.map((change,index)=>row({Invoice:'INV-INVALID-'+index,...change}));
 const result=previewInvoiceCsv(csv(...records));assert.equal(result.counts.invalid,records.length);assert(result.rows.every(row=>row.issues.length>0));
});

test('formula-like and URL-like text stays inert text in preview',()=>{
 const result=previewInvoiceCsv(csv(row({Title:'=HYPERLINK("https://fictional.invalid","test")',Customer:'https://fictional.invalid'})));
 assert.equal(result.rows[0].classification,'new');assert.equal(result.rows[0].record?.title,'=HYPERLINK("https://fictional.invalid","test")');
});

test('CSV preview flags a due date before the invoice issue date',()=>{
 const result=previewInvoiceCsv(csv(row({'Issue date':'2026-11-06','Due date':'2026-11-05'})));
 assert.equal(result.rows[0].classification,'invalid');assert(result.rows[0].issues.some(issue=>/before.*issue/i.test(issue)));
});

test('rejects malformed quotes, control text and mismatched header schema',()=>{
 for(const value of [header()+'\n"unclosed',header()+'\nabc"def',header()+'\n"closed"tail',header()+'\n\0',header().replace('Customer','Unknown')])assert.throws(()=>previewInvoiceCsv(value));
 const short=previewInvoiceCsv(csv(['INV-SHORT','Fictional']));assert.equal(short.rows[0].classification,'invalid');
});

test('bounds UTF-8 size, logical record count and columns before previewing',()=>{
 assert.throws(()=>previewInvoiceCsv('🦫'.repeat(4097)),/16 KiB/);
 assert.throws(()=>previewInvoiceCsv(header()+'\n'+Array(33).fill('x').join(',')),/32/);
 assert.throws(()=>previewInvoiceCsv(''),/header/i);
 // Compact unquoted whole-won records keep 201 records under the 16 KiB byte cap so the record bound triggers.
 const small=(index:number)=>`i${index},x,x,KRW,1,1,,0,0,0,0,0,0,1,0,unpaid,live,,,,`;
 assert.throws(()=>previewInvoiceCsv(header()+'\r\n'+Array.from({length:201},(_,i)=>small(i)).join('\r\n')+'\r\n'),/200/);
 assert.equal(previewInvoiceCsv(header()+'\r\n'+Array.from({length:200},(_,i)=>small(i)).join('\r\n')+'\r\n').rows.length,200);
});

test('effective-price records carry the agreement method, discount and signed tax adjustment',()=>{
 const result=previewInvoiceCsv(csv(pricedRow()));
 assert.equal(result.rows[0].classification,'new');
 assert.equal(result.rows[0].record?.balance.total,283500);assert.equal(result.rows[0].record?.balance.effectiveTotal,262500);
 assert.equal(result.rows[0].record?.pricingMethod,'lightning');assert.equal(result.rows[0].record?.methodDiscount,20000);
 assert.equal(result.rows[0].record?.methodTaxAdjustment,-1000);assert.equal(result.rows[0].record?.agreementId,'1b6f9c2a-5f4e-4f3a-9d2b-7c8e6a5b4d3c');
});

test('effective-price balances, states, credits and overpayments settle against the effective total',()=>{
 const result=previewInvoiceCsv(csv(
  pricedRow({Invoice:'INV-PART',Paid:'1000.00',Due:'1625.00',State:'partially_paid'}),
  pricedRow({Invoice:'INV-PAID',Paid:'2625.00',Due:'0.00',State:'paid'}),
  pricedRow({Invoice:'INV-CREDIT',Paid:'0.00',Credited:'2625.00',Due:'0.00',State:'credited'}),
  pricedRow({Invoice:'INV-OVER',Paid:'2700.00',Due:'0.00',Overpaid:'75.00',State:'paid'})));
 assert.deepEqual(result.rows.map(row=>row.classification),['new','new','new','new']);
 assert.equal(result.rows[0].record?.balance.due,162500);assert.equal(result.rows[3].record?.balance.overpaid,7500);
});

test('premium-priced records accept positive signed tax adjustments',()=>{
 const result=previewInvoiceCsv(csv(pricedRow({Invoice:'INV-CARD',Total:'2835.00','Effective total':'2877.00','Pricing method':'card','Original tax':'135.00','Effective tax':'137.00','Method discount':'0.00','Method premium':'40.00','Method tax adjustment':'2.00',Due:'2877.00',Agreement:'2c7f8d3b-6a5f-4e4b-8e3c-9d7f1b6c5e4d'})));
 assert.equal(result.rows[0].classification,'new');assert.equal(result.rows[0].record?.methodPremium,4000);assert.equal(result.rows[0].record?.methodTaxAdjustment,200);assert.equal(result.rows[0].record?.balance.effectiveTotal,287700);
});

test('rejects non-canonical methods, missing or malformed agreements and tax mismatches',()=>{
 const result=previewInvoiceCsv(csv(
  pricedRow({Invoice:'INV-ALIAS','Pricing method':'square'}),
  pricedRow({Invoice:'INV-NO-AGREEMENT',Agreement:''}),
  pricedRow({Invoice:'INV-NO-METHOD','Pricing method':'',Agreement:'1b6f9c2a-5f4e-4f3a-9d2b-7c8e6a5b4d3c'}),
  pricedRow({Invoice:'INV-BAD-UUID',Agreement:'not-a-uuid'}),
  pricedRow({Invoice:'INV-TAX','Effective tax':'124.00'})));
 assert.deepEqual(result.rows.map(row=>row.classification),Array(5).fill('invalid'));
 assert(result.rows[0].issues.some(issue=>/canonical/i.test(issue)));assert(result.rows[1].issues.some(issue=>/agreement id/i.test(issue)));
 assert(result.rows[2].issues.some(issue=>/pricing method/i.test(issue)));assert(result.rows[3].issues.some(issue=>/UUID/i.test(issue)));
 assert(result.rows[4].issues.some(issue=>/tax/i.test(issue)));
});

test('rejects unpriced rows carrying method adjustments and negative non-adjustment amounts',()=>{
 const result=previewInvoiceCsv(csv(
  pricedRow({Invoice:'INV-UNPRICED-ADJ','Pricing method':'',Agreement:'','Effective total':'2625.00'}),
  pricedRow({Invoice:'INV-NEG-DISCOUNT','Method discount':'-200.00'}),
  pricedRow({Invoice:'INV-SIGN-TOTAL',Total:'-2835.00','Effective total':'-2625.00'})));
 assert.deepEqual(result.rows.map(row=>row.classification),['invalid','invalid','invalid']);
 assert(result.rows[0].issues.some(issue=>/unpriced/i.test(issue)));assert(result.rows[1].issues.every(issue=>!/canonical|agreement/i.test(issue)));
});

test('balance equations settle against the effective total, not the original total',()=>{
 const result=previewInvoiceCsv(csv(
  pricedRow({Invoice:'INV-DUE-ORIGINAL',Due:'2835.00'}),
  pricedRow({Invoice:'INV-EQ-TOTAL',Due:'0.00',Paid:'2835.00',State:'paid'})));
 assert.equal(result.rows[0].classification,'invalid');assert(result.rows[0].issues.some(issue=>/balance/i.test(issue)));
 assert.equal(result.rows[1].classification,'invalid');assert(result.rows[1].issues.some(issue=>/balance/i.test(issue)));
});

test('retired 13-column files still preview with the original validations',()=>{
 const legacyHeader=encode([...CSV_PREVIEW_LEGACY_HEADERS]);
 const legacyRow=(overrides:Record<string,string>={})=>{
  const values:{[name:string]:string}={...{Invoice:'INV-LEGACY-1',Customer:'Fictional Studio',Title:'Fictional service',Currency:'CAD',Total:'10.00',Paid:'3.00',Credited:'2.00',Due:'5.00',Overpaid:'0.00',State:'partially_paid',Mode:'live','Issue date':'2026-11-06','Due date':'2026-12-06'},...overrides};
  return CSV_PREVIEW_LEGACY_HEADERS.map(name=>values[name]);
 };
 const body=(...records:string[][])=>[legacyHeader,...records.map(encode)].join('\r\n')+'\r\n';
 const result=previewInvoiceCsv(body(legacyRow(),legacyRow({Invoice:'INV-LEGACY-BAD',Due:'4.00'})),[{number:'INV-LEGACY-1'}]);
 assert.deepEqual(result.rows.map(row=>row.classification),['existing','invalid']);
 assert.equal(result.rows[0].record?.balance.total,1000);assert.equal(result.rows[0].record?.balance.effectiveTotal,1000);
 assert.equal(result.rows[0].record?.pricingMethod,undefined);assert(result.rows[1].issues.some(issue=>/balance/i.test(issue)));
 assert.throws(()=>previewInvoiceCsv(legacyHeader.replace('Customer','Unknown')+'\r\n'),/header/i);
});
