import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Invoice, Payout, PublicInvoice, Receipt, PaymentMethod } from '../shared/contracts.js';
import { DomainError, Store } from './store.js';
import {InvoiceLedger} from './invoice-ledger.js';
import {paymentDueDate} from '../shared/payment-terms.js';
import {calculateInvoiceAmounts,invoiceAllowsMethod} from '../shared/invoice-options.js';
import {PAYMENT_METHOD_IDS} from '../shared/payment-methods.js';
import {canFundPayout,isCryptoMethod,methodInfo} from '../shared/payment-methods.js';

export const DEMO_CAD_PER_BTC = 100000;
export const DEMO_USD_TO_CAD = 1.4;
const maxAmount = 1_000_000_000;
export const token = () => randomBytes(32).toString('base64url');
const amountSchema = z.number().int().min(1).max(maxAmount);
const calendarDate=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const d=new Date(value+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===value;},'Enter a valid calendar date.');
const billingAddress=z.string().trim().max(1000).transform(value=>value||undefined).optional();
const billingEmail=z.string().max(254)
  .refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a single email address without control characters.')
  .transform(value=>value.trim()).pipe(z.union([z.email(),z.literal('')]))
  .transform(value=>value||undefined).optional();
const invoiceBillingSchema=z.object({
  sellerName:z.string().trim().min(1).max(120),
  sellerEmail:billingEmail,
  sellerAddress:billingAddress,
  sellerTaxId:z.string().max(80)
    .refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a tax identifier without control characters.')
    .transform(value=>value.trim()||undefined).optional(),
  customerAddress:billingAddress,
}).strict().transform(value=>({
  sellerName:value.sellerName,
  ...(value.sellerEmail?{sellerEmail:value.sellerEmail}:{}),
  ...(value.sellerAddress?{sellerAddress:value.sellerAddress}:{}),
  ...(value.sellerTaxId?{sellerTaxId:value.sellerTaxId}:{}),
  ...(value.customerAddress?{customerAddress:value.customerAddress}:{}),
}));
export const invoiceSchema = z.object({
  customerName: z.string().trim().min(1).max(120),
  customerEmail: z.string().trim().email().max(254).optional().or(z.literal('')),
  title: z.string().trim().min(1).max(160),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;},'Enter a valid due date.').optional(),
  issueDate:calendarDate.optional(),
  paymentTermDays:z.number().int().min(0).max(3650).optional(),
  paymentTerms:z.string().trim().max(2000).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value),'Use plain payment terms without control characters.').optional(),
  discountBps:z.number().int().min(0).max(10000).optional(),
  premiumBps:z.number().int().min(0).max(10000).optional(),
  acceptedMethods:z.array(z.enum(PAYMENT_METHOD_IDS)).min(1).max(PAYMENT_METHOD_IDS.length).refine(value=>new Set(value).size===value.length,'Select each accepted method only once.').optional(),
  currency: z.enum(['CAD', 'USD', 'EUR', 'GBP','KRW']),
  items: z.array(z.object({ description: z.string().trim().min(1).max(240), quantity: z.number().int().min(1).max(10000), unitAmount: z.number().int().min(0).max(maxAmount) }).strict()).min(1).max(40),
  taxBps: z.number().int().min(0).max(10000).optional(),
  note: z.string().trim().max(2000).optional(),
  billing:invoiceBillingSchema.optional(),
}).strict().refine(value=>!value.issueDate||!value.dueDate||value.dueDate>=value.issueDate,'Due date must not precede the issue date.').superRefine((value,context)=>{if(value.paymentTermDays!==undefined&&value.issueDate){try{const due=paymentDueDate(value.issueDate,value.paymentTermDays);if(value.dueDate&&value.dueDate!==due)context.addIssue({code:'custom',message:'Due date does not match the selected payment terms.'});}catch(error){context.addIssue({code:'custom',message:(error as Error).message});}}});

export function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError(400, result.error.issues[0]?.message ?? 'Invalid request.');
  return result.data;
}

export function createInvoice(store: Store, workspace: string, body: unknown, now: Date): Invoice {
  const input = parse(invoiceSchema, body);
  if(input.paymentTermDays!==undefined){
    const issue=input.issueDate??now.toISOString().slice(0,10);let due:string;
    try{due=paymentDueDate(issue,input.paymentTermDays);}catch(error){throw new DomainError(400,(error as Error).message);}
    if(input.dueDate&&input.dueDate!==due)throw new DomainError(400,'Due date does not match the selected payment terms.');
    input.issueDate=issue;input.dueDate=due;
  }
  const taxBps=input.taxBps??0;
  const calculated=calculateInvoiceAmounts(input.items,taxBps,input.discountBps??0,input.premiumBps??0);
  const subtotalBig=BigInt(calculated.subtotal),taxBig=BigInt(calculated.tax),totalBig=BigInt(calculated.total);
  const demoRates={CAD:100n,USD:140n,EUR:150n,GBP:180n,KRW:0n};
  // KRW fixed simulation reference:1000 won per CAD; this is not a live FX quote.
  const totalCadBig=input.currency==='KRW'?(totalBig+5n)/10n:(totalBig*demoRates[input.currency]+50n)/100n;
  if (totalBig < 1n || totalBig > BigInt(maxAmount) || totalCadBig < 1n || totalCadBig > BigInt(maxAmount)) throw new DomainError(400, 'Invoice total is outside the supported demonstration range.');
  const invoice: Invoice = {
    ...input, customerEmail: input.customerEmail || undefined, id: randomUUID(), token: token(),
    number: `QL-${String(store.listInvoices(workspace).length + 1).padStart(4, '0')}`,
    taxBps,...(input.discountBps!==undefined?{discountAmount:calculated.discountAmount}:{}),...(input.premiumBps!==undefined?{premiumAmount:calculated.premiumAmount}:{}), subtotal: Number(subtotalBig), tax: Number(taxBig), total: Number(totalBig),
    totalCad: Number(totalCadBig), amountSats: Number(totalCadBig) * 10,
    status: 'open', createdAt: now.toISOString(),
  };
  store.addInvoice(workspace, invoice);
  store.audit(workspace, 'invoice.created', `${invoice.number} issued for ${invoice.customerName}.`, now.toISOString());
  return invoice;
}

export function publicInvoice(invoice: Invoice): PublicInvoice {
  const { number, title, customerName, currency, items, taxBps, subtotal, tax, total, amountSats, status, createdAt, issueDate, dueDate, discountBps,premiumBps,discountAmount,premiumAmount,acceptedMethods, paidAt, note, billing, paymentMethod,settlementMode,nativePayment,balance,paymentTermDays,paymentTerms } = invoice;
  return { number, title, customerName, currency, items, taxBps, subtotal, tax, total, amountSats, status, createdAt, issueDate, dueDate, discountBps,premiumBps,discountAmount,premiumAmount,acceptedMethods, paidAt, note, ...(billing?{billing:{...billing}}:{}), paymentMethod,settlementMode,nativePayment,...(paymentTermDays!==undefined?{paymentTermDays}:{}),...(paymentTerms?{paymentTerms}:{}),...(balance?{balance}:{}) };
}

export function settleInvoice(store: Store, workspace: string, invoice: Invoice, method: PaymentMethod, now: Date) {
  if(!invoiceAllowsMethod(invoice,method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
  if (invoice.status === 'paid') return { invoice: publicInvoice(invoice), receiptToken: invoice.receiptToken!, alreadyPaid: true };
  const ledger=new InvoiceLedger(store),balance=ledger.balance(invoice,workspace);
  const liveRequest=store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='receiving_requests'").get()&&store.db.prepare('SELECT id,data FROM receiving_requests WHERE invoice_id=? AND workspace=?').all(invoice.id,workspace).some(row=>store.decode<any>(row.data,'receiving_requests',String(row.id),workspace).mode==='live');
  if(balance.due!==invoice.total||balance.state==='void'||liveRequest)throw new DomainError(409,'An adjusted or live receiving invoice cannot be settled by a simulated payment.');
  const receiptToken = token();
  const receipt: Receipt = { number: `R-${invoice.number}`, issuedAt: now.toISOString(), mode: 'simulation', method, amount: invoice.total, currency: invoice.currency, invoiceNumber: invoice.number, title: invoice.title, customerName: invoice.customerName, ...(method === 'cashu' ? { amountSats: invoice.amountSats } : {}) };
  const paid: Invoice = { ...invoice, status: 'paid', paymentMethod: method, paidAt: now.toISOString(), receiptToken };
  store.addReceipt(receiptToken, invoice.id, receipt);
  store.saveInvoice(paid);
  store.audit(workspace, 'payment.received', `${invoice.number} settled with simulated ${methodInfo(method).label}.`, now.toISOString());
  return { invoice: publicInvoice(paid), receiptToken, alreadyPaid: false };
}

const payoutSchema = z.object({ invoiceId: z.string().min(1).max(100), provider: z.enum(['bullbitcoin', 'bitcoinwell', 'wise']), destinationType: z.enum(['bank', 'bill']), recipientLabel: z.string().trim().min(1).max(120), amount: amountSchema }).strict();
export function availableForInvoice(store: Store, workspace: string, invoice: Invoice): number {
  return invoice.status === 'paid' && invoice.settlementMode!=='live' && canFundPayout(invoice.paymentMethod) ? invoice.totalCad - store.listPayouts(workspace).filter(p => p.invoiceId === invoice.id && p.status !== 'quoted').reduce((sum, payout) => sum + payout.totalDebit, 0) : 0;
}

export function createQuote(store: Store, workspace: string, body: unknown, now: Date): Payout {
  const input = parse(payoutSchema, body);
  const invoice = store.getInvoice(input.invoiceId, workspace);
  if (!invoice) throw new DomainError(404, 'Invoice not found.');
  if (invoice.status !== 'paid') throw new DomainError(409, 'Receive the invoice payment before preparing a payout.');
  if(invoice.settlementMode==='live'||!canFundPayout(invoice.paymentMethod))throw new DomainError(409,'This payment cannot fund a simulated payout. Live receipts, stablecoins and noncash settlements require their own supported route.');
  if (input.provider === 'wise' && isCryptoMethod(invoice.paymentMethod!)) throw new DomainError(400, 'Wise is available here only for ordinary fiat-funded business payouts, not crypto-origin funds.');
  if (input.provider === 'wise' && input.destinationType === 'bill') throw new DomainError(400, 'The Wise adapter is for bank payouts, not Canadian bill payment.');
  if (input.provider !== 'wise' && methodInfo(invoice.paymentMethod!).settlement!=='bitcoin') throw new DomainError(400, 'This bitcoin conversion provider requires a bitcoin-funded invoice. Choose Wise for this simulated fiat source.');
  const fee = 50 + Math.ceil(input.amount / 200);
  const totalDebit = input.amount + fee;
  if (!Number.isSafeInteger(totalDebit) || totalDebit > availableForInvoice(store, workspace, invoice)) throw new DomainError(409, 'Amount plus fees exceeds the invoice’s available balance.');
  const payout: Payout = { ...input, id: randomUUID(), invoiceNumber: invoice.number, fee, totalDebit, netAmount: input.amount, exchangeRate: DEMO_CAD_PER_BTC, expiresAt: new Date(now.getTime() + 5 * 60 * 1000).toISOString(), createdAt: now.toISOString(), status: 'quoted', mode: 'simulation' };
  store.addPayout(workspace, payout);
  store.audit(workspace, 'payout.quoted', `Simulated ${input.destinationType === 'bill' ? 'bill payment' : 'bank payout'} quote prepared for ${invoice.number}.`, now.toISOString());
  return payout;
}

export function approvePayout(store: Store, workspace: string, payoutId: string, now: Date): Payout {
  const payout = store.getPayout(payoutId, workspace);
  if (!payout) throw new DomainError(404, 'Payout not found.');
  if (payout.status !== 'quoted') return payout;
  if (Date.parse(payout.expiresAt) <= now.getTime()) throw new DomainError(409, 'The quote has expired. Prepare a new quote.');
  const invoice = store.getInvoice(payout.invoiceId, workspace)!;
  if (payout.totalDebit > availableForInvoice(store, workspace, invoice)) throw new DomainError(409, 'Available funds changed. This payout would exceed the invoice balance.');
  const result: Payout = { ...payout, status: 'funding_pending', providerReference: `DEMO-${randomUUID().slice(0, 8).toUpperCase()}` };
  store.savePayout(result);
  store.audit(workspace, 'payout.authorized', `Simulated payout authorized for ${invoice.number}; funds reserved once.`, now.toISOString());
  return result;
}

export function advancePayout(store: Store, workspace: string, payoutId: string, now: Date): Payout {
  const payout = store.getPayout(payoutId, workspace);
  if (!payout) throw new DomainError(404, 'Payout not found.');
  if (payout.status === 'quoted') throw new DomainError(409, 'Review and authorize the payout first.');
  const next = { funding_pending: 'provider_processing', provider_processing: 'provider_reported_paid', provider_reported_paid: 'received', received: 'received' } as const;
  const result: Payout = { ...payout, status: next[payout.status] };
  store.savePayout(result);
  if (result.status !== payout.status) store.audit(workspace, `payout.${result.status}`, result.status === 'received' ? `Recipient credit confirmed in simulation for ${payout.invoiceNumber}.` : `Simulated payout for ${payout.invoiceNumber}: ${result.status.replaceAll('_', ' ')}.`, now.toISOString());
  return result;
}

export function seedDemo(store: Store, now: Date) {
  if (store.isDemoSeeded()) return;
  store.transaction(() => {
    const samples = [
      { customerName: 'Juniper Workshop', title: 'Brand direction', currency: 'CAD', items: [{ description: 'Brand strategy and design', quantity: 1, unitAmount: 95000 }], taxBps: 500 },
      { customerName: 'Cedar & Co.', title: 'Website launch', currency: 'CAD', items: [{ description: 'Website implementation', quantity: 1, unitAmount: 120000 }], taxBps: 0 },
      { customerName: 'Northline Studio', title: 'Post-production', currency: 'USD', items: [{ description: 'Editing and colour', quantity: 1, unitAmount: 68000 }], taxBps: 0 },
      { customerName: 'Morrow Practice', title: 'Project storyboard', currency: 'CAD', items: [{ description: 'Storyboard development', quantity: 1, unitAmount: 42000 }], taxBps: 500 },
    ];
    samples.forEach((sample, i) => {
      const date = new Date(now.getTime() - (4 - i) * 86400000);
      const invoice = createInvoice(store, 'demo', sample, date);
      if (i < 2) settleInvoice(store, 'demo', invoice, i === 0 ? 'square' : 'cashu', date);
    });
    store.markDemoSeeded();
  });
}
