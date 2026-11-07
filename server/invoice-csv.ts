import type {InvoiceLedgerView} from '../shared/invoice-ledger.js';
import {METHOD_DEFINITIONS} from '../shared/payment-methods.js';

const currencies=new Set(['CAD','USD','EUR','GBP','KRW','SAT']);
const states=new Set(['unpaid','partially_paid','paid','credited','void']);
const methods=new Set(METHOD_DEFINITIONS.map(row=>row.id));
function cell(value:string){
  // Spreadsheet applications may evaluate cells after ignoring leading spaces.
  const safe=/^[\s]*[=+@-]|^[\t\r\n]/.test(value)?"'"+value:value;
  return '"'+safe.replaceAll('"','""')+'"';
}
function amount(value:number,currency:string){
  if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid invoice export amount.');
  const n=BigInt(value);return currency==='KRW'||currency==='SAT'?String(n):`${n/100n}.${String(n%100n).padStart(2,'0')}`;
}
/** Signed adjustment column: an ordinary numeric amount, never a formula. */
function signedAmount(value:number,currency:string){
  if(!Number.isSafeInteger(value))throw new Error('Invalid invoice export adjustment.');
  const n=BigInt(value),sign=n<0n?'-':'',magnitude=n<0n?-n:n;
  return sign+(currency==='KRW'||currency==='SAT'?String(magnitude):`${magnitude/100n}.${String(magnitude%100n).padStart(2,'0')}`);
}
/** The adjustment cell is quoted but keeps its leading minus: it is an internally numeric field, not spreadsheet text. */
function signedCell(value:number,currency:string){return '"'+signedAmount(value,currency)+'"';}
/** Currency-denominated invoice balances; no inferred FX valuation or wallet secrets. */
export function invoiceBalanceCsv(views:InvoiceLedgerView[]):string{
  const lines=[['Invoice','Customer','Title','Currency','Total','Effective total','Pricing method','Original tax','Effective tax','Method discount','Method premium','Method tax adjustment','Paid','Credited','Due','Overpaid','State','Mode','Issue date','Due date','Agreement'].map(cell).join(',')];
  for(const {invoice,balance} of views){
    if(!currencies.has(balance.currency)||balance.currency!==invoice.currency||!states.has(balance.state)||!['live','simulation'].includes(balance.mode))throw new Error('Invalid invoice export record.');
    const agreement=invoice.priceAgreement;
    const effectiveTax=agreement?.effectiveTax??invoice.tax;
    const methodDiscount=agreement?.discountAmount??0,methodPremium=agreement?.premiumAmount??0,taxAdjustment=agreement?.taxAdjustment??0;
    if(agreement&&(!methods.has(agreement.method)||effectiveTax!==invoice.tax+taxAdjustment))throw new Error('Invalid invoice export agreement.');
    const values=[balance.total,balance.effectiveTotal,balance.paid,balance.credited,balance.due,balance.overpaid];
    const formatted=values.map(value=>amount(value,balance.currency));
    const remaining=BigInt(balance.effectiveTotal)-BigInt(balance.paid)-BigInt(balance.credited);
    const due=remaining>0n?remaining:0n,overpaid=remaining<0n?-remaining:0n;
    if((balance.state==='void'?balance.due!==0:BigInt(balance.due)!==due)||BigInt(balance.overpaid)!==overpaid)throw new Error('Inconsistent invoice export balances.');
    lines.push([invoice.number,invoice.customerName,invoice.title,balance.currency,
      amount(balance.total,balance.currency),amount(balance.effectiveTotal,balance.currency),agreement?.method??'',
      amount(invoice.tax,balance.currency),amount(effectiveTax,balance.currency),amount(methodDiscount,balance.currency),amount(methodPremium,balance.currency),signedAmount(taxAdjustment,balance.currency),
      amount(balance.paid,balance.currency),amount(balance.credited,balance.currency),amount(balance.due,balance.currency),amount(balance.overpaid,balance.currency),
      balance.state,balance.mode,invoice.issueDate??'',invoice.dueDate??'',agreement?.id??''].map((value,index)=>index===11?signedCell(taxAdjustment,balance.currency):cell(value)).join(','));
  }
  return lines.join('\r\n')+'\r\n';
}
