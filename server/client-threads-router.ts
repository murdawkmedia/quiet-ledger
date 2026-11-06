import {Router,type Response} from 'express';
import {z} from 'zod';
import {Clients} from './clients.js';
import {InvoiceThreads} from './invoice-threads.js';
import {DomainError,type Store,type StoredSession} from './store.js';
import {parse} from './domain.js';

/** Mount callers after session, CSRF and origin checks. */
export function requirePrivateBrowserWorkspace(store:Store,res:Response){
  const session=res.locals.session as StoredSession|undefined;
  if(!session)throw new DomainError(401,'Sign in to continue.');
  if(res.locals.apiAccess||session.role!=='owner'||session.hackathonDemo)throw new DomainError(403,'Use your private browser workspace for clients and conversations.');
  if(!store.encrypted)throw new DomainError(403,'Use an encrypted private-account installation for client records and conversations.');
  return session.workspace;
}
/** Browser-only business records. */
export function createClientThreadsRouter(store:Store,now:()=>Date){
 const clients=new Clients(store,now),threads=new InvoiceThreads(store,now),router=Router();
 const owner=(res:Response)=>requirePrivateBrowserWorkspace(store,res);
 const uuid=z.string().uuid(),empty=z.object({}).strict();
 const message=z.object({text:z.string().min(1).max(8000),parentId:uuid.optional()}).strict();
 const page=z.object({cursor:z.string().min(1).max(512).optional(),limit:z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional()}).strict();
 router.get('/api/clients',(_req,res)=>res.json({clients:clients.list(owner(res))}));
 router.get('/api/clients/:id',(req,res)=>{const workspace=owner(res),id=parse(uuid,req.params.id),client=clients.get(workspace,id);if(!client)throw new DomainError(404,'Client not found.');res.json({client});});
 router.post('/api/clients',(req,res)=>{const workspace=owner(res);res.status(req.body?.id?200:201).json({client:clients.save(workspace,req.body)});});
 router.delete('/api/clients/:id',(req,res)=>res.json(clients.remove(owner(res),parse(uuid,req.params.id))));
 router.post('/api/invoices/:id/thread',(req,res)=>{const workspace=owner(res);parse(empty,req.body??{});res.json({thread:threads.getOrCreate(workspace,parse(uuid,req.params.id))});});
 router.get('/api/invoices/:id/thread',(req,res)=>{const workspace=owner(res),query=parse(page,req.query);res.json(threads.list(workspace,parse(uuid,req.params.id),{cursor:query.cursor,limit:query.limit?Number(query.limit):undefined}));});
 router.post('/api/invoices/:id/thread/messages',(req,res)=>{
  const workspace=owner(res),id=parse(uuid,req.params.id),body=parse(message,req.body);
  const result=store.idempotent('thread-note:'+workspace+':'+id,req.get('idempotency-key'),body,201,()=>({message:threads.append(workspace,id,{...body,channel:'dashboard',direction:'internal',author:'You',state:'recorded'})}));
  res.status(result.status).json(result.body);
 });
 return router;
}
