import {Router,type Response} from 'express';
import {z} from 'zod';
import type {Invoice} from '../shared/contracts.js';
import {summarizeInvoiceBalances} from '../shared/currency-report.js';
import {previewInvoiceCsv,type InvoiceStatementPreview,type StatementEntry,type StatementInvoice} from '../shared/csv-preview.js';
import type {InvoiceLedgerEntry} from '../shared/invoice-ledger.js';
import {parse} from './domain.js';
import type {InvoiceLedger} from './invoice-ledger.js';
import {DomainError,type Store,type StoredSession} from './store.js';

function ownerWorkspace(res:Response){
 const session=res.locals.session as StoredSession|undefined;
 if(!session)throw new DomainError(401,'Sign in to continue.');
 if(res.locals.apiAccess||session.role!=='owner'||session.hackathonDemo)throw new DomainError(403,'Use your private owner browser workspace for business record previews.');
 return session.workspace;
}
function snapshot(invoice:Invoice):StatementInvoice{
 const {id,number,title,customerName,currency,taxBps,subtotal,tax,total,status,createdAt,issueDate,dueDate,paidAt,paymentTermDays,paymentTerms,discountBps,premiumBps,discountAmount,premiumAmount}=invoice;
 return {id,number,title,customerName,currency,items:invoice.items.map(({description,quantity,unitAmount})=>({description,quantity,unitAmount})),taxBps,subtotal,tax,total,status,createdAt,issueDate,dueDate,paidAt,paymentTermDays,paymentTerms,discountBps,premiumBps,discountAmount,premiumAmount};
}
function safeEntry(entry:InvoiceLedgerEntry):StatementEntry{
 const {id,kind,amount,currency,createdAt,reason,method,verification,receiptNumber}=entry;return {id,kind,amount,currency,createdAt,reason,method,verification,receiptNumber};
}
/** Mount at /api/business-records after the application's session, origin and CSRF checks. Reads only. */
export function businessRecordsRouter(store:Store,ledger:InvoiceLedger){
 const router=Router(),selection=z.object({invoiceIds:z.array(z.string().uuid()).min(1).max(200).refine(ids=>new Set(ids).size===ids.length,'Choose each invoice once.')}).strict();
 router.post('/statement',(req,res)=>{
  const workspace=ownerWorkspace(res),{invoiceIds}=parse(selection,req.body);
  // Resolve the full selection before returning anything; customer labels are not identities.
  const views=invoiceIds.map(id=>ledger.read(workspace,id));
  const result:InvoiceStatementPreview={invoices:views.map(view=>({invoice:snapshot(view.invoice),balance:view.balance,entries:view.entries.map(safeEntry)})),summary:summarizeInvoiceBalances(views.map(view=>view.invoice))};
  res.setHeader('Cache-Control','no-store');res.json(result);
 });
 router.post('/csv-preview',(req,res)=>{
  const workspace=ownerWorkspace(res),{csv}=parse(z.object({csv:z.string().max(16*1024)}).strict(),req.body),existing=store.listInvoices(workspace);
  let result;try{result=previewInvoiceCsv(csv,existing);}catch(error){throw new DomainError(400,(error as Error).message);}
  res.setHeader('Cache-Control','no-store');res.json(result);
 });
 return router;
}
