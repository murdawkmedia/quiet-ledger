import {z} from 'zod';
import type {ThreadEmailPayload} from '../shared/thread-email.js';
import type {EmailApprovedReplyContext} from '../shared/email-inbox.js';
import {DomainError,Store} from './store.js';
import {InvoiceDelivery,invoiceMailThreadHeaders} from './invoice-delivery.js';
import {InvoiceEmailInbox} from './email-inbox.js';
import {InvoiceThreads} from './invoice-threads.js';

const text=z.string().min(1).max(8000).refine(value=>value.trim().length>0&&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value));
const address=z.email().max(254).refine(value=>!/[\u0000-\u001f\u007f]/.test(value));
const previewSchema=z.object({text,parentInboxItemId:z.uuid().optional()}).strict();
const payloadSchema=z.object({to:z.array(address).min(1).max(5),cc:z.array(address).max(5),subject:z.string().min(1).max(300).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),text,replyContextId:z.uuid()}).strict();
export interface ThreadEmailServiceOptions {delivery:InvoiceDelivery;inbox:InvoiceEmailInbox;threads:InvoiceThreads;now?:()=>Date}
function parsed<T>(schema:z.ZodType<T>,input:unknown):T {const result=schema.safeParse(input);if(!result.success)throw new DomainError(400,'Check the reply text, recipient preview and approved email context.');return result.data;}

/** Owner-directed threaded mail. Preview is pure; every actual submission has a durable intent. */
export class ThreadEmailService {
 constructor(private store:Store,private options:ThreadEmailServiceOptions){}
 private invoice(workspace:string,id:string,context:{demo:boolean}){if(context.demo)throw new DomainError(403,'The demo cannot prepare or send threaded email.');if(!this.store.getInvoice(id,workspace))throw new DomainError(404,'Invoice not found.');if(this.store.linksRevoked(id))throw new DomainError(409,'This invoice link is revoked.');}
 private context(workspace:string,id:string,parentId?:string):EmailApprovedReplyContext{const parent=parentId?this.options.inbox.approvedReplyContext(workspace,id,parentId):this.options.inbox.latestApprovedReplyContext(workspace,id),credential=this.options.delivery.credentialForInbox(workspace);if(!credential?.verifiedAt||credential.senderEmail!==parent.binding.senderEmail)throw new DomainError(409,'Connect the original Gmail sender before preparing an explicit reply.');return parent;}
 private payload(parent:EmailApprovedReplyContext,text:string):ThreadEmailPayload {return{to:[...parent.binding.to],cc:[...parent.binding.cc],subject:parent.binding.subject,text,replyContextId:parent.item.id};}
 preview(workspace:string,id:string,input:unknown,context:{demo:boolean}={demo:false}):ThreadEmailPayload {this.invoice(workspace,id,context);const body=parsed(previewSchema,input);return this.payload(this.context(workspace,id,body.parentInboxItemId),body.text);}
 async send(workspace:string,id:string,input:unknown,intentKey:string,context:{demo:boolean},authority?:{assertCurrent:()=>void|Promise<void>}){
  this.invoice(workspace,id,context);const payload=parsed(payloadSchema,input),parent=this.context(workspace,id,payload.replyContextId),expected=this.payload(parent,payload.text);
  if(JSON.stringify(payload)!==JSON.stringify(expected))throw new DomainError(409,'The email preview no longer matches its approved recipient binding. Prepare it again.');
  const references=[...new Set([...(parent.binding.references??[]),parent.binding.requestedMessageId,parent.item.messageId!])];while(references.length>32||references.join(' ').length>4096)references.splice(1,1);
  const headers=invoiceMailThreadHeaders({replyTo:parent.binding.senderEmail,inReplyTo:parent.item.messageId!,references});
  const mailboxAuthority=this.options.inbox.authorityRevision(workspace);
  const assertCurrent=()=>{if(!mailboxAuthority||this.options.inbox.authorityRevision(workspace)!==mailboxAuthority)throw new DomainError(409,'The mailbox connection changed. Prepare a fresh reply.');this.invoice(workspace,id,context);const fresh=this.context(workspace,id,payload.replyContextId);if(JSON.stringify(this.payload(fresh,payload.text))!==JSON.stringify(payload)||fresh.binding.mailboxId!==parent.binding.mailboxId||fresh.item.messageId!==parent.item.messageId)throw new DomainError(409,'The email reply authority changed. Prepare a fresh preview.');};
  return this.options.delivery.sendPrepared(workspace,id,{...payload,...headers},intentKey,context,{
   assertCurrent,beforeDispatch:async()=>{await authority?.assertCurrent();assertCurrent();},
   onReserved:result=>{const binding=this.options.inbox.trackOutbound(workspace,id,result);if(!binding)throw new DomainError(409,'Enable the original mailbox before sending this reply.');this.options.threads.append(workspace,id,{channel:'email',direction:'outbound',author:'Email submission',text:payload.text,state:'pending',...(parent.item.threadMessageId?{parentId:parent.item.threadMessageId}:{}),sourceId:`email-delivery:${result.deliveryId}:intent`});},
   onCompleted:result=>{if(result.state!=='not_sent')this.options.inbox.trackOutbound(workspace,id,result);const accepted=result.state==='provider_accepted';this.options.threads.append(workspace,id,{channel:'email',direction:'internal',author:'Email submission status',text:accepted?'Gmail accepted this email for all listed recipients. Delivery and reading are not verified.':result.state==='not_sent'?'Email was not submitted. A new explicit action is required.':result.state==='partial_rejection'?'Gmail accepted some recipients and rejected others. Check the mailbox; this action will not be retried automatically.':'Email submission is uncertain. Check the mailbox; this action will not be retried automatically.',state:accepted?'recorded':result.state==='not_sent'?'failed':'unknown',sourceId:`email-delivery:${result.deliveryId}:outcome`});}
  });
 }
}
