import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {Invoice} from '../shared/contracts.js';
import type {InvoiceTemplate} from '../shared/invoice-options.js';
import {paymentDueDate} from '../shared/payment-terms.js';
import {occurrenceDate,type RecurringPlan,type RecurringDraft,type RecurringPrepareResult} from '../shared/recurring.js';
import {createInvoice,invoiceSchema,parse} from './domain.js';
import {Store,DomainError,hash} from './store.js';

export const RECURRING_LIMITS={plans:100,drafts:500,prepareBatch:24} as const;
const plansTable='recurring_plans',draftsTable='recurring_drafts';
const dateSchema=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{try{return paymentDueDate(value,0)===value;}catch{return false;}},'Enter a valid calendar date.');
const frequencySchema=z.discriminatedUnion('type',[z.object({type:z.literal('monthly')}).strict(),z.object({type:z.literal('days'),intervalDays:z.number().int().min(1).max(3650)}).strict()]);
const createSchema=z.object({templateId:z.string().uuid(),label:z.string().trim().min(1).max(80),startDate:dateSchema,frequency:frequencySchema,dueOffsetDays:z.number().int().min(0).max(3650).optional()}).strict();
interface StoredDraft extends RecurringDraft {issuedInputFingerprint?:string;issuedInvoice?:Invoice}
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)??'null';}
function retryKey(value:string|undefined){if(!value||!(/^[A-Za-z0-9._:-]{1,128}$/).test(value))throw new DomainError(400,'A valid Idempotency-Key header is required.');return value;}
function publicDraft(value:StoredDraft):RecurringDraft {const {issuedInputFingerprint:_,issuedInvoice:__,...draft}=value;return draft;}

export class RecurringDrafts {
 constructor(private store:Store,private now:()=>Date){store.db.exec(`
  CREATE TABLE IF NOT EXISTS ${plansTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,data TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS recurring_plans_workspace ON ${plansTable}(workspace);
  CREATE TABLE IF NOT EXISTS ${draftsTable}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,plan_id TEXT NOT NULL REFERENCES ${plansTable}(id),period_index INTEGER NOT NULL,invoice_id TEXT UNIQUE REFERENCES invoices(id),data TEXT NOT NULL,UNIQUE(plan_id,period_index));
  CREATE INDEX IF NOT EXISTS recurring_drafts_workspace ON ${draftsTable}(workspace);
 `);}
 listPlans(workspace:string):RecurringPlan[]{return this.store.db.prepare(`SELECT id,data FROM ${plansTable} WHERE workspace=? ORDER BY rowid DESC LIMIT ${RECURRING_LIMITS.plans}`).all(workspace).map(row=>this.store.decode(row.data,plansTable,String(row.id),workspace));}
 listDrafts(workspace:string):RecurringDraft[]{return this.store.db.prepare(`SELECT id,data FROM ${draftsTable} WHERE workspace=? ORDER BY rowid DESC LIMIT ${RECURRING_LIMITS.drafts}`).all(workspace).map(row=>publicDraft(this.store.decode<StoredDraft>(row.data,draftsTable,String(row.id),workspace)));}
 private storedDraft(workspace:string,id:string):StoredDraft {const row=this.store.db.prepare(`SELECT data FROM ${draftsTable} WHERE id=? AND workspace=?`).get(id,workspace);if(!row)throw new DomainError(404,'Recurring draft not found.');return this.store.decode(row.data,draftsTable,id,workspace);}
 getDraft(workspace:string,id:string):RecurringDraft{return publicDraft(this.storedDraft(workspace,id));}
 createPlan(workspace:string,body:unknown,key:string|undefined){const input=parse(createSchema,body);return this.store.idempotent('recurring-plan:'+workspace,key,input,201,()=>{
  const templateRow=this.store.db.prepare('SELECT data FROM invoice_templates WHERE id=? AND workspace=?').get(input.templateId,workspace);if(!templateRow)throw new DomainError(404,'Invoice template not found.');
  const template=this.store.decode<InvoiceTemplate>(templateRow.data,'invoice_templates',input.templateId,workspace),snapshot=parse(invoiceSchema,template.draft);
  if(snapshot.paymentTermDays!==undefined&&input.dueOffsetDays!==undefined)throw new DomainError(400,'This template already has relative payment terms. Use its saved terms or edit the template.');
  if(snapshot.paymentTermDays===undefined&&snapshot.dueDate&&input.dueOffsetDays===undefined)throw new DomainError(400,'This template has an absolute due date. Choose an explicit number of days after each period to convert it.');
  const dueOffsetDays=snapshot.paymentTermDays??input.dueOffsetDays;
  if(dueOffsetDays!==undefined){try{paymentDueDate(input.startDate,dueOffsetDays);}catch{throw new DomainError(400,'The first due date is outside the supported calendar.');}}
  if(Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${plansTable} WHERE workspace=?`).get(workspace)!.n)>=RECURRING_LIMITS.plans)throw new DomainError(429,'This workspace has reached its recurring plan limit.');
  const timestamp=this.now().toISOString(),plan:RecurringPlan={id:randomUUID(),label:input.label,templateId:template.id,templateLabel:template.label,templateDraft:snapshot,startDate:input.startDate,frequency:input.frequency,...(dueOffsetDays!==undefined?{dueOffsetDays}:{}),paused:false,createdAt:timestamp,updatedAt:timestamp};
  this.store.db.prepare(`INSERT INTO ${plansTable}(id,workspace,data) VALUES(?,?,?)`).run(plan.id,workspace,this.store.encode(plan,plansTable,plan.id,workspace));return {plan};
 });}
 pause(workspace:string,id:string,body:unknown,key:string|undefined){const input=parse(z.object({paused:z.boolean()}).strict(),body);return this.store.idempotent('recurring-pause:'+workspace,key,{id,...input},200,()=>{
  const row=this.store.db.prepare(`SELECT data FROM ${plansTable} WHERE id=? AND workspace=?`).get(id,workspace);if(!row)throw new DomainError(404,'Recurring plan not found.');const plan={...this.store.decode<RecurringPlan>(row.data,plansTable,id,workspace),paused:input.paused,updatedAt:this.now().toISOString()};this.store.db.prepare(`UPDATE ${plansTable} SET data=? WHERE id=? AND workspace=?`).run(this.store.encode(plan,plansTable,id,workspace),id,workspace);return {plan};
 });}
 prepare(workspace:string,body:unknown,key:string|undefined){const input=parse(z.object({asOf:dateSchema.optional()}).strict(),body);return this.store.idempotent<RecurringPrepareResult>('recurring-prepare:'+workspace,key,input,200,()=>{
  const timestamp=this.now().toISOString(),today=timestamp.slice(0,10),asOf=input.asOf??today;if(asOf>today)throw new DomainError(400,'Prepare drafts through today or an earlier date.');
  const plans=this.listPlans(workspace).filter(plan=>!plan.paused).reverse(),created:RecurringDraft[]=[];let hasMore=false;
  let remaining=RECURRING_LIMITS.drafts-Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${draftsTable} WHERE workspace=?`).get(workspace)!.n);
  for(const plan of plans){let index=Number(this.store.db.prepare(`SELECT COALESCE(MAX(period_index),-1) n FROM ${draftsTable} WHERE plan_id=? AND workspace=?`).get(plan.id,workspace)!.n)+1;
   for(;;index++){const periodDate=occurrenceDate(plan.startDate,plan.frequency,index);if(!periodDate||periodDate>asOf)break;
    if(created.length>=RECURRING_LIMITS.prepareBatch){hasMore=true;break;}
    if(remaining<=0){if(created.length){hasMore=true;break;}throw new DomainError(429,'This workspace has reached its recurring draft limit. Existing drafts remain available.');}
    const {issueDate:_,dueDate:__,...snapshot}=plan.templateDraft;let dueDate:string|undefined;
    if(plan.dueOffsetDays!==undefined){try{dueDate=paymentDueDate(periodDate,plan.dueOffsetDays);}catch{throw new DomainError(400,'A recurring due date is outside the supported calendar. Pause this plan before preparing more drafts.');}}
    const draft:RecurringDraft={id:randomUUID(),planId:plan.id,planLabel:plan.label,periodIndex:index,periodDate,status:'draft',createdAt:timestamp,draft:{...snapshot,issueDate:periodDate,...(dueDate?{dueDate}:{}),...(plan.dueOffsetDays!==undefined?{paymentTermDays:plan.dueOffsetDays}:{})}};
    this.store.db.prepare(`INSERT INTO ${draftsTable}(id,workspace,plan_id,period_index,data) VALUES(?,?,?,?,?)`).run(draft.id,workspace,plan.id,index,this.store.encode(draft,draftsTable,draft.id,workspace));created.push(draft);remaining--;
   }
  }
  return {drafts:created,createdCount:created.length,hasMore,asOf};
 });}
 issue(workspace:string,id:string,body:unknown,key:string|undefined){retryKey(key);const input=parse(z.object({draft:invoiceSchema}).strict(),body);const fingerprint=this.store.indexValue('recurring-issued-input',hash(canonical(input.draft)));
  return this.store.transaction(()=>{
   const previous=this.storedDraft(workspace,id);
   if(previous.status==='issued'&&previous.issuedInputFingerprint!==fingerprint)throw new DomainError(409,'This recurring draft has already been issued with different invoice details. Open the issued invoice.');
   return this.store.idempotent('recurring-issue:'+workspace,key,{id,...input},201,()=>{
    if(previous.status==='issued')return {invoice:previous.issuedInvoice!,draft:publicDraft(previous)};
    const timestamp=this.now(),invoice=JSON.parse(JSON.stringify(createInvoice(this.store,workspace,input.draft,timestamp))) as Invoice,issued:StoredDraft={...previous,status:'issued',draft:input.draft,invoiceId:invoice.id,issuedAt:timestamp.toISOString(),issuedInputFingerprint:fingerprint,issuedInvoice:invoice};
    this.store.db.prepare(`UPDATE ${draftsTable} SET invoice_id=?,data=? WHERE id=? AND workspace=?`).run(invoice.id,this.store.encode(issued,draftsTable,id,workspace),id,workspace);return {invoice,draft:publicDraft(issued)};
   });
  });
 }
}
