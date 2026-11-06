import {Router} from 'express';
import {z} from 'zod';
import {InvoiceLedger} from './invoice-ledger.js';
import {invoiceBalanceCsv} from './invoice-csv.js';
import {DomainError,Store,type StoredSession} from './store.js';
import {parse} from './domain.js';

export function invoiceLedgerRouter(store:Store,ledger:InvoiceLedger,now:()=>Date){
 const router=Router();
 router.use((req,res,next)=>{
  if(!(/^\/invoices\/[^/]+\/(?:ledger|credits|void)$/.test(req.path)||req.path==='/invoice-ledger/export.csv'))return next('router');
  if((res.locals.session as StoredSession).role!=='owner')return next(new DomainError(403,'Invoice financial records require a private owner workspace.'));
  next();
 });
 router.get('/invoices/:id/ledger',(req,res)=>res.json(ledger.read((res.locals.session as StoredSession).workspace,String(req.params.id))));
 router.post('/invoices/:id/credits',(req,res)=>{
  const workspace=(res.locals.session as StoredSession).workspace,id=String(req.params.id),input=parse(z.object({amount:z.number().int().min(1).max(1_000_000_000),reason:z.string().trim().min(1).max(1000)}).strict(),req.body);
  const result=store.idempotent('invoice-credit:'+workspace,req.get('Idempotency-Key'),{id,...input},200,()=>ledger.credit(workspace,id,input.amount,input.reason,now()));res.status(result.status).json(result.body);
 });
 router.post('/invoices/:id/void',(req,res)=>{
  const workspace=(res.locals.session as StoredSession).workspace,id=String(req.params.id),input=parse(z.object({reason:z.string().trim().min(1).max(1000)}).strict(),req.body);
  const result=store.idempotent('invoice-void:'+workspace,req.get('Idempotency-Key'),{id,...input},200,()=>ledger.void(workspace,id,input.reason,now()));res.status(result.status).json(result.body);
 });
 router.get('/invoice-ledger/export.csv',(_req,res)=>res.type('text/csv').attachment('quiet-ledger-invoice-balances.csv').send(invoiceBalanceCsv(ledger.list((res.locals.session as StoredSession).workspace))));
 return router;
}
