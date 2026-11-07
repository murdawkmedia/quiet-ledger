import type {Currency,Invoice} from './contracts.js';

/** Invoice-denominated allocations, never an asset wallet balance or an FX quote. */
export interface CurrencyBalanceSummary {
 currency:Currency;mode:'live'|'simulation';invoiceCount:number;
 /** Original issued totals. */
 issued:number;
 /** Sum of each balance's authoritative effectiveTotal. */
 effective:number;paid:number;credited:number;voided:number;due:number;overpaid:number;
 /** Agreement method-only adjustments; zero without an agreement. */
 methodDiscount:number;methodPremium:number;
 /** Signed sum of effectiveTax - issuedTax across agreements. */
 methodTaxAdjustment:number;
}
export const CAD_REFERENCE_VALUATION={
 invoicedCad:'reference_only',receivedCad:'saved_quote_or_simulation',
 availableCad:'simulation_only',spentCad:'simulation_only',
 satInvoices:'excluded_no_fiat_conversion',
} as const;
const currencies:Currency[]=['CAD','USD','EUR','GBP','KRW','SAT'];
const fields=['issued','effective','paid','credited','voided','due','overpaid','methodDiscount','methodPremium'] as const;
function amount(value:number){if(!Number.isSafeInteger(value)||value<0)throw new Error('Invoice report amount exceeds supported precision.');return value;}
/** Signed adjustment values are validated separately from nonnegative financial columns. */
function signedAmount(value:number){if(!Number.isSafeInteger(value))throw new Error('Invoice report adjustment exceeds supported precision.');return value;}

export function summarizeInvoiceBalances(invoices:ReadonlyArray<Pick<Invoice,'currency'|'total'|'balance'|'priceAgreement'>>):CurrencyBalanceSummary[]{
 const rows=new Map<string,CurrencyBalanceSummary>();
 for(const invoice of invoices){
  const b=invoice.balance;
  if(!b||b.currency!==invoice.currency||b.total!==invoice.total||!currencies.includes(b.currency)||!['live','simulation'].includes(b.mode))throw new Error('Authoritative invoice balance required for reporting.');
  for(const field of ['total','effectiveTotal','paid','credited','due','overpaid'] as const)amount(b[field]);
  const agreement=invoice.priceAgreement;
  if(agreement&&(agreement.effectiveTotal!==b.effectiveTotal||agreement.issuedTotal!==b.total))throw new Error('Authoritative invoice balance required for reporting.');
  const key=b.currency+':'+b.mode;
  let row=rows.get(key);if(!row){row={currency:b.currency,mode:b.mode,invoiceCount:0,issued:0,effective:0,paid:0,credited:0,voided:0,due:0,overpaid:0,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0};rows.set(key,row);}
  const remaining=BigInt(b.effectiveTotal)-BigInt(b.paid)-BigInt(b.credited);
  const values={issued:b.total,effective:b.effectiveTotal,paid:b.paid,credited:b.credited,voided:b.state==='void'&&remaining>0n?Number(remaining):0,due:b.due,overpaid:b.overpaid,
    methodDiscount:agreement?.discountAmount??0,methodPremium:agreement?.premiumAmount??0};
  row.invoiceCount=amount(row.invoiceCount+1);
  for(const field of fields)row[field]=amount(row[field]+values[field]);
  row.methodTaxAdjustment=signedAmount(row.methodTaxAdjustment+(agreement?.taxAdjustment??0));
 }
 return [...rows.values()].sort((a,b)=>currencies.indexOf(a.currency)-currencies.indexOf(b.currency)||(a.mode===b.mode?0:a.mode==='live'?-1:1));
}
