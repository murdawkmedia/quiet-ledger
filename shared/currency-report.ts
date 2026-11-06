import type {Currency,Invoice} from './contracts.js';

/** Invoice-denominated allocations, never an asset wallet balance or an FX quote. */
export interface CurrencyBalanceSummary {
 currency:Currency;mode:'live'|'simulation';invoiceCount:number;
 issued:number;paid:number;credited:number;voided:number;due:number;overpaid:number;
}
export const CAD_REFERENCE_VALUATION={
 invoicedCad:'reference_only',receivedCad:'saved_quote_or_simulation',
 availableCad:'simulation_only',spentCad:'simulation_only',
} as const;
const currencies:Currency[]=['CAD','USD','EUR','GBP','KRW'];
const fields=['issued','paid','credited','voided','due','overpaid'] as const;
function amount(value:number){if(!Number.isSafeInteger(value)||value<0)throw new Error('Invoice report amount exceeds supported precision.');return value;}

export function summarizeInvoiceBalances(invoices:ReadonlyArray<Pick<Invoice,'currency'|'total'|'balance'>>):CurrencyBalanceSummary[]{
 const rows=new Map<string,CurrencyBalanceSummary>();
 for(const invoice of invoices){
  const b=invoice.balance;
  if(!b||b.currency!==invoice.currency||b.total!==invoice.total||!currencies.includes(b.currency)||!['live','simulation'].includes(b.mode))throw new Error('Authoritative invoice balance required for reporting.');
  for(const field of ['total','paid','credited','due','overpaid'] as const)amount(b[field]);
  const key=b.currency+':'+b.mode;
  let row=rows.get(key);if(!row){row={currency:b.currency,mode:b.mode,invoiceCount:0,issued:0,paid:0,credited:0,voided:0,due:0,overpaid:0};rows.set(key,row);}
  const remaining=BigInt(b.total)-BigInt(b.paid)-BigInt(b.credited);
  const values={issued:b.total,paid:b.paid,credited:b.credited,voided:b.state==='void'&&remaining>0n?Number(remaining):0,due:b.due,overpaid:b.overpaid};
  row.invoiceCount=amount(row.invoiceCount+1);
  for(const field of fields)row[field]=amount(row[field]+values[field]);
 }
 return [...rows.values()].sort((a,b)=>currencies.indexOf(a.currency)-currencies.indexOf(b.currency)||(a.mode===b.mode?0:a.mode==='live'?-1:1));
}
