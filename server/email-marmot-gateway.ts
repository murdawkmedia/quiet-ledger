import {randomBytes,randomUUID} from 'node:crypto';
import {nip19} from 'nostr-tools';
import type {ApprovedGatewayEmail,ReviewGatewayEmail,EmailGatewaySettings,GatewayEmailPayload,GatewayEmailPort,GatewayForwardResult,GatewayMarmotMessage,GatewayMarmotPort} from '../shared/email-gateway.js';
import {DomainError,Store,hash} from './store.js';
import {MarmotGatewayStore} from './marmot-gateway-store.js';

const configTable='email_marmot_gateways',intentTable='email_marmot_intents',sourceTable='email_marmot_sources';
const pairingMs=10*60000,confirmationMs=5*60000,maxAgeMs=15*60000,maxSources=5000,maxIntents=1000;
interface Config extends EmailGatewaySettings {revision:string;createdAt:string;pairHash?:string}
interface Intent {id:string;emailAuthority:string;revision:string;owner:string;groupId:string;nonceHash:string;expires:number;payload:GatewayEmailPayload;fingerprint:string}
interface Source {fingerprint?:string;state:'consumed'|'unknown'|'forwarded';messageId?:string;inboxItemId?:string;reviewDecision?:'approve'|'reject'}
export interface EmailMarmotGatewayOptions {
 now:()=>Date;
 /** Create a FRESH actor from records.secretKey/storage on each call; cached MLS actors can fork the ratchet. */
 marmotFor:(workspace:string)=>GatewayMarmotPort|Promise<GatewayMarmotPort>;
 email:GatewayEmailPort;
}
function line(value:unknown,max:number):value is string{return typeof value==='string'&&value.length>0&&value.length<=max&&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\u0000-\u001f\u007f-\u009f]/.test(value);}
function body(value:unknown):value is string{return typeof value==='string'&&value.length>0&&value.length<=8000&&value.trim().length>0&&Buffer.from(value,'utf8').toString('utf8')===value&&!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);}
function ownerKey(value:unknown):string{
 if(typeof value!=='string')throw new DomainError(400,'Choose a public owner Nostr key.');
 if(/^[a-fA-F0-9]{64}$/.test(value))return value.toLowerCase();
 try{const decoded=nip19.decode(value);if(decoded.type==='npub')return decoded.data;}catch{/* Secret keys, malformed and other encodings are rejected below. */}
 throw new DomainError(400,'Choose a public owner Nostr key.');
}
function checkedPayload(value:GatewayEmailPayload):GatewayEmailPayload{
 const email=(address:unknown)=>line(address,254)&&/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(address);
 if(!value||!Array.isArray(value.to)||!value.to.length||value.to.length>20||!Array.isArray(value.cc)||value.cc.length>20||![...value.to,...value.cc].every(email)||!line(value.subject,300)||!body(value.text)||(value.replyContextId!==undefined&&(typeof value.replyContextId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value.replyContextId))))throw new DomainError(400,'The exact email preview is invalid or exceeds supported limits.');
 return{to:[...value.to],cc:[...value.cc],subject:value.subject,text:value.text,...(value.replyContextId===undefined?{}:{replyContextId:value.replyContextId})};
}
const fingerprint=(payload:GatewayEmailPayload)=>hash(JSON.stringify([payload.to,payload.cc,payload.subject,payload.text,payload.replyContextId??null]));

/** Non-AI bridge. Only authenticated owner /email + /send commands can call the email port. */
export class EmailMarmotGateway {
 readonly records:MarmotGatewayStore;
 constructor(private store:Store,private options:EmailMarmotGatewayOptions){
  this.records=new MarmotGatewayStore(store);
  store.db.exec(`
   CREATE TABLE IF NOT EXISTS ${configTable}(workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),data TEXT NOT NULL,PRIMARY KEY(workspace,invoice_id));
   CREATE TABLE IF NOT EXISTS ${intentTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),nonce_hash TEXT NOT NULL,state TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(workspace,invoice_id,nonce_hash));
   CREATE TABLE IF NOT EXISTS ${sourceTable}(workspace TEXT NOT NULL,invoice_id TEXT NOT NULL REFERENCES invoices(id),source_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,invoice_id,source_hash));
  `);
 }
 private invoice(workspace:string,invoiceId:string){if(!line(workspace,512)||!line(invoiceId,128))throw new DomainError(400,'Choose a valid workspace and invoice.');if(!this.store.getInvoice(invoiceId,workspace))throw new DomainError(404,'Invoice not found.');}
 private existing(workspace:string,invoiceId:string):Config|undefined{const row=this.store.db.prepare(`SELECT data FROM ${configTable} WHERE workspace=? AND invoice_id=?`).get(workspace,invoiceId);return row?this.store.decode<Config>(row.data,configTable,invoiceId,workspace):undefined;}
 private save(workspace:string,invoiceId:string,config:Config){this.store.assertWriteBudget();this.store.db.prepare(`INSERT INTO ${configTable}(workspace,invoice_id,data) VALUES(?,?,?) ON CONFLICT(workspace,invoice_id) DO UPDATE SET data=excluded.data`).run(workspace,invoiceId,this.store.encode(config,configTable,invoiceId,workspace));}
 private view(config?:Config):EmailGatewaySettings{if(!config)return{enabled:false,status:'disabled'};const{revision:_,createdAt:__,pairHash:___,...result}=config;return result;}
 settings(workspace:string,invoiceId:string):EmailGatewaySettings{this.invoice(workspace,invoiceId);return this.view(this.existing(workspace,invoiceId));}
 /** Internal worker inventory; configuration payloads stay encrypted in the database. */
 listEnabled():{workspace:string;invoiceId:string}[]{return this.store.db.prepare(`SELECT workspace,invoice_id,data FROM ${configTable} LIMIT 5000`).all().filter(row=>this.store.decode<Config>(row.data,configTable,String(row.invoice_id),String(row.workspace)).enabled).map(row=>({workspace:String(row.workspace),invoiceId:String(row.invoice_id)}));}
 hasForwarded(workspace:string,invoiceId:string,sourceId:string,kind:'review'|'approved'):boolean{this.invoice(workspace,invoiceId);return Boolean(this.source(workspace,invoiceId,this.sourceId(workspace,invoiceId,`${kind==='review'?'review':'email'}:${sourceId}`)));}
 reportFailure(workspace:string,invoiceId:string){this.invoice(workspace,invoiceId);const config=this.existing(workspace,invoiceId);if(config?.enabled)this.save(workspace,invoiceId,{...config,lastError:'sync-unavailable'});}
 private current(workspace:string,invoiceId:string,revision:string,paired=false):Config|undefined{this.invoice(workspace,invoiceId);const config=this.existing(workspace,invoiceId);return config?.enabled&&config.revision===revision&&(!paired||config.status==='paired')?config:undefined;}
 private cancel(workspace:string,invoiceId:string){this.store.db.prepare(`UPDATE ${intentTable} SET state='cancelled' WHERE workspace=? AND invoice_id=? AND state='prepared'`).run(workspace,invoiceId);}
 private async withActor<T>(workspace:string,operation:(marmot:GatewayMarmotPort)=>Promise<T>):Promise<T>{
  const actor=await this.options.marmotFor(workspace);
  try{return await operation(actor);}finally{await actor.dispose?.();}
 }
 private async authorized(workspace:string,invoiceId:string,config:Config,marmot:GatewayMarmotPort):Promise<boolean>{
  let allowed=true;
  try{if(marmot.isAuthorized)allowed=await marmot.isAuthorized(config.groupId!,config.ownerPubkey!);}catch{allowed=false;}
  if(!allowed){const current=this.current(workspace,invoiceId,config.revision);if(current){this.disconnect(workspace,invoiceId);const disabled=this.existing(workspace,invoiceId)!;this.save(workspace,invoiceId,{...disabled,lastError:'authority-revoked'});}return false;}
  return Boolean(this.current(workspace,invoiceId,config.revision));
 }
 disconnect(workspace:string,invoiceId:string):EmailGatewaySettings{
  this.invoice(workspace,invoiceId);return this.store.transaction(()=>{const previous=this.existing(workspace,invoiceId);const config:Config={...previous,enabled:false,status:'disabled',revision:randomUUID(),createdAt:this.options.now().toISOString(),pairHash:undefined,pairExpiresAt:undefined};this.save(workspace,invoiceId,config);this.cancel(workspace,invoiceId);return this.view(config);});
 }
 async configure(workspace:string,invoiceId:string,input:{enabled:boolean;ownerPubkey?:string}):Promise<EmailGatewaySettings>{
  this.invoice(workspace,invoiceId);
  if(!input||typeof input.enabled!=='boolean'||Object.keys(input).some(key=>!['enabled','ownerPubkey'].includes(key)))throw new DomainError(400,'Choose valid gateway settings.');
  if(!input.enabled)return this.disconnect(workspace,invoiceId);
  const owner=ownerKey(input.ownerPubkey);
  if(!await this.options.email.active(workspace))throw new DomainError(409,'Enable and initialize the original mailbox before enabling its gateway.');
  return this.records.runExclusive(workspace,async()=>{
   const previous=this.existing(workspace,invoiceId);
   if(previous?.enabled&&previous.status==='paired'&&previous.ownerPubkey===owner)return this.view(previous);
   return this.withActor(workspace,async marmot=>{
   if(!/^[a-f0-9]{64}$/.test(marmot.pubkey)||marmot.pubkey===owner)throw new DomainError(400,'The gateway and owner require distinct public identities.');
   const revision=randomUUID(),nonce=randomBytes(24).toString('base64url'),createdAt=this.options.now().toISOString();
   let group:{id:string};
   try{group=await marmot.invite(owner,{context:hash(JSON.stringify(['email-gateway',workspace,invoiceId,revision]))});if(!line(group.id,512))throw new Error();}catch{throw new DomainError(503,'The gateway invitation could not be prepared.');}
   // A disconnect during invitation wins; an orphan invitation has no email authority.
   if(this.existing(workspace,invoiceId)?.revision!==previous?.revision)throw new DomainError(409,'Gateway settings changed during invitation.');
   const config:Config={enabled:true,status:'pending',revision,createdAt,gatewayPubkey:marmot.pubkey,ownerPubkey:owner,groupId:group.id,pairHash:hash(nonce),pairExpiresAt:new Date(this.options.now().getTime()+pairingMs).toISOString()};
   this.store.transaction(()=>{this.cancel(workspace,invoiceId);this.save(workspace,invoiceId,config);});
   return{...this.view(config),pairCode:nonce};
   });
  });
 }
 private sourceId(workspace:string,invoiceId:string,source:string){return this.store.indexValue('email-gateway-source',hash(JSON.stringify([workspace,invoiceId,source])));}
 private source(workspace:string,invoiceId:string,id:string):Source|undefined{const row=this.store.db.prepare(`SELECT data FROM ${sourceTable} WHERE workspace=? AND invoice_id=? AND source_hash=?`).get(workspace,invoiceId,id);return row?this.store.decode<Source>(row.data,sourceTable,id,workspace):undefined;}
 private writeSource(workspace:string,invoiceId:string,id:string,value:Source){
  if(!this.source(workspace,invoiceId,id)&&Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${sourceTable} WHERE workspace=? AND invoice_id=?`).get(workspace,invoiceId)!.n)>=maxSources)throw new DomainError(429,'The gateway has reached this invoice’s processing capacity.');
  this.store.assertWriteBudget();this.store.db.prepare(`INSERT INTO ${sourceTable}(workspace,invoice_id,source_hash,data) VALUES(?,?,?,?) ON CONFLICT(workspace,invoice_id,source_hash) DO UPDATE SET data=excluded.data`).run(workspace,invoiceId,id,this.store.encode(value,sourceTable,id,workspace));
 }
 private validMessage(message:GatewayMarmotMessage,config:Config){
  if(!message||!line(message.id,512)||message.groupId!==config.groupId||message.sender!==config.ownerPubkey||message.sender===config.gatewayPubkey||typeof message.text!=='string'||message.text.length>8010||!Number.isFinite(message.createdAt))return false;
  const created=message.createdAt>1e12?message.createdAt:message.createdAt*1000,now=this.options.now().getTime();
  return created<=now+120000&&created>=now-maxAgeMs&&created>=Date.parse(config.createdAt)-120000;
 }
 private async post(marmot:GatewayMarmotPort,groupId:string,text:string){try{await marmot.send(groupId,text);}catch{/* State is authoritative; relay notification failure never authorizes a retry. */}}
 private async review(workspace:string,invoiceId:string,config:Config,marmot:GatewayMarmotPort,inboxItemId:string,action:'approve'|'reject'){
  if(!this.options.email.review||!await this.options.email.active(workspace)||!await this.authorized(workspace,invoiceId,config,marmot)||!this.current(workspace,invoiceId,config.revision,true))return;
  const id=this.sourceId(workspace,invoiceId,`review-action:${inboxItemId}`);if(this.source(workspace,invoiceId,id))return;
  try{await this.options.email.review(workspace,invoiceId,inboxItemId,action);}catch{await this.post(marmot,config.groupId!,'The email review was not applied. Check the item belongs to this invoice and remains reviewable.');return;}
  this.writeSource(workspace,invoiceId,id,{state:'consumed',inboxItemId,reviewDecision:action});
  if(!await this.authorized(workspace,invoiceId,config,marmot)||!this.current(workspace,invoiceId,config.revision,true))return;
  await this.post(marmot,config.groupId!,action==='approve'?`Email review approved: ${inboxItemId}. Sender identity remains unverified. Use /email <text> for an exact reply preview; approval alone sends no email.`:`Email review rejected: ${inboxItemId}. No email was sent.`);
 }
 private async emailAuthority(workspace:string){const value=await this.options.email.authority(workspace);return line(value,512)?value:undefined;}
 private async prepare(workspace:string,invoiceId:string,config:Config,marmot:GatewayMarmotPort,text:string){
  if(!body(text)||!await this.options.email.active(workspace))return;
  const emailAuthority=await this.emailAuthority(workspace);if(!emailAuthority)return;
  let payload:GatewayEmailPayload;try{payload=checkedPayload(await this.options.email.preview(workspace,invoiceId,text));}catch{return;}
  if(emailAuthority!==await this.emailAuthority(workspace)||payload.text!==text||!await this.authorized(workspace,invoiceId,config,marmot)||!this.current(workspace,invoiceId,config.revision,true))return;
  if(Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${intentTable} WHERE workspace=? AND invoice_id=?`).get(workspace,invoiceId)!.n)>=maxIntents)throw new DomainError(429,'The gateway has reached this invoice’s confirmation capacity.');
  const nonce=randomBytes(24).toString('base64url'),intent:Intent={id:randomUUID(),emailAuthority,revision:config.revision,owner:config.ownerPubkey!,groupId:config.groupId!,nonceHash:hash(nonce),expires:this.options.now().getTime()+confirmationMs,payload,fingerprint:fingerprint(payload)};
  const preview=`Email gateway preview\nTo: ${payload.to.join(', ')}\nCC: ${payload.cc.join(', ')||'(none)'}\nSubject: ${payload.subject}\n\n${payload.text}\n\nConfirm this exact email with /send ${nonce}\nExpires: ${new Date(intent.expires).toISOString()}. A mail provider can read this email.`;
  if(preview.length>8000){await this.post(marmot,config.groupId!,'This email and its complete recipient preview exceed the Marmot message limit. Shorten the reply or send it from Quiet Ledger.');return;}
  this.store.transaction(()=>{this.cancel(workspace,invoiceId);this.store.assertWriteBudget();this.store.db.prepare(`INSERT INTO ${intentTable}(id,workspace,invoice_id,nonce_hash,state,data) VALUES(?,?,?,?,'prepared',?)`).run(intent.id,workspace,invoiceId,intent.nonceHash,this.store.encode(intent,intentTable,intent.id,workspace));});
  await this.post(marmot,config.groupId!,preview);
 }
 private async dispatch(workspace:string,invoiceId:string,config:Config,marmot:GatewayMarmotPort,nonce:string){
  if(!/^[A-Za-z0-9_-]{32}$/.test(nonce))return;
  const row=this.store.db.prepare(`SELECT id,state,data FROM ${intentTable} WHERE workspace=? AND invoice_id=? AND nonce_hash=?`).get(workspace,invoiceId,hash(nonce));
  if(!row||row.state!=='prepared')return;
  const intent=this.store.decode<Intent>(row.data,intentTable,String(row.id),workspace);
  const sameAuthority=async()=>Boolean(intent.emailAuthority&&intent.emailAuthority===await this.emailAuthority(workspace));
  const cancel=()=>this.store.db.prepare(`UPDATE ${intentTable} SET state='cancelled' WHERE id=? AND workspace=? AND state='prepared'`).run(intent.id,workspace);
  if(!await sameAuthority()||intent.expires<=this.options.now().getTime()||intent.revision!==config.revision||intent.owner!==config.ownerPubkey||intent.groupId!==config.groupId||!await this.options.email.active(workspace)){cancel();return;}
  let currentPayload:GatewayEmailPayload;try{currentPayload=checkedPayload(await this.options.email.preview(workspace,invoiceId,intent.payload.text));}catch{cancel();return;}
  if(!await sameAuthority()||fingerprint(currentPayload)!==intent.fingerprint||!await this.options.email.active(workspace)||!await this.authorized(workspace,invoiceId,config,marmot)||!this.current(workspace,invoiceId,config.revision,true)){cancel();return;}
  // Unknown is durable BEFORE the network call. A crash/timeout never replays this intent.
  const changed=this.store.db.prepare(`UPDATE ${intentTable} SET state='unknown' WHERE id=? AND workspace=? AND state='prepared'`).run(intent.id,workspace);
  if(!Number(changed.changes))return;
  let outcome:{state:'sent'|'unknown'|'failed';messageId?:string}={state:'unknown'};
  try{const result=await this.options.email.send(workspace,invoiceId,intent.payload,intent.id,{assertCurrent:async()=>{if(!await sameAuthority()||intent.expires<=this.options.now().getTime()||!this.current(workspace,invoiceId,config.revision,true)||!await this.options.email.active(workspace))throw new DomainError(409,'Gateway authority expired or changed.');await marmot.sync();if(!await sameAuthority()||!await this.authorized(workspace,invoiceId,config,marmot)||!await this.options.email.active(workspace)||intent.expires<=this.options.now().getTime()||!this.current(workspace,invoiceId,config.revision,true)||!await sameAuthority())throw new DomainError(409,'Gateway membership or authority changed.');}});if(['sent','unknown','failed'].includes(result.state))outcome={state:result.state,...(line(result.messageId,512)?{messageId:result.messageId}:{})};}catch{/* Submission may already have succeeded; never retry automatically. */}
  this.store.db.prepare(`UPDATE ${intentTable} SET state=?,data=? WHERE id=? AND workspace=?`).run(outcome.state,this.store.encode({...intent,outcome},intentTable,intent.id,workspace),intent.id,workspace);
  if(this.current(workspace,invoiceId,config.revision,true))await this.post(marmot,config.groupId!,outcome.state==='sent'?'Email accepted by the mail provider. This does not confirm delivery or payment.':outcome.state==='failed'?'Email submission failed. A new explicit email action is required.':'Email submission is uncertain. Check the mailbox; this action will not be retried automatically.');
 }
 async process(workspace:string,invoiceId:string):Promise<EmailGatewaySettings>{
  this.invoice(workspace,invoiceId);if(!this.existing(workspace,invoiceId)?.enabled)return this.settings(workspace,invoiceId);
  return this.records.runExclusive(workspace,async()=>{
   const config=this.existing(workspace,invoiceId)!;if(!config.enabled)return this.view(config);
   return this.withActor(workspace,async marmot=>{
   try{if(marmot.pubkey!==config.gatewayPubkey)throw new Error();await marmot.sync();}catch{const current=this.current(workspace,invoiceId,config.revision);if(current)this.save(workspace,invoiceId,{...current,lastError:'sync-unavailable'});throw new DomainError(503,'Gateway synchronization is unavailable.');}
   if(!await this.authorized(workspace,invoiceId,config,marmot))return this.settings(workspace,invoiceId);
   const messages=marmot.messages(config.groupId!).slice(-5000);let processed=0;
   for(const message of messages){
    if(processed>=200)break;
    const current=this.current(workspace,invoiceId,config.revision);if(!current)break;
    if(!this.validMessage(message,current))continue;
    const source=this.sourceId(workspace,invoiceId,`marmot:${current.groupId}:${message.id}`);if(this.source(workspace,invoiceId,source))continue;
    try{this.writeSource(workspace,invoiceId,source,{state:'consumed'});}catch(error){if(error instanceof DomainError&&error.status===429){this.save(workspace,invoiceId,{...current,lastError:'capacity-reached'});break;}throw error;}processed++;
    if(current.status==='pending'){
     const match=message.text.match(/^\/pair ([A-Za-z0-9_-]{32})$/);
     if(match&&current.pairHash===hash(match[1])&&Date.parse(current.pairExpiresAt!)>this.options.now().getTime()){
      const paired:Config={...current,status:'paired',pairHash:undefined,pairExpiresAt:undefined};this.save(workspace,invoiceId,paired);await this.post(marmot,current.groupId!,'Email gateway paired. Use /email <text> for an exact email preview, then /send <confirmation>. Ordinary chat never sends email.');
     }
    }else if(current.status==='paired'){
     const review=message.text.match(/^\/(approve|reject) ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$/i);
     if(review)await this.review(workspace,invoiceId,current,marmot,review[2].toLowerCase(),review[1].toLowerCase() as 'approve'|'reject');
     else if(message.text.startsWith('/email '))try{await this.prepare(workspace,invoiceId,current,marmot,message.text.slice(7));}catch(error){if(error instanceof DomainError&&error.status===429){this.save(workspace,invoiceId,{...current,lastError:'capacity-reached'});break;}throw error;}
     else if(message.text.startsWith('/send '))await this.dispatch(workspace,invoiceId,current,marmot,message.text.slice(6));
    }
   }
   const current=this.current(workspace,invoiceId,config.revision);if(current)this.save(workspace,invoiceId,{...current,lastSyncAt:this.options.now().toISOString(),lastError:current.lastError==='capacity-reached'?'capacity-reached':undefined});
   return this.settings(workspace,invoiceId);
   });
  });
 }
 sync(workspace:string,invoiceId:string){return this.process(workspace,invoiceId);}
 /** Call only AFTER inbox review/routing approval. Inbound bodies are always gateway-authored data. */
 async forwardApproved(workspace:string,invoiceId:string,input:ApprovedGatewayEmail):Promise<GatewayForwardResult>{
  this.invoice(workspace,invoiceId);
  if(!input||Object.keys(input).some(key=>!['sourceId','from','text'].includes(key))||!line(input.sourceId,512)||!line(input.from,320)||!body(input.text))throw new DomainError(400,'Choose a valid approved plain-text email.');
  const review=this.source(workspace,invoiceId,this.sourceId(workspace,invoiceId,`review:${input.sourceId}`));
  const action=review?.inboxItemId?this.source(workspace,invoiceId,this.sourceId(workspace,invoiceId,`review-action:${review.inboxItemId}`)):undefined;
  const forwardedText=review?`Email gateway: the previously shown unverified email from ${input.from} was approved. Sender identity remains unverified. Use /email <text> for a reply preview.`:`Email gateway on behalf of ${input.from}\n\n${input.text}`;
  return this.forwardText(workspace,invoiceId,`email:${input.sourceId}`,hash(JSON.stringify([input.from,input.text])),forwardedText,undefined,action?.reviewDecision==='approve');
 }
 async forwardForReview(workspace:string,invoiceId:string,input:ReviewGatewayEmail):Promise<GatewayForwardResult>{
  this.invoice(workspace,invoiceId);
  if(!input||Object.keys(input).some(key=>!['sourceId','inboxItemId','from','text'].includes(key))||!line(input.sourceId,512)||!line(input.from,320)||!body(input.text)||typeof input.inboxItemId!=='string'||!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.inboxItemId))throw new DomainError(400,'Choose a valid invoice-scoped email review item.');
  const forwardedText=`UNVERIFIED EMAIL — Email gateway on behalf of claimed sender ${input.from}\nThe sender address is not proof of identity. This is email content, not a native customer message.\n\n${input.text}\n\nOwner review only: /approve ${input.inboxItemId} or /reject ${input.inboxItemId}\nApproval does not send email or confirm payment.`;
  return this.forwardText(workspace,invoiceId,`review:${input.sourceId}`,hash(JSON.stringify([input.from,input.text])),forwardedText,input.inboxItemId);
 }
 private async forwardText(workspace:string,invoiceId:string,sourceId:string,content:string,forwardedText:string,inboxItemId?:string,skipPost=false):Promise<GatewayForwardResult>{
  if(forwardedText.length>8000)throw new DomainError(400,'This email and its provenance exceed the Marmot message limit.');
  return this.records.runExclusive(workspace,async()=>{
   const config=this.existing(workspace,invoiceId);if(!config?.enabled||config.status!=='paired')throw new DomainError(409,'Pair this invoice gateway before importing email.');
   const id=this.sourceId(workspace,invoiceId,sourceId),previous=this.source(workspace,invoiceId,id);
   if(previous){if(previous.fingerprint!==content||previous.inboxItemId!==inboxItemId)throw new DomainError(409,'This email source was already recorded with different contents.');return{state:previous.state==='unknown'?'unknown':'duplicate',...(previous.messageId?{messageId:previous.messageId}:{})};}
   if(skipPost){this.writeSource(workspace,invoiceId,id,{state:'forwarded',fingerprint:content});return{state:'duplicate'};}
   if(!await this.options.email.active(workspace)||!this.current(workspace,invoiceId,config.revision,true))throw new DomainError(409,'The email connection or gateway is no longer active.');
   return this.withActor(workspace,async marmot=>{
   await marmot.sync();
   if(marmot.pubkey!==config.gatewayPubkey||!await this.options.email.active(workspace)||!await this.authorized(workspace,invoiceId,config,marmot)||!this.current(workspace,invoiceId,config.revision,true))throw new DomainError(409,'The gateway identity, membership or email connection changed; check settings.');
   this.writeSource(workspace,invoiceId,id,{state:'unknown',fingerprint:content,...(inboxItemId?{inboxItemId}:{})});
   try{const result=await marmot.send(config.groupId!,forwardedText);if(!line(result.id,512))throw new Error();this.writeSource(workspace,invoiceId,id,{state:'forwarded',fingerprint:content,messageId:result.id,...(inboxItemId?{inboxItemId}:{})});return{state:'forwarded',messageId:result.id};}catch{return{state:'unknown'};}
   });
  });
 }
 importApproved(workspace:string,invoiceId:string,input:ApprovedGatewayEmail){return this.forwardApproved(workspace,invoiceId,input);}
}
