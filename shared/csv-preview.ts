import type{Currency,Invoice} from './contracts.js';
import type{CurrencyBalanceSummary} from './currency-report.js';
import type{InvoiceBalance,InvoiceLedgerEntry} from './invoice-ledger.js';
import {METHOD_DEFINITIONS} from './payment-methods.js';

export const CSV_PREVIEW_HEADERS=['Invoice','Customer','Title','Currency','Total','Effective total','Pricing method','Original tax','Effective tax','Method discount','Method premium','Method tax adjustment','Paid','Credited','Due','Overpaid','State','Mode','Issue date','Due date','Agreement'] as const;
/** Retired 13-column export header; older files keep previewing unchanged. */
export const CSV_PREVIEW_LEGACY_HEADERS=['Invoice','Customer','Title','Currency','Total','Paid','Credited','Due','Overpaid','State','Mode','Issue date','Due date'] as const;
export const CSV_PREVIEW_NOTICE='Preview only; no records imported' as const;
export const CSV_PREVIEW_MAX_BYTES=16*1024;
export interface CsvBalanceRecord {invoiceNumber:string;customerName:string;title:string;balance:InvoiceBalance;/** Effective-price format only: the canonical agreed pricing method. */pricingMethod?:string;/** Effective-price format only: agreed method discount in minor units. */methodDiscount?:number;/** Effective-price format only: agreed method premium in minor units. */methodPremium?:number;/** Effective-price format only: signed effectiveTax minus original tax. */methodTaxAdjustment?:number;/** Effective-price format only: the payer-confirmed agreement id. */agreementId?:string;issueDate?:string;dueDate?:string}
export type CsvPreviewClassification='existing'|'duplicate'|'new'|'invalid';
export interface CsvPreviewRow {row:number;invoiceNumber:string;classification:CsvPreviewClassification;issues:string[];record?:CsvBalanceRecord}
export interface CsvPreview {rows:CsvPreviewRow[];counts:Record<CsvPreviewClassification,number>;notice:typeof CSV_PREVIEW_NOTICE}
/** Deliberate allowlists: statements have no public capabilities, payment identifiers or private notes. */
export type StatementInvoice=Pick<Invoice,'id'|'number'|'title'|'customerName'|'currency'|'items'|'taxBps'|'subtotal'|'tax'|'total'|'status'|'createdAt'|'issueDate'|'dueDate'|'paidAt'|'paymentTermDays'|'paymentTerms'|'discountBps'|'premiumBps'|'discountAmount'|'premiumAmount'|'methodPricing'|'priceAgreement'>;
export type StatementEntry=Pick<InvoiceLedgerEntry,'id'|'kind'|'amount'|'currency'|'createdAt'|'reason'|'method'|'verification'|'receiptNumber'>;
export interface InvoiceStatementPreview {invoices:{invoice:StatementInvoice;balance:InvoiceBalance;entries:StatementEntry[]}[];summary:CurrencyBalanceSummary[]}

/** Bounded RFC-style records. Quoted newlines are part of a cell, never another record. */
function records(csv:string):string[][]{
 if(new TextEncoder().encode(csv).length>CSV_PREVIEW_MAX_BYTES)throw new Error('CSV exceeds the 16 KiB UTF-8 limit.');
 csv=csv.replace(/^\ufeff/,'');
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/u.test(csv))throw new Error('CSV contains invalid control text.');
 const output:string[][]=[];let row:string[]=[],cell='',quoted=false,closed=false,started=false;
 const finishCell=()=>{row.push(cell);if(row.length>32)throw new Error('CSV exceeds the 32-column limit.');cell='';closed=false;started=false;};
 const finishRow=()=>{finishCell();output.push(row);row=[];if(output.length>201)throw new Error('CSV exceeds the 200-record limit.');};
 for(let i=0;i<csv.length;i++){
  const char=csv[i];
  if(quoted){if(char==='"'){if(csv[i+1]==='"'){cell+='"';i++;}else{quoted=false;closed=true;}}else cell+=char;continue;}
  if(char===','){finishCell();continue;}
  if(char==='\r'||char==='\n'){finishRow();if(char==='\r'&&csv[i+1]==='\n')i++;continue;}
  if(closed)throw new Error('Malformed CSV: unexpected text after a closing quote.');
  if(char==='"'){if(started)throw new Error('Malformed CSV: quote inside an unquoted field.');quoted=true;started=true;}else{cell+=char;started=true;}
 }
 if(quoted)throw new Error('Malformed CSV: unclosed quoted field.');
 if(started||closed||cell.length||row.length)finishRow();
 return output;
}
function dateValid(value:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T00:00:00.000Z');return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function minor(value:string,currency:Currency):number{
 const wholeUnits=currency==='KRW'||currency==='SAT';
 if(!(wholeUnits?/^\d+$/:/^\d+(?:\.\d{1,2})?$/).test(value))throw new Error(currency==='KRW'?'Use nonnegative whole won amounts for KRW.':currency==='SAT'?'Use nonnegative whole satoshi amounts for SAT.':'Use nonnegative amounts with at most two decimal places.');
 const [whole,fraction='']=value.split('.'),amount=wholeUnits?BigInt(whole):BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Amount exceeds the supported integer precision.');return Number(amount);
}
/** Signed minor units; only the method tax adjustment column may carry a leading minus. */
function signedMinor(value:string,currency:Currency):number{
 if(!value.startsWith('-'))return minor(value,currency);
 return -minor(value.slice(1),currency);
}
const canonicalMethods=new Set<string>(METHOD_DEFINITIONS.map(method=>method.id));
const agreementIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** No receipts, invoice issuance, formulas, URL resolution, storage or network effects. */
export function previewInvoiceCsv(csv:string,existing:ReadonlyArray<Pick<Invoice,'number'>>=[]):CsvPreview{
 const rows=records(csv),header=rows.shift();
 if(!header)throw new Error('Use the invoice balance CSV header: '+CSV_PREVIEW_HEADERS.join(', ')+'.');
 const legacy=header.length===CSV_PREVIEW_LEGACY_HEADERS.length&&header.every((value,index)=>value===CSV_PREVIEW_LEGACY_HEADERS[index]);
 if(!legacy&&(header.length!==CSV_PREVIEW_HEADERS.length||header.some((value,index)=>value!==CSV_PREVIEW_HEADERS[index])))throw new Error('Use the invoice balance CSV header: '+CSV_PREVIEW_HEADERS.join(', ')+' (or the retired 13-column header).');
 const columns=legacy?CSV_PREVIEW_LEGACY_HEADERS.length:CSV_PREVIEW_HEADERS.length;
 const occurrences=new Map<string,number>(),existingNumbers=new Set(existing.map(invoice=>invoice.number));
 for(const row of rows)if(row[0])occurrences.set(row[0],(occurrences.get(row[0])??0)+1);
 const preview:CsvPreview={rows:[],counts:{existing:0,duplicate:0,new:0,invalid:0},notice:CSV_PREVIEW_NOTICE};
 for(const [index,cells] of rows.entries()){
  const issues:string[]=[],invoiceNumber=cells[0]??'';let record:CsvBalanceRecord|undefined;
  if(cells.length!==columns)issues.push('Record has a different number of columns from the header.');
  else{
   let number:string,customerName:string,title:string,currencyText:string,totalText:string,paidText:string,creditedText:string,dueText:string,overpaidText:string,stateText:string,modeText:string,issueDate:string,dueDate:string;
   let effectiveTotalText:string,methodText:string,originalTaxText:string,effectiveTaxText:string,methodDiscountText:string,methodPremiumText:string,methodTaxAdjustmentText:string,agreementText:string;
   if(legacy)[number,customerName,title,currencyText,totalText,paidText,creditedText,dueText,overpaidText,stateText,modeText,issueDate,dueDate]=cells,[effectiveTotalText,methodText,originalTaxText,effectiveTaxText,methodDiscountText,methodPremiumText,methodTaxAdjustmentText,agreementText]=['','','','','','','',''];
   else[number,customerName,title,currencyText,totalText,effectiveTotalText,methodText,originalTaxText,effectiveTaxText,methodDiscountText,methodPremiumText,methodTaxAdjustmentText,paidText,creditedText,dueText,overpaidText,stateText,modeText,issueDate,dueDate,agreementText]=cells;
   if(!number.trim()||!customerName.trim()||!title.trim())issues.push('Invoice, Customer and Title are required.');
   const currencies:readonly string[]=['CAD','USD','EUR','GBP','KRW','SAT'],states:readonly string[]=['unpaid','partially_paid','paid','credited','void'];
   if(!currencies.includes(currencyText))issues.push('Currency must be CAD, USD, EUR, GBP, KRW or SAT.');
   if(!states.includes(stateText))issues.push('Unknown invoice state.');
   if(!['live','simulation'].includes(modeText))issues.push('Mode must be live or simulation.');
   for(const [label,value] of [['Issue date',issueDate],['Due date',dueDate]])if(value&&!dateValid(value))issues.push(label+' must be a valid YYYY-MM-DD date.');
   if(issueDate&&dueDate&&dateValid(issueDate)&&dateValid(dueDate)&&dueDate<issueDate)issues.push('Due date cannot be before the invoice issue date.');
   if(currencies.includes(currencyText)){
    try{
     const currency=currencyText as Currency,[total,paid,credited,due,overpaid]=[totalText,paidText,creditedText,dueText,overpaidText].map(value=>minor(value,currency));
     const effectiveTotal=legacy?total:minor(effectiveTotalText,currency);
     let pricingMethod='',agreementId='',methodDiscount=0,methodPremium=0,methodTaxAdjustment=0,originalTax=0,effectiveTax=0;
     if(!legacy){
      originalTax=minor(originalTaxText,currency);effectiveTax=minor(effectiveTaxText,currency);
      methodDiscount=minor(methodDiscountText,currency);methodPremium=minor(methodPremiumText,currency);
      methodTaxAdjustment=signedMinor(methodTaxAdjustmentText,currency);
      pricingMethod=methodText.trim();agreementId=agreementText.trim();
      if(pricingMethod&&!canonicalMethods.has(pricingMethod))issues.push('Pricing method must be a canonical payment method id.');
      if(pricingMethod&&!agreementId)issues.push('Priced records must reference an agreement id.');
      if(!pricingMethod&&agreementId)issues.push('Agreement records must name a pricing method.');
      if(agreementId&&!agreementIdPattern.test(agreementId))issues.push('Agreement must be a UUID.');
      if(effectiveTax!==originalTax+methodTaxAdjustment)issues.push('Effective tax must equal the original tax plus the method tax adjustment.');
      if(!pricingMethod&&(effectiveTotal!==total||effectiveTax!==originalTax||methodDiscount!==0||methodPremium!==0||methodTaxAdjustment!==0))issues.push('Unpriced records cannot carry method pricing adjustments.');
     }
     const remaining=BigInt(effectiveTotal)-BigInt(paid)-BigInt(credited),expectedDue=remaining>0n?remaining:0n,expectedOverpaid=remaining<0n?-remaining:0n;
     if(total<=0)issues.push('Original invoice total must be positive.');
     if(effectiveTotal<=0)issues.push('Effective invoice total must be positive.');
     if(credited>effectiveTotal)issues.push('Credit balance exceeds the effective invoice total.');
     if(BigInt(due)!==(stateText==='void'?0n:expectedDue)||BigInt(overpaid)!==expectedOverpaid)issues.push('Invoice balance equation does not match the effective total, Paid and Credited.');
     const expectedState=paid>=effectiveTotal?'paid':due===0&&credited>0?'credited':paid>0?'partially_paid':'unpaid';
     if((stateText==='void'&&(paid!==0||modeText==='simulation'))||(stateText!=='void'&&stateText!==expectedState))issues.push('Invoice state does not match its amounts and mode.');
     if(!issues.length)record={invoiceNumber:number,customerName,title,balance:{total,effectiveTotal,paid,credited,due,overpaid,currency,state:stateText as InvoiceBalance['state'],mode:modeText as InvoiceBalance['mode']},...(pricingMethod?{pricingMethod,methodDiscount,methodPremium,methodTaxAdjustment,agreementId}:{}),...(issueDate?{issueDate}:{}),...(dueDate?{dueDate}:{})};
    }catch(error){issues.push((error as Error).message);}
   }
  }
  const invalid=issues.length>0,duplicate=(occurrences.get(invoiceNumber)??0)>1;
  if(duplicate)issues.push('Duplicate invoice number within this CSV.');
  const classification:CsvPreviewClassification=invalid?'invalid':duplicate?'duplicate':existingNumbers.has(invoiceNumber)?'existing':'new';
  preview.rows.push({row:index+2,invoiceNumber,classification,issues,...(record?{record}:{})});preview.counts[classification]++;
 }
 return preview;
}
