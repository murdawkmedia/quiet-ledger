import {ImapFlow,type ImapFlowOptions,type MessageStructureObject} from 'imapflow';
import {simpleParser,type AddressObject} from 'mailparser';
import {z} from 'zod';
import type {InvoiceGmailCredentials} from './invoice-delivery.js';
import {invoiceMailThreadHeaders} from './invoice-delivery.js';
import {hash} from './store.js';

export const mailboxLimits={headerBytes:16384,bodyBytes:32768,bodyCharacters:8000,uidSpan:25} as const;
export interface MailboxHeader {
 uid:number;providerId:string;fingerprint:string;messageId?:string;inReplyTo?:string;references:string[];
 from:string[];to:string[];cc:string[];replyTo:string[];subject?:string;size:number;
 plainPart?:string;plainBytes?:number;hasAttachments:boolean;malformed:boolean;automated:boolean;
}
export interface InvoiceMailbox {
 open(folder:string):Promise<{uidValidity:string;uidNext:number}>;
 headers(fromUid:number,throughUid:number):Promise<MailboxHeader[]>;
 readText(uid:number,part:string):Promise<{text:string;truncated:boolean}>;
 close():void;
}
export type GmailImapClient=Pick<ImapFlow,'connect'|'mailboxOpen'|'fetchAll'|'download'|'close'|'on'>;
export interface GmailMailboxOptions {signal:AbortSignal;clientFactory?:(options:ImapFlowOptions)=>GmailImapClient}
const email=z.email().max(254);
const cleanLine=(text:string,max:number)=>text.replace(/[\u0000-\u001f\u007f-\u009f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const validUid=(value:number)=>Number.isSafeInteger(value)&&value>=1&&value<=4294967295;
function structure(root:MessageStructureObject|undefined):{plainPart?:string;plainBytes?:number;hasAttachments:boolean;malformed:boolean}{
 let plainPart:string|undefined,plainBytes:number|undefined,hasAttachments=false,nodes=0,malformed=false;
 function visit(node:MessageStructureObject,depth:number){
  if(++nodes>100||depth>10){malformed=true;return;}
  const type=node.type?.toLowerCase(),attachment=node.disposition?.toLowerCase()==='attachment'||!!node.dispositionParameters?.filename||!!node.parameters?.name;
  if(attachment||type==='message/rfc822'){hasAttachments=true;return;}
  if(node.childNodes){for(const child of node.childNodes)visit(child,depth+1);return;}
  if(type==='text/plain'&&!plainPart){const part=node.part??'1';if(!/^\d+(?:\.\d+)*$/.test(part)){malformed=true;return;}plainPart=part;plainBytes=node.size;}
  else if(type!=='text/html'&&type!=='text/plain')hasAttachments=true;
 }
 if(root)visit(root,0);else malformed=true;
 return{...(plainPart?{plainPart}:{}),...(plainBytes!==undefined?{plainBytes}:{}),hasAttachments,malformed};
}

/** Read-only Gmail pilot adapter. Auth headers are deliberately never promoted to identity evidence. */
export function createGmailMailbox(credentials:InvoiceGmailCredentials,options:GmailMailboxOptions):InvoiceMailbox {
 const client=(options.clientFactory??(value=>new ImapFlow(value)))({host:'imap.gmail.com',port:993,secure:true,servername:'imap.gmail.com',auth:{user:credentials.senderEmail,pass:credentials.appPassword},tls:{minVersion:'TLSv1.2',rejectUnauthorized:true},logger:false,logRaw:false,emitLogs:false,disableAutoIdle:true,disableCompression:true,connectionTimeout:6000,greetingTimeout:6000,socketTimeout:8000,maxLiteralSize:65536,maxLineLength:65536,maxResponseSize:262144,maxResponseTokens:10000});
 let closed=false,validity='';const parts=new Map<number,string>();
 const check=()=>{if(closed||options.signal.aborted)throw new Error('Mailbox read cancelled.');};
 const close=()=>{if(!closed){closed=true;options.signal.removeEventListener('abort',close);client.close();}};
 client.on('error',()=>{/* The service records only a fixed error code. */});options.signal.addEventListener('abort',close,{once:true});
 if(options.signal.aborted)close();
 return{
  async open(folder){check();await client.connect();check();const box=await client.mailboxOpen(folder,{readOnly:true});check();validity=String(box.uidValidity);if(!/^\d{1,20}$/.test(validity)||!validUid(box.uidNext))throw new Error('Invalid mailbox state.');return{uidValidity:validity,uidNext:box.uidNext};},
  async headers(fromUid,throughUid){
   check();if(!validUid(fromUid)||!validUid(throughUid)||throughUid<fromUid||throughUid-fromUid>=mailboxLimits.uidSpan)throw new Error('Mailbox range exceeds its limit.');
   const rows=await client.fetchAll(`${fromUid}:${throughUid}`,{uid:true,size:true,flags:true,bodyStructure:true,bodyParts:[{key:'HEADER',start:0,maxLength:mailboxLimits.headerBytes+1}]},{uid:true});check();
   if(rows.length>mailboxLimits.uidSpan)throw new Error('Too many mailbox headers.');
   const result:MailboxHeader[]=[];parts.clear();
   for(const row of rows){
    if(!validUid(row.uid)||row.uid<fromUid||row.uid>throughUid)throw new Error('Unexpected mailbox UID.');
    const raw=row.bodyParts?.get('header')??Buffer.alloc(0),body=structure(row.bodyStructure),providerId=row.emailId??row.id??`uid:${validity}:${row.uid}`;
    if(typeof providerId!=='string'||!providerId.length||providerId.length>254||/[\u0000-\u001f\u007f]/.test(providerId))throw new Error('Invalid provider message ID.');
    const header:MailboxHeader={uid:row.uid,providerId,fingerprint:hash(raw.toString('base64')),references:[],from:[],to:[],cc:[],replyTo:[],size:row.size??0,...body,malformed:body.malformed||!raw.length||raw.length>mailboxLimits.headerBytes,automated:false};
    if(raw.length&&raw.length<=mailboxLimits.headerBytes){
     try{
      const parsed=await simpleParser(raw,{skipHtmlToText:true,skipTextToHtml:true,skipImageLinks:true,skipTextLinks:true});check();
      const counts=new Map<string,number>();for(const line of parsed.headerLines)counts.set(line.key,(counts.get(line.key)??0)+1);
      if(['from','to','cc','reply-to','message-id','in-reply-to','references'].some(key=>(counts.get(key)??0)>1))header.malformed=true;
      const addresses=(values:AddressObject|AddressObject[]|undefined)=>{
       const result:string[]=[];for(const group of values===undefined?[]:Array.isArray(values)?values:[values])for(const value of group.value){const address=email.safeParse(value.address);if(!address.success||result.length>=32)header.malformed=true;else result.push(address.data.toLowerCase());}return result;
      };
      header.from=addresses(parsed.from);header.to=addresses(parsed.to);header.cc=addresses(parsed.cc);header.replyTo=addresses(parsed.replyTo);
      if(parsed.messageId){invoiceMailThreadHeaders({inReplyTo:parsed.messageId});header.messageId=parsed.messageId;}else header.malformed=true;
      const references=parsed.references===undefined?[]:Array.isArray(parsed.references)?parsed.references:[parsed.references];
      const safe=invoiceMailThreadHeaders({...(parsed.inReplyTo?{inReplyTo:parsed.inReplyTo}:{}),...(references.length?{references}:{})});header.references=safe.references??[];header.inReplyTo=safe.inReplyTo;
      if(parsed.subject)header.subject=cleanLine(parsed.subject,200);
      const auto=parsed.headers.get('auto-submitted'),precedence=parsed.headers.get('precedence');header.automated=(auto!==undefined&&String(auto).trim().toLowerCase()!=='no')||/^(bulk|junk|list)$/i.test(String(precedence??'').trim())||row.flags?.has('\\Deleted')===true;
     }catch{check();header.malformed=true;}
    }
    if(header.plainPart&&!header.malformed)parts.set(row.uid,header.plainPart);result.push(header);
   }
   return result.sort((a,b)=>a.uid-b.uid);
  },
  async readText(uid,part){
   check();if(parts.get(uid)!==part)throw new Error('Only the selected inline plain text part may be read.');
   const body=await client.download(String(uid),part,{uid:true,maxBytes:mailboxLimits.bodyBytes+1,chunkSize:4096});check();if(!body.content)throw new Error('The selected mail body disappeared.');
   if(body.meta.contentType?.toLowerCase()!=='text/plain'||body.meta.disposition==='attachment'||body.meta.filename){body.content.destroy();throw new Error('The selected mail body changed type.');}
   const chunks:Buffer[]=[];let length=0,truncated=false;
   for await(const value of body.content){check();const chunk=Buffer.isBuffer(value)?value:Buffer.from(value);length+=chunk.length;if(length>mailboxLimits.bodyBytes){truncated=true;body.content.destroy();break;}chunks.push(chunk);}
   check();return{text:Buffer.concat(chunks).toString('utf8'),truncated};
  },close
 };
}
