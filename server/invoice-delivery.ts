import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {connect as connectTls,type ConnectionOptions,type TLSSocket} from 'node:tls';
import type {Invoice} from '../shared/contracts.js';
import type {InvoiceEmailContext,InvoiceEmailRecipient,InvoiceEmailResult,InvoiceEmailSettings} from '../shared/invoice-delivery.js';
import {DomainError,Store,hash} from './store.js';

const table='invoice_email_settings';
const credentialTable='invoice_email_credentials',deliveryTable='invoice_email_deliveries';
const email=z.string().max(254).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a single email address without control characters.').transform(value=>value.trim()).pipe(z.email());
const recipient=z.object({label:z.string().trim().min(1).max(80).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),email}).strict();
const settingsSchema=z.object({savedRecipients:z.array(recipient).max(32),selfCopyEmail:email.optional(),senderEmail:email.optional(),appPassword:z.string().max(32).transform(value=>value.replace(/ /g,'')).pipe(z.string().regex(/^[a-zA-Z]{16}$/)).optional(),disconnectGmail:z.boolean().optional()}).strict();
const requestSchema=z.object({action:z.enum(['preview','draft','send']),to:z.array(email).min(1).max(5),copyToSelf:z.boolean().default(false),message:z.string().max(2000).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)).optional()}).strict();
const resolutionSchema=z.object({outcome:z.enum(['confirmed_sent','confirmed_not_sent']),note:z.string().max(1000).trim().min(5).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))}).strict();
const rfcMessageId=z.string().max(254).regex(/^<[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?>$/);
const threadHeadersSchema=z.object({replyTo:email.optional(),inReplyTo:rfcMessageId.optional(),references:z.array(rfcMessageId).min(1).max(32).refine(values=>values.join(' ').length<=4096).optional()}).strict();
const activeSubmissions=new WeakMap<Store,Set<string>>();
const ownerTable='invoice_email_submission_owners';
function liveProcess(pid:number):boolean{if(!Number.isSafeInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(error){return !(error&&typeof error==='object'&&'code'in error&&error.code==='ESRCH');}}
class DispatchDenied extends Error {}
function parsed<T>(schema:z.ZodType<T>,body:unknown):T{const result=schema.safeParse(body);if(!result.success)throw new DomainError(400,'Check the email addresses, recipient limit and message fields.');return result.data;}
function unique<T extends {email:string}>(rows:T[]):T[]{const seen=new Set<string>();return rows.filter(row=>{const key=row.email.toLowerCase();if(seen.has(key))return false;seen.add(key);return true;});}
const header=(value:string)=>value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
export interface InvoiceDeliveryOptions {
 publicOrigin:string;allowInsecureLoopback?:boolean;now?:()=>Date;
 defaultSelfCopyEmailForWorkspace?:(workspace:string)=>string|undefined;
 transportFactory?:(credentials:InvoiceGmailCredentials)=>Promise<InvoiceMailTransport>|InvoiceMailTransport;
 transportTimeoutMs?:number;
 /** Synchronous observers participate in the delivery transaction; never expose them as request input. */
 onReserved?:(workspace:string,invoiceId:string,result:InvoiceEmailResult)=>void;
 onCompleted?:(workspace:string,invoiceId:string,result:InvoiceEmailResult)=>void;
}
export interface InvoiceGmailCredentials {senderEmail:string;appPassword:string;verifiedAt?:string}
export interface InvoiceMailThreadHeaders {replyTo?:string;inReplyTo?:string;references?:string[]}
/** Only trusted thread adapters supply these headers; invoice compose input cannot. */
export function invoiceMailThreadHeaders(input:unknown):InvoiceMailThreadHeaders{
 const result=threadHeadersSchema.safeParse(input);if(!result.success)throw new DomainError(400,'Check the reply address and email thread references.');return result.data;
}
export interface InvoiceMailMessage extends InvoiceMailThreadHeaders {from:string;to:string[];cc:string[];subject:string;text:string;messageId:string;disableFileAccess:true;disableUrlAccess:true}
export interface InvoicePreparedEmail extends InvoiceMailThreadHeaders {to:string[];cc:string[];subject:string;text:string;replyContextId:string}
export interface InvoiceSubmissionHooks {beforeDispatch?:()=>void|Promise<void>;assertCurrent?:()=>void;onReserved?:(result:InvoiceEmailResult)=>void;onCompleted?:(result:InvoiceEmailResult)=>void}
export interface InvoiceMailTransport {verify:()=>Promise<unknown>;sendMail:(message:InvoiceMailMessage)=>Promise<{messageId?:string;accepted?:unknown[];rejected?:unknown[]}>;close?:()=>void}
export async function createGmailTransport(credentials:InvoiceGmailCredentials,connectSocket:(options:ConnectionOptions)=>TLSSocket=connectTls):Promise<InvoiceMailTransport>{
 const {default:nodemailer}=await import('nodemailer');
 const sockets=new Set<TLSSocket>();let closed=false;
 const transport=nodemailer.createTransport({host:'smtp.gmail.com',port:465,secure:true,auth:{user:credentials.senderEmail,pass:credentials.appPassword},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},connectionTimeout:6000,greetingTimeout:6000,socketTimeout:8000,disableFileAccess:true,disableUrlAccess:true,logger:false,debug:false,
  getSocket:(_options,callback)=>{
   if(closed){callback(new Error('Email transport closed.'));return;}
   const socket=connectSocket({host:'smtp.gmail.com',port:465,servername:'smtp.gmail.com',minVersion:'TLSv1.2',rejectUnauthorized:true});sockets.add(socket);let settled=false;
   const fail=(error:Error)=>{if(!settled){settled=true;callback(error);}};
   socket.once('error',fail);socket.once('close',()=>{sockets.delete(socket);fail(new Error('Email connection closed.'));});
   socket.once('secureConnect',()=>{if(closed||socket.destroyed){socket.destroy();fail(new Error('Email transport closed.'));return;}settled=true;callback(null,{connection:socket,secured:true});});
   socket.setTimeout(6000,()=>socket.destroy(new Error('Email connection timed out.')));
  }
 });
 return{verify:()=>transport.verify(),sendMail:async message=>{const {replyTo,inReplyTo,references,...base}=message;return transport.sendMail({...base,...invoiceMailThreadHeaders({replyTo,inReplyTo,references})});},close:()=>{closed=true;for(const socket of sockets)socket.destroy();sockets.clear();transport.close();}};
}

/** SMTP acceptance, a prepared draft and a preview are separate outcomes. */
export class InvoiceDelivery {
 private origin:string;private now:()=>Date;private timeout:number;private active:Set<string>;private ownerId=randomUUID();
 constructor(private store:Store,private options:InvoiceDeliveryOptions){
  const origin=new URL(options.publicOrigin),loopback=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
  if(origin.origin!==options.publicOrigin||origin.username||origin.password||!(origin.protocol==='https:'||(origin.protocol==='http:'&&loopback&&options.allowInsecureLoopback)))throw new Error('Invoice email requires a configured HTTPS origin or explicit loopback origin.');
  this.origin=origin.origin;this.now=options.now??(()=>new Date());
  this.active=activeSubmissions.get(store)??new Set<string>();activeSubmissions.set(store,this.active);
  this.timeout=options.transportTimeoutMs??10000;if(!Number.isSafeInteger(this.timeout)||this.timeout<1||this.timeout>12000)throw new Error('Invoice email transport deadline must be at most twelve seconds.');
  store.db.exec(`CREATE TABLE IF NOT EXISTS ${ownerTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_id TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(workspace TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  store.db.exec(`CREATE TABLE IF NOT EXISTS ${credentialTable}(workspace TEXT PRIMARY KEY,data TEXT NOT NULL);CREATE TABLE IF NOT EXISTS ${deliveryTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),key_hash TEXT NOT NULL,request_hash TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(workspace,key_hash));CREATE INDEX IF NOT EXISTS invoice_email_deliveries_invoice ON ${deliveryTable}(workspace,invoice_id);`);
 }
 settings(workspace:string):InvoiceEmailSettings{
  const row=this.store.db.prepare(`SELECT data FROM ${table} WHERE workspace=?`).get(workspace);
  const value=this.options.defaultSelfCopyEmailForWorkspace?.(workspace),fallback=email.safeParse(value);
  const saved:InvoiceEmailSettings=row?this.store.decode(row.data,table,workspace,workspace):{savedRecipients:[],...(fallback.success?{selfCopyEmail:fallback.data}:{})};
  const credential=this.credentials(workspace);
  return {...saved,...(credential?{senderEmail:credential.senderEmail,gmailConfigured:true,...(credential.verifiedAt?{gmailVerifiedAt:credential.verifiedAt}:{})}:{})};
 }
 private credentials(workspace:string):InvoiceGmailCredentials|undefined{const row=this.store.db.prepare(`SELECT data FROM ${credentialTable} WHERE workspace=?`).get(workspace);return row?this.store.decode(row.data,credentialTable,workspace,workspace):undefined;}
 /** Server adapters only. Never include this credential in an HTTP response or thread record. */
 credentialForInbox(workspace:string):InvoiceGmailCredentials|undefined{return this.credentials(workspace);}
 private async useTransport<T>(credentials:InvoiceGmailCredentials,operation:(transport:InvoiceMailTransport,assertActive:()=>void)=>Promise<T>):Promise<T>{
  let transport:InvoiceMailTransport|undefined,timer:ReturnType<typeof setTimeout>|undefined,expired=false,closed=false;
  const close=()=>{if(transport&&!closed){closed=true;try{transport.close?.();}catch{/* Provider details must not escape. */}}};
  const work=Promise.resolve().then(()=>(this.options.transportFactory??createGmailTransport)(credentials)).then(value=>{transport=value;if(expired){close();throw new Error('Email transport deadline exceeded.');}return operation(value,()=>{if(expired||closed)throw new DispatchDenied();});});
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{expired=true;close();reject(new Error('Email transport deadline exceeded.'));},this.timeout);});
  try{return await Promise.race([work,deadline]);}finally{if(timer)clearTimeout(timer);close();}
 }
 saveSettings(workspace:string,body:unknown,context:{demo:boolean}={demo:false}):InvoiceEmailSettings{
  const input=parsed(settingsSchema,body);
  if(context.demo&&(input.senderEmail||input.appPassword||input.disconnectGmail))throw new DomainError(403,'The demo cannot connect a Gmail account.');
  if(input.disconnectGmail&&input.appPassword)throw new DomainError(400,'Disconnect Gmail separately from saving a new App Password.');
  if(input.appPassword&&(!input.senderEmail||!this.store.encrypted))throw new DomainError(400,'A sender address and encrypted storage are required to save a Gmail App Password.');
  const settings:InvoiceEmailSettings={savedRecipients:unique(input.savedRecipients),...(input.senderEmail?{senderEmail:input.senderEmail}:{}),...(input.selfCopyEmail||input.senderEmail?{selfCopyEmail:input.selfCopyEmail??input.senderEmail}:{})};
  return this.store.transaction(()=>{
   this.store.assertWriteBudget();const prior=this.credentials(workspace);
   if(input.disconnectGmail||prior?.senderEmail!==input.senderEmail)this.store.db.prepare(`DELETE FROM ${credentialTable} WHERE workspace=?`).run(workspace);
   if(input.appPassword){const credential:InvoiceGmailCredentials={senderEmail:input.senderEmail!,appPassword:input.appPassword};this.store.db.prepare(`INSERT INTO ${credentialTable}(workspace,data) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET data=excluded.data`).run(workspace,this.store.encode(credential,credentialTable,workspace,workspace));}
   this.store.db.prepare(`INSERT INTO ${table}(workspace,data) VALUES(?,?) ON CONFLICT(workspace) DO UPDATE SET data=excluded.data`).run(workspace,this.store.encode(settings,table,workspace,workspace));return this.settings(workspace);
  });
 }
 async verifyGmail(workspace:string,context:{demo:boolean}):Promise<InvoiceEmailSettings>{
  if(context.demo)throw new DomainError(403,'The demo cannot connect a Gmail account.');
  const credential=this.credentials(workspace);if(!credential)throw new DomainError(409,'Save a Gmail sender and App Password first.');
  try{if(await this.useTransport(credential,transport=>transport.verify())!==true)throw new Error('Gmail authentication was not verified.');}
  catch{
   this.store.transaction(()=>{const current=this.credentials(workspace);if(current&&current.senderEmail===credential.senderEmail&&current.appPassword===credential.appPassword&&current.verifiedAt===credential.verifiedAt){delete current.verifiedAt;this.store.db.prepare(`UPDATE ${credentialTable} SET data=? WHERE workspace=?`).run(this.store.encode(current,credentialTable,workspace,workspace),workspace);}});
   throw new DomainError(502,'Gmail could not authenticate this connection. Check the sender, App Password and Google account settings. No test email was sent.');
  }
  return this.store.transaction(()=>{const current=this.credentials(workspace);if(!current||current.senderEmail!==credential.senderEmail||current.appPassword!==credential.appPassword)throw new DomainError(409,'Gmail settings changed during connection. Connect again.');current.verifiedAt=this.now().toISOString();this.store.db.prepare(`UPDATE ${credentialTable} SET data=? WHERE workspace=?`).run(this.store.encode(current,credentialTable,workspace,workspace),workspace);return this.settings(workspace);});
 }
 private invoice(workspace:string,id:string):Invoice{
  const invoice=this.store.getInvoice(id,workspace) as Invoice|undefined;
  if(!invoice)throw new DomainError(404,'Invoice not found.');
  if(this.store.linksRevoked(id))throw new DomainError(409,'This invoice link is revoked. It cannot be included in an email.');
  return invoice;
 }
 view(workspace:string,id:string,context:{demo:boolean}):InvoiceEmailContext{
  const invoice=this.invoice(workspace,id),settings=this.settings(workspace);
  const previous:InvoiceEmailRecipient[]=[];
  for(const item of this.store.listInvoices(workspace) as Invoice[]){const address=email.safeParse(item.customerEmail);if(address.success)previous.push({label:header(item.customerName).slice(0,80)||address.data,email:address.data});}
  const deliveries=this.store.db.prepare(`SELECT id,data FROM ${deliveryTable} WHERE workspace=? AND invoice_id=? ORDER BY rowid DESC LIMIT 10`).all(workspace,id).map(row=>{const result=this.store.decode<InvoiceEmailResult>(row.data,deliveryTable,String(row.id),workspace);return result.state==='sending'?{...result,state:'unknown' as const}:result;});
  return {invoice:{id:invoice.id,number:invoice.number,title:invoice.title,customerName:invoice.customerName,customerEmail:invoice.customerEmail,total:invoice.total,currency:invoice.currency},settings,recipients:unique([...settings.savedRecipients,...previous]).slice(0,64),mailAppAvailable:!context.demo,demo:context.demo,deliveries};
 }
 private message(workspace:string,invoice:Invoice,input:z.output<typeof requestSchema>):InvoiceEmailResult{
  const settings=this.settings(workspace),to=unique(input.to.map(email=>({email}))).map(row=>row.email);
  if(input.copyToSelf&&!settings.selfCopyEmail)throw new DomainError(400,'Set your self-copy email before adding a copy.');
  const cc=input.copyToSelf&&settings.selfCopyEmail&&!to.some(value=>value.toLowerCase()===settings.selfCopyEmail!.toLowerCase())?[settings.selfCopyEmail]:[];
  if(to.length+cc.length>5)throw new DomainError(400,'Choose at most five recipients including your self-copy.');
  const checkoutUrl=new URL('/pay/'+encodeURIComponent(invoice.token),this.origin).href;
  const subject=header(`Invoice ${invoice.number} · ${invoice.title}`),amount=new Intl.NumberFormat('en-CA',{style:'currency',currency:invoice.currency}).format(invoice.total/(invoice.currency==='KRW'?1:100));
  const text=[`Hello ${invoice.customerName},`,'',`Invoice ${invoice.number}: ${invoice.title}`,`Total: ${amount} ${invoice.currency}`,...(invoice.dueDate?[`Due: ${invoice.dueDate}`]:[]),...(invoice.paymentTerms?['',`Payment terms: ${invoice.paymentTerms}`]:[]),'',...(input.message?.trim()?[input.message.trim(),'']:[]),'View the invoice and payment options:',checkoutUrl,'','This link gives access to this invoice. Share it only with the intended recipient.'].join('\n');
  return {state:input.action==='preview'?'preview':'draft_ready',to,cc,subject,text,checkoutUrl,...(settings.senderEmail?{senderEmail:settings.senderEmail}:{})};
 }
 compose(workspace:string,id:string,body:unknown,key:string|undefined,context:{demo:boolean}):{status:number;body:InvoiceEmailResult}{
  const invoice=this.invoice(workspace,id),input=parsed(requestSchema,body);
  if(context.demo&&input.action!=='preview')throw new DomainError(403,'Demo invoices can only preview email. No email is sent or opened in a mail app.');
  if(input.action==='send')throw new DomainError(400,'Use the email submission action to send an invoice.');
  const message=this.message(workspace,invoice,input);
  return this.store.idempotent('invoice-email:'+workspace,key,{id,input},200,()=>{
   const result:InvoiceEmailResult={...message};
   if(input.action==='draft'){const query=Object.entries({...result.cc.length?{cc:result.cc.join(',')}:{},subject:result.subject,body:result.text}).map(([name,value])=>`${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&');result.mailtoUrl=`mailto:${result.to.map(value=>encodeURIComponent(value)).join(',')}?${query}`;}
   this.store.audit(workspace,input.action==='preview'?'invoice.email_preview':'invoice.email_draft',`${invoice.number}: ${input.action==='preview'?'email preview prepared':'mail app draft prepared; delivery is not verified'}.`,this.now().toISOString());
   return result;
  });
 }
 resolve(workspace:string,id:string,deliveryId:string,body:unknown,context:{demo:boolean}):{status:number;body:InvoiceEmailResult}{
  if(context.demo)throw new DomainError(403,'The demo cannot resolve email submissions.');
  if(!this.store.getInvoice(id,workspace))throw new DomainError(404,'Invoice not found.');
  const validation=resolutionSchema.safeParse(body);if(!validation.success)throw new DomainError(400,'Choose a confirmed email outcome and add a note of five to one thousand characters.');const input=validation.data;
  return this.store.transaction(()=>{
   const row=this.store.db.prepare(`SELECT data FROM ${deliveryTable} WHERE id=? AND workspace=? AND invoice_id=?`).get(deliveryId,workspace,id);if(!row)throw new DomainError(404,'Email submission not found.');
   const prior=this.store.decode<InvoiceEmailResult>(row.data,deliveryTable,deliveryId,workspace);
   if(prior.resolvedAt){if(prior.resolutionOutcome!==input.outcome||prior.resolutionNote!==input.note)throw new DomainError(409,'This email submission already has a different recorded resolution.');return{status:200,body:prior};}
   const owner=this.store.db.prepare(`SELECT owner_pid FROM ${ownerTable} WHERE id=? AND workspace=?`).get(deliveryId,workspace);
   if(this.active.has(deliveryId)||(owner&&liveProcess(Number(owner.owner_pid))))throw new DomainError(409,'This email submission is still running. Wait for its result before checking the mailbox.');
   if(owner)this.store.db.prepare(`DELETE FROM ${ownerTable} WHERE id=? AND workspace=?`).run(deliveryId,workspace);
   const state=prior.state==='sending'?'unknown':prior.state;
   if(state!=='unknown'&&state!=='partial_rejection')throw new DomainError(409,'Only an uncertain or partial email submission can be resolved.');
   this.store.assertWriteBudget();const resolvedAt=this.now().toISOString(),result:InvoiceEmailResult={...prior,state,resolvedAt,resolutionOutcome:input.outcome,resolutionNote:input.note};
   this.store.db.prepare(`UPDATE ${deliveryTable} SET state=?,data=? WHERE id=? AND workspace=? AND invoice_id=?`).run(state,this.store.encode(result,deliveryTable,deliveryId,workspace),deliveryId,workspace,id);
   this.store.audit(workspace,'invoice.email_resolution',`Email submission ${deliveryId}: owner recorded ${input.outcome} after checking the mailbox; the original ${state} result is retained. A later copy requires a new explicit action.`,resolvedAt);
   return{status:200,body:result};
  });
 }
 async send(workspace:string,id:string,body:unknown,key:string|undefined,context:{demo:boolean}):Promise<{status:number;body:InvoiceEmailResult}>{
  if(context.demo)throw new DomainError(403,'The demo cannot send email.');
  const invoice=this.invoice(workspace,id),input=parsed(requestSchema,body);
  if(input.action!=='send')throw new DomainError(400,'Choose the email submission action.');
  return this.submit(workspace,id,{id,input},()=>this.message(workspace,invoice,input),key,context);
 }
 /** Internal adapter API. Browser compose cannot supply these generated thread headers. */
 async sendPrepared(workspace:string,id:string,input:InvoicePreparedEmail,key:string|undefined,context:{demo:boolean},hooks:InvoiceSubmissionHooks):Promise<{status:number;body:InvoiceEmailResult}>{
  const invoice=this.invoice(workspace,id),safe=parsed(z.object({to:z.array(email).min(1).max(5),cc:z.array(email).max(5),subject:z.string().min(1).max(300).refine(value=>!/[\u0000-\u001f\u007f]/.test(value)),text:z.string().min(1).max(8000).refine(value=>value.trim().length>0&&!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value)),replyContextId:z.uuid(),replyTo:email,inReplyTo:rfcMessageId,references:z.array(rfcMessageId).min(1).max(32)}).strict(),input);
  if(safe.to.length+safe.cc.length>5)throw new DomainError(400,'Choose at most five recipients including your self-copy.');invoiceMailThreadHeaders({replyTo:safe.replyTo,inReplyTo:safe.inReplyTo,references:safe.references});
  return this.submit(workspace,id,{id,kind:'thread_reply',input:safe},()=>({...safe,state:'sending',kind:'thread_reply',checkoutUrl:new URL('/pay/'+encodeURIComponent(invoice.token),this.origin).href}),key,context,hooks);
 }
 private async submit(workspace:string,id:string,request:unknown,createMessage:()=>InvoiceEmailResult,key:string|undefined,context:{demo:boolean},hooks:InvoiceSubmissionHooks={}):Promise<{status:number;body:InvoiceEmailResult}>{
  if(context.demo)throw new DomainError(403,'The demo cannot send email.');const invoice=this.invoice(workspace,id);
  if(!key||!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new DomainError(400,'A valid Idempotency-Key header is required.');
  const keyHash=this.store.indexValue('invoice-email-key',hash(key)),fingerprint=this.store.indexValue('invoice-email-request',hash(JSON.stringify(request))),credential=this.credentials(workspace);
  const reserved=this.store.transaction(()=>{
   const row=this.store.db.prepare(`SELECT id,request_hash,data FROM ${deliveryTable} WHERE workspace=? AND key_hash=?`).get(workspace,keyHash);
   if(row){if(row.request_hash!==fingerprint)throw new DomainError(409,'This idempotency key was already used for a different email.');const result=this.store.decode<InvoiceEmailResult>(row.data,deliveryTable,String(row.id),workspace);return{existing:true,result:result.state==='sending'?{...result,state:'unknown' as const}:result};}
   hooks.assertCurrent?.();
   if(!credential?.verifiedAt)throw new DomainError(409,'Connect and authenticate Gmail before sending, or open a draft in your mail app.');
   const uncertain=this.store.db.prepare(`SELECT id,data FROM ${deliveryTable} WHERE workspace=? AND invoice_id=? AND state IN ('sending','unknown','partial_rejection')`).all(workspace,id);
   if(uncertain.some(row=>!this.store.decode<InvoiceEmailResult>(row.data,deliveryTable,String(row.id),workspace).resolvedAt))throw new DomainError(409,'An earlier submission has an uncertain or partial result. Check Gmail before sending another copy.');
   if(Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${deliveryTable} WHERE workspace=?`).get(workspace)!.n)>=this.store.limits.idempotencyPerScope)throw new DomainError(429,'This workspace has reached its saved-email limit.');
   this.store.assertWriteBudget();const deliveryId=randomUUID(),requestedMessageId=`<${deliveryId}@${new URL(this.origin).hostname}>`,result:InvoiceEmailResult={...createMessage(),state:'sending',deliveryId,createdAt:this.now().toISOString(),senderEmail:credential.senderEmail,messageId:requestedMessageId,requestedMessageId};
   this.store.db.prepare(`INSERT INTO ${deliveryTable}(id,workspace,invoice_id,key_hash,request_hash,state,data) VALUES(?,?,?,?,?,?,?)`).run(deliveryId,workspace,id,keyHash,fingerprint,'sending',this.store.encode(result,deliveryTable,deliveryId,workspace));
   this.store.db.prepare(`INSERT INTO ${ownerTable}(id,workspace,owner_pid,owner_id) VALUES(?,?,?,?)`).run(deliveryId,workspace,process.pid,this.ownerId);
   this.options.onReserved?.(workspace,id,result);hooks.onReserved?.(result);
   this.store.audit(workspace,'invoice.email_submission_started',`${invoice.number}: email submission started; delivery is not verified.`,this.now().toISOString());return{existing:false,result};
  });
  if(reserved.existing)return{status:200,body:reserved.result};
  const deliveryId=reserved.result.deliveryId!;this.active.add(deliveryId);
  try{
  let result=reserved.result,authRejected=false;
  try{
   const info=await this.useTransport(credential!,async(transport,assertActive)=>{
    try{await hooks.beforeDispatch?.();assertActive();this.invoice(workspace,id);const current=this.credentials(workspace);if(!current?.verifiedAt||current.senderEmail!==credential!.senderEmail||current.appPassword!==credential!.appPassword)throw new DispatchDenied();hooks.assertCurrent?.();}catch{throw new DispatchDenied();}
    return transport.sendMail({from:credential!.senderEmail,to:result.to,cc:result.cc,subject:result.subject,text:result.text,messageId:result.requestedMessageId!,...invoiceMailThreadHeaders({replyTo:result.replyTo,inReplyTo:result.inReplyTo,references:result.references}),disableFileAccess:true,disableUrlAccess:true});
   });
   const recipients=[...result.to,...result.cc],addresses=(values:unknown[]|undefined)=>unique((values??[]).flatMap(value=>{const address=email.safeParse(value);return address.success&&recipients.some(item=>item.toLowerCase()===address.data.toLowerCase())?[{email:address.data}]:[];})).map(row=>row.email);
   const accepted=addresses(info.accepted),rejected=addresses(info.rejected),all=recipients.every(value=>accepted.some(item=>item.toLowerCase()===value.toLowerCase()));
   result={...result,state:all&&!rejected.length?'provider_accepted':accepted.length&&rejected.length?'partial_rejection':'unknown',accepted,rejected,...(typeof info.messageId==='string'&&info.messageId.length<=254&&!/[\u0000-\u001f\u007f]/.test(info.messageId)?{messageId:info.messageId}:{})};
  }catch(error){authRejected=!!(error&&typeof error==='object'&&'code'in error&&error.code==='EAUTH'&&'command'in error&&typeof error.command==='string'&&/^AUTH(?: |$)/.test(error.command));result={...result,state:authRejected||error instanceof DispatchDenied?'not_sent':'unknown'};}
  this.store.transaction(()=>{
   const saved=this.store.db.prepare(`SELECT data FROM ${deliveryTable} WHERE id=? AND workspace=?`).get(deliveryId,workspace);
   if(!saved)throw new DomainError(409,'The reserved email submission is unavailable.');
   const latest=this.store.decode<InvoiceEmailResult>(saved.data,deliveryTable,deliveryId,workspace),owner=this.store.db.prepare(`SELECT owner_id FROM ${ownerTable} WHERE id=? AND workspace=?`).get(deliveryId,workspace);
   if(latest.resolvedAt||owner?.owner_id!==this.ownerId){result=latest.state==='sending'?{...latest,state:'unknown'}:latest;return;}
   if(authRejected){const current=this.credentials(workspace);if(current?.senderEmail===credential!.senderEmail&&current?.appPassword===credential!.appPassword){delete current!.verifiedAt;this.store.db.prepare(`UPDATE ${credentialTable} SET data=? WHERE workspace=?`).run(this.store.encode(current,credentialTable,workspace,workspace),workspace);}}
   this.store.db.prepare(`UPDATE ${deliveryTable} SET state=?,data=? WHERE id=? AND workspace=?`).run(result.state,this.store.encode(result,deliveryTable,result.deliveryId!,workspace),result.deliveryId!,workspace);
   this.options.onCompleted?.(workspace,id,result);hooks.onCompleted?.(result);
   this.store.audit(workspace,`invoice.email_${result.state}`,`${invoice.number}: ${result.state==='provider_accepted'?'Gmail accepted the message for all recipients; delivery is not verified':result.state==='partial_rejection'?'Gmail accepted some recipients and rejected others; do not automatically resend':result.state==='not_sent'?(authRejected?'Gmail rejected authentication before message submission; reconnect before trying again':'email authority changed before dispatch; no SMTP message was submitted'):'email submission outcome is unknown; do not automatically resend'}.`,this.now().toISOString());
  });
  return {status:200,body:result};
  }finally{this.active.delete(deliveryId);this.store.db.prepare(`DELETE FROM ${ownerTable} WHERE id=? AND workspace=? AND owner_id=?`).run(deliveryId,workspace,this.ownerId);}
 }
}
