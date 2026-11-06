import test from 'node:test';
import assert from 'node:assert/strict';
import {CSV_PREVIEW_HEADERS,previewInvoiceCsv} from '../shared/csv-preview.js';

const encode=(cells:string[])=>cells.map(cell=>'"'+cell.replaceAll('"','""')+'"').join(',');
const header=()=>encode([...CSV_PREVIEW_HEADERS]);
const row=(overrides:Record<string,string>={})=>CSV_PREVIEW_HEADERS.map(name=>({...{
 Invoice:'INV-FICTIONAL-1',Customer:'Fictional Studio',Title:'Fictional service',Currency:'CAD',Total:'10.00',Paid:'3.00',Credited:'2.00',Due:'5.00',Overpaid:'0.00',State:'partially_paid',Mode:'live','Issue date':'2026-11-06','Due date':'2026-12-06',
},...overrides} as Record<string,string>)[name]);
const csv=(...records:string[][])=>[header(),...records.map(encode)].join('\r\n')+'\r\n';

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
 const small=CSV_PREVIEW_HEADERS.map(name=>name==='Invoice'?'i':name==='Customer'||name==='Title'?'x':name==='Currency'?'KRW':name==='Mode'?'live':name==='State'?'unpaid':name==='Total'||name==='Due'?'1':name==='Issue date'||name==='Due date'?'':'0');
 assert.throws(()=>previewInvoiceCsv(csv(...Array.from({length:201},(_,i)=>small.map((v,n)=>n===0?'i'+i:v)))),/200/);
 assert.equal(previewInvoiceCsv(csv(...Array.from({length:200},(_,i)=>small.map((v,n)=>n===0?'i'+i:v)))).rows.length,200);
});
