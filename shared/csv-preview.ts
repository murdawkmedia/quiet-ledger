import type {Currency,Invoice} from './contracts.js';
import type {CurrencyBalanceSummary} from './currency-report.js';
import type {InvoiceBalance,InvoiceLedgerEntry} from './invoice-ledger.js';

export const CSV_PREVIEW_HEADERS=['Invoice','Customer','Title','Currency','Total','Paid','Credited','Due','Overpaid','State','Mode','Issue date','Due date'] as const;
export const CSV_PREVIEW_NOTICE='Preview only; no records imported' as const;
export const CSV_PREVIEW_MAX_BYTES=16*1024;
export interface CsvBalanceRecord {invoiceNumber:string;customerName:string;title:string;balance:InvoiceBalance;issueDate?:string;dueDate?:string}
export type CsvPreviewClassification='existing'|'duplicate'|'new'|'invalid';
export interface CsvPreviewRow {row:number;invoiceNumber:string;classification:CsvPreviewClassification;issues:string[];record?:CsvBalanceRecord}
export interface CsvPreview {rows:CsvPreviewRow[];counts:Record<CsvPreviewClassification,number>;notice:typeof CSV_PREVIEW_NOTICE}
/** Deliberate allowlists: statements have no public capabilities, payment identifiers or private notes. */
export type StatementInvoice=Pick<Invoice,'id'|'number'|'title'|'customerName'|'currency'|'items'|'taxBps'|'subtotal'|'tax'|'total'|'status'|'createdAt'|'issueDate'|'dueDate'|'paidAt'|'paymentTermDays'|'paymentTerms'|'discountBps'|'premiumBps'|'discountAmount'|'premiumAmount'>;
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
 if(!(currency==='KRW'?/^\d+$/:/^\d+(?:\.\d{1,2})?$/).test(value))throw new Error(currency==='KRW'?'Use nonnegative whole won amounts for KRW.':'Use nonnegative amounts with at most two decimal places.');
 const [whole,fraction='']=value.split('.'),amount=currency==='KRW'?BigInt(whole):BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));
 if(amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Amount exceeds the supported integer precision.');return Number(amount);
}

/** No receipts, invoice issuance, formulas, URL resolution, storage or network effects. */
export function previewInvoiceCsv(csv:string,existing:ReadonlyArray<Pick<Invoice,'number'>>=[]):CsvPreview{
 const rows=records(csv),header=rows.shift();
 if(!header||header.length!==CSV_PREVIEW_HEADERS.length||header.some((value,index)=>value!==CSV_PREVIEW_HEADERS[index]))throw new Error('Use the invoice balance CSV header: '+CSV_PREVIEW_HEADERS.join(', ')+'.');
 const occurrences=new Map<string,number>(),existingNumbers=new Set(existing.map(invoice=>invoice.number));
 for(const row of rows)if(row[0])occurrences.set(row[0],(occurrences.get(row[0])??0)+1);
 const preview:CsvPreview={rows:[],counts:{existing:0,duplicate:0,new:0,invalid:0},notice:CSV_PREVIEW_NOTICE};
 for(const [index,cells] of rows.entries()){
  const issues:string[]=[],invoiceNumber=cells[0]??'';let record:CsvBalanceRecord|undefined;
  if(cells.length!==CSV_PREVIEW_HEADERS.length)issues.push('Record has a different number of columns from the header.');
  else{
   const [number,customerName,title,currencyText,totalText,paidText,creditedText,dueText,overpaidText,stateText,modeText,issueDate,dueDate]=cells;
   if(!number.trim()||!customerName.trim()||!title.trim())issues.push('Invoice, Customer and Title are required.');
   const currencies:readonly string[]=['CAD','USD','EUR','GBP','KRW'],states:readonly string[]=['unpaid','partially_paid','paid','credited','void'];
   if(!currencies.includes(currencyText))issues.push('Currency must be CAD, USD, EUR, GBP or KRW.');
   if(!states.includes(stateText))issues.push('Unknown invoice state.');
   if(!['live','simulation'].includes(modeText))issues.push('Mode must be live or simulation.');
   for(const [label,value] of [['Issue date',issueDate],['Due date',dueDate]])if(value&&!dateValid(value))issues.push(label+' must be a valid YYYY-MM-DD date.');
   if(issueDate&&dueDate&&dateValid(issueDate)&&dateValid(dueDate)&&dueDate<issueDate)issues.push('Due date cannot be before the invoice issue date.');
   if(currencies.includes(currencyText)){
    try{
     const currency=currencyText as Currency,[total,paid,credited,due,overpaid]=[totalText,paidText,creditedText,dueText,overpaidText].map(value=>minor(value,currency));
     const remaining=BigInt(total)-BigInt(paid)-BigInt(credited),expectedDue=remaining>0n?remaining:0n,expectedOverpaid=remaining<0n?-remaining:0n;
     if(total<=0)issues.push('Original invoice total must be positive.');
     if(credited>total)issues.push('Credit balance exceeds the original invoice total.');
     if(BigInt(due)!==(stateText==='void'?0n:expectedDue)||BigInt(overpaid)!==expectedOverpaid)issues.push('Invoice balance equation does not match Total, Paid and Credited.');
     const expectedState=paid>=total?'paid':due===0&&credited>0?'credited':paid>0?'partially_paid':'unpaid';
     if((stateText==='void'&&(paid!==0||modeText==='simulation'))||(stateText!=='void'&&stateText!==expectedState))issues.push('Invoice state does not match its amounts and mode.');
     if(!issues.length)record={invoiceNumber:number,customerName,title,balance:{total,paid,credited,due,overpaid,currency,state:stateText as InvoiceBalance['state'],mode:modeText as InvoiceBalance['mode']},...(issueDate?{issueDate}:{}),...(dueDate?{dueDate}:{})};
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
