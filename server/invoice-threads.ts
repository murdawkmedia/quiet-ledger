import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {InvoiceThread,ThreadMessage,ThreadPage} from '../shared/invoice-threads.js';
import {DomainError,Store,hash} from './store.js';

const threadTable='invoice_threads',messageTable='invoice_thread_messages',cursorContext='invoice_thread_cursor';
const maxMessages=5000;
const wellFormed=(value:string)=>Buffer.from(value,'utf8').toString('utf8')===value;
const singleLine=(max:number)=>z.string().max(max).refine(value=>wellFormed(value)&&!/[\u0000-\u001f\u007f-\u009f]/.test(value)&&value.trim().length>0);
const uuid=z.uuid().transform(value=>value.toLowerCase());
const workspaceSchema=singleLine(512);
const messageSchema=z.object({
 channel:z.enum(['dashboard','email','marmot']),
 direction:z.enum(['inbound','outbound','internal']),
 author:singleLine(120).transform(value=>value.trim()),
 text:z.string().max(16000).transform(value=>value.replace(/\r\n/g,'\n')).pipe(z.string().min(1).max(8000).refine(value=>wellFormed(value)&&value.trim().length>0&&!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value))),
 parentId:uuid.optional(),
 sourceId:singleLine(512).optional(),
 state:z.enum(['recorded','pending','sent','failed','unknown']).default('recorded'),
}).strict();
const pageSchema=z.object({cursor:z.string().min(1).max(1024).regex(/^[A-Za-z0-9_-]+$/).optional(),limit:z.number().int().min(1).max(100).default(50)}).strict();
const cursorSchema=z.object({version:z.literal(1),threadId:uuid,sequence:z.number().int().min(1).max(maxMessages)}).strict();
function parsed<T>(schema:z.ZodType<T>,value:unknown,message:string):T {
 const result=schema.safeParse(value);
 if(!result.success)throw new DomainError(400,message);
 return result.data;
}

/** Internal persistence service. Browser routes and transport adapters establish author/send authority. */
export class InvoiceThreads {
 constructor(private store:Store,private now:()=>Date){
  store.db.exec(`
   CREATE TABLE IF NOT EXISTS ${threadTable}(
    id TEXT PRIMARY KEY,workspace TEXT NOT NULL,
    invoice_id TEXT NOT NULL UNIQUE REFERENCES invoices(id),data TEXT NOT NULL,
    UNIQUE(id,workspace)
   );
   CREATE INDEX IF NOT EXISTS invoice_threads_workspace ON ${threadTable}(workspace,invoice_id);
   CREATE TABLE IF NOT EXISTS ${messageTable}(
    id TEXT PRIMARY KEY,workspace TEXT NOT NULL,thread_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK(sequence BETWEEN 1 AND 5000),
    source_id_hash TEXT,data TEXT NOT NULL,
    FOREIGN KEY(thread_id,workspace) REFERENCES ${threadTable}(id,workspace),
    UNIQUE(workspace,thread_id,sequence),UNIQUE(workspace,thread_id,source_id_hash)
   );
  `);
 }

 private invoice(workspace:string,invoiceId:string):string {
  parsed(workspaceSchema,workspace,'Invalid workspace.');
  const id=parsed(uuid,invoiceId,'A valid invoice ID is required.');
  if(!this.store.getInvoice(id,workspace))throw new DomainError(404,'Invoice not found.');
  return id;
 }

 private existing(workspace:string,invoiceId:string):InvoiceThread|undefined {
  const row=this.store.db.prepare(`SELECT id,data FROM ${threadTable} WHERE workspace=? AND invoice_id=?`).get(workspace,invoiceId);
  return row?this.store.decode<InvoiceThread>(row.data,threadTable,String(row.id),workspace):undefined;
 }

 private create(workspace:string,invoiceId:string):InvoiceThread {
  const existing=this.existing(workspace,invoiceId);
  if(existing)return existing;
  this.store.assertWriteBudget();
  const timestamp=this.now().toISOString(),thread:InvoiceThread={id:randomUUID(),invoiceId,createdAt:timestamp,updatedAt:timestamp};
  this.store.db.prepare(`INSERT INTO ${threadTable}(id,workspace,invoice_id,data) VALUES(?,?,?,?)`).run(thread.id,workspace,invoiceId,this.store.encode(thread,threadTable,thread.id,workspace));
  return thread;
 }

 getOrCreate(workspace:string,invoiceId:string):InvoiceThread {
  return this.store.transaction(()=>this.create(workspace,this.invoice(workspace,invoiceId)));
 }

 private sequence(workspace:string,threadId:string,cursor?:string):number {
  if(cursor===undefined)return 0;
  try{
   const bytes=Buffer.from(cursor,'base64url');
   if(bytes.toString('base64url')!==cursor)throw new Error();
   const value=cursorSchema.parse(this.store.decode(bytes.toString('utf8'),cursorContext,threadId,workspace));
   if(value.threadId!==threadId)throw new Error();
   return value.sequence;
  }catch{throw new DomainError(400,'This thread cursor is invalid.');}
 }

 list(workspace:string,invoiceId:string,options:{cursor?:string;limit?:number}={}):ThreadPage {
  return this.store.transaction(()=>{
   const id=this.invoice(workspace,invoiceId),input=parsed(pageSchema,options,'Choose a valid thread cursor and a page size from one to one hundred.');
   const thread=this.existing(workspace,id);
   if(!thread)throw new DomainError(404,'Invoice thread not found.');
   const after=this.sequence(workspace,thread.id,input.cursor);
   const rows=this.store.db.prepare(`SELECT id,sequence,data FROM ${messageTable} WHERE workspace=? AND thread_id=? AND sequence>? ORDER BY sequence ASC LIMIT ?`).all(workspace,thread.id,after,input.limit+1);
   const page=rows.slice(0,input.limit),messages=page.map(row=>this.store.decode<ThreadMessage>(row.data,messageTable,String(row.id),workspace));
   const nextCursor=rows.length>input.limit?Buffer.from(this.store.encode({version:1,threadId:thread.id,sequence:Number(page.at(-1)!.sequence)},cursorContext,thread.id,workspace)).toString('base64url'):undefined;
   return{thread,messages,...(nextCursor?{nextCursor}:{})};
  });
 }

 append(workspace:string,invoiceId:string,input:unknown):ThreadMessage {
  return this.store.transaction(()=>{
   const id=this.invoice(workspace,invoiceId),value=parsed(messageSchema,input,'Check the thread channel, author, message, identifiers and delivery state.');
   const thread=this.create(workspace,id);
   if(value.parentId&&!this.store.db.prepare(`SELECT 1 FROM ${messageTable} WHERE id=? AND workspace=? AND thread_id=?`).get(value.parentId,workspace,thread.id))throw new DomainError(404,'Parent message not found in this invoice thread.');
   const sourceIndex=value.sourceId===undefined?null:this.store.indexValue('invoice-thread-source',hash(JSON.stringify([workspace,thread.id,value.channel,value.sourceId])));
   if(sourceIndex!==null){
    const row=this.store.db.prepare(`SELECT id,data FROM ${messageTable} WHERE workspace=? AND thread_id=? AND source_id_hash=?`).get(workspace,thread.id,sourceIndex);
    if(row){
     const previous=this.store.decode<ThreadMessage>(row.data,messageTable,String(row.id),workspace);
     const same=previous.channel===value.channel&&previous.direction===value.direction&&previous.author===value.author&&previous.text===value.text&&previous.parentId===value.parentId&&previous.state===value.state&&previous.sourceId===value.sourceId;
     if(!same)throw new DomainError(409,'This source ID was already recorded with different message content.');
     return previous;
    }
   }
   const count=this.store.db.prepare(`SELECT COUNT(*) n,COALESCE(MAX(sequence),0) last FROM ${messageTable} WHERE workspace=? AND thread_id=?`).get(workspace,thread.id)!;
   if(Number(count.n)>=maxMessages)throw new DomainError(429,'This invoice thread has reached its five-thousand message limit. Existing messages remain available.');
   this.store.assertWriteBudget();
   const timestamp=this.now().toISOString(),message:ThreadMessage={...value,id:randomUUID(),threadId:thread.id,createdAt:timestamp};
   this.store.db.prepare(`INSERT INTO ${messageTable}(id,workspace,thread_id,sequence,source_id_hash,data) VALUES(?,?,?,?,?,?)`).run(message.id,workspace,thread.id,Number(count.last)+1,sourceIndex,this.store.encode(message,messageTable,message.id,workspace));
   thread.updatedAt=timestamp;
   this.store.db.prepare(`UPDATE ${threadTable} SET data=? WHERE id=? AND workspace=?`).run(this.store.encode(thread,threadTable,thread.id,workspace),thread.id,workspace);
   return message;
  });
 }
}
