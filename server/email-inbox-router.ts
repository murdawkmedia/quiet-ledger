import {Router} from 'express';
import {z} from 'zod';
import type {Store} from './store.js';
import type {InvoiceEmailInbox} from './email-inbox.js';
import type {ThreadEmailService} from './thread-email.js';
import {parse} from './domain.js';
import {requirePrivateBrowserWorkspace} from './client-threads-router.js';

export function createEmailInboxRouter(store:Store,inbox:InvoiceEmailInbox,replies:ThreadEmailService){
 const router=Router(),empty=z.object({}).strict();
 const query=z.object({invoiceId:z.string().uuid().optional(),limit:z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).optional()}).strict();
 router.get('/api/email-inbox/settings',(_req,res)=>res.json({settings:inbox.settings(requirePrivateBrowserWorkspace(store,res))}));
 router.post('/api/email-inbox/settings',async(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res),settings=inbox.configure(workspace,req.body),sync=settings.enabled?await inbox.sync(workspace):undefined;res.json({settings:inbox.settings(workspace),...(sync?{sync}:{})});});
 router.post('/api/email-inbox/sync',async(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res);parse(empty,req.body??{});res.json(await inbox.sync(workspace));});
 router.get('/api/email-inbox/items',(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res),input=parse(query,req.query);res.json({items:inbox.list(workspace,{invoiceId:input.invoiceId,limit:input.limit?Number(input.limit):undefined})});});
 for(const action of ['approve','reject'] as const)router.post('/api/email-inbox/items/:id/'+action,(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res);parse(empty,req.body??{});res.json({item:inbox[action](workspace,parse(z.string().uuid(),req.params.id))});});
 router.post('/api/invoices/:id/thread/email/preview',(req,res)=>res.json({preview:replies.preview(requirePrivateBrowserWorkspace(store,res),parse(z.string().uuid(),req.params.id),req.body)}));
 router.post('/api/invoices/:id/thread/email/send',async(req,res)=>{const result=await replies.send(requirePrivateBrowserWorkspace(store,res),parse(z.string().uuid(),req.params.id),req.body,req.get('idempotency-key')??'',{demo:false});res.status(result.status).json(result.body);});
 return router;
}
