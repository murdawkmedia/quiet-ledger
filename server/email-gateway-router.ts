import {Router} from 'express';
import {z} from 'zod';
import {parse} from './domain.js';
import {DomainError,type Store} from './store.js';
import {requirePrivateBrowserWorkspace} from './client-threads-router.js';
import type {InvoiceEmailInbox} from './email-inbox.js';
import type {EmailMarmotGateway} from './email-marmot-gateway.js';

/** Mount after the application's session, origin and CSRF middleware. Never exposed as API/MCP authority. */
export function createEmailGatewayRouter(store:Store,inbox:InvoiceEmailInbox,gateway:EmailMarmotGateway){
 const router=Router(),empty=z.object({}).strict(),uuid=z.string().uuid();
 const settings=z.object({enabled:z.boolean(),ownerPubkey:z.string().min(1).max(256).optional()}).strict().refine(input=>!input.enabled||Boolean(input.ownerPubkey),'Explicitly choose the owner public key.');
 router.get('/api/invoices/:id/email-gateway',(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res);parse(empty,req.query);res.json({settings:gateway.settings(workspace,parse(uuid,req.params.id))});});
 router.post('/api/invoices/:id/email-gateway',async(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res),id=parse(uuid,req.params.id);parse(empty,req.query);const input=parse(settings,req.body);gateway.settings(workspace,id);if(input.enabled&&!inbox.settings(workspace).enabled)throw new DomainError(409,'Explicitly enable and initialize the original mailbox before enabling its gateway.');res.json({settings:await gateway.configure(workspace,id,input)});});
 router.post('/api/invoices/:id/email-gateway/sync',async(req,res)=>{const workspace=requirePrivateBrowserWorkspace(store,res);parse(empty,req.query);parse(empty,req.body??{});res.json({settings:await gateway.process(workspace,parse(uuid,req.params.id))});});
 return router;
}
