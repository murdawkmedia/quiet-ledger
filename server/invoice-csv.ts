import type {InvoiceLedgerView} from '../shared/invoice-ledger.js';

const currencies=new Set(['CAD','USD','EUR','GBP','KRW']);
const states=new Set(['unpaid','partially_paid','paid','credited','void']);
function cell(value:string){
  // Spreadsheet applications may evaluate cells after ignoring leading spaces.
  const safe=/^[\s]*[=+@-]|^[\t\r\n]/.test(value)?"'"+value:value;
  return '"'+safe.replaceAll('"','""')+'"';
}
function amount(value:number,currency:string){
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid invoice export amount.');
  const n=BigInt(value);return currency==='KRW'?String(n):`${n/100n}.${String(n%100n).padStart(2,'0')}`;
}
/** Currency-denominated invoice balances; no inferred FX valuation or wallet secrets. */
export function invoiceBalanceCsv(views:InvoiceLedgerView[]):string{
  const lines=[['Invoice','Customer','Title','Currency','Total','Paid','Credited','Due','Overpaid','State','Mode','Issue date','Due date'].map(cell).join(',')];
  for(const {invoice,balance} of views){
    if(!currencies.has(balance.currency)||balance.currency!==invoice.currency||!states.has(balance.state)||!['live','simulation'].includes(balance.mode))throw new Error('Invalid invoice export record.');
    const values=[balance.total,balance.paid,balance.credited,balance.due,balance.overpaid];
    const formatted=values.map(value=>amount(value,balance.currency));
    const remaining=BigInt(balance.total)-BigInt(balance.paid)-BigInt(balance.credited);
    const due=remaining>0n?remaining:0n,overpaid=remaining<0n?-remaining:0n;
    if((balance.state==='void'?balance.due!==0:BigInt(balance.due)!==due)||BigInt(balance.overpaid)!==overpaid)throw new Error('Inconsistent invoice export balances.');
    lines.push([invoice.number,invoice.customerName,invoice.title,balance.currency,...formatted,balance.state,balance.mode,invoice.issueDate??'',invoice.dueDate??''].map(cell).join(','));
  }
  return lines.join('\r\n')+'\r\n';
}
