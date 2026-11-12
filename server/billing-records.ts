import {randomUUID} from 'node:crypto';
import type {Invoice} from '../shared/contracts.js';
import type {BillingDeliverableView,BillingInvoiceSummary,BillingMilestoneView,BillingOverview,BillingProjectView,PublicDeliverable} from '../shared/billing-records.js';
import {BILLING_LIMITS,createProjectSchema,renameProjectSchema,createMilestoneSchema,updateMilestoneSchema,createDeliverableSchema,updateDeliverableSchema,deliverableUrlIssue} from '../shared/billing-records.js';
import {parse} from './domain.js';
import {DomainError,Store} from './store.js';
import type {InvoiceLedger} from './invoice-ledger.js';

/** Encrypted planning payloads. Only ids, workspace relationships and timestamps sit outside. */
interface ProjectPayload {name:string}
interface MilestonePayload {label:string;amount:number;currency:MilestonePayloadCurrency}
type MilestonePayloadCurrency='CAD'|'USD'|'KRW'|'EUR'|'GBP'|'SAT';
interface DeliverablePayload {label:string;url:string;releasedAt?:string}
interface StoredLedgerEntry {kind:'payment'|'credit'|'void';amount:number;currency?:string;method?:string;verification?:'provider'|'manual';receipt?:{mode?:'simulation'|'live';amount?:number;currency?:string;method?:string;invoiceNumber?:string}}

/**
 * Optional owner-managed project/milestone planning records and invoice-linked,
 * paid-gated deliverable links. No escrow, task platform, payout engine or new
 * public capability: the payer surface is the parent-owned checkout extension
 * calling `publicDeliverables`, scoped to the existing private checkout token.
 */
export class BillingRecords {
  constructor(private store:Store,private ledger:InvoiceLedger,private now:()=>Date){
    store.transaction(()=>{
      store.db.exec(`
        CREATE TABLE IF NOT EXISTS billing_projects (
          id TEXT PRIMARY KEY,workspace TEXT NOT NULL,created_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS billing_project_workspace ON billing_projects(workspace);
        CREATE TABLE IF NOT EXISTS billing_milestones (
          id TEXT PRIMARY KEY,workspace TEXT NOT NULL,
          project_id TEXT REFERENCES billing_projects(id),
          invoice_id TEXT REFERENCES invoices(id),
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS billing_milestone_workspace ON billing_milestones(workspace);
        CREATE INDEX IF NOT EXISTS billing_milestone_invoice ON billing_milestones(workspace,invoice_id);
        CREATE TABLE IF NOT EXISTS billing_deliverables (
          id TEXT PRIMARY KEY,workspace TEXT NOT NULL,
          invoice_id TEXT NOT NULL REFERENCES invoices(id),
          created_at TEXT NOT NULL,updated_at TEXT NOT NULL,data TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS billing_deliverable_workspace ON billing_deliverables(workspace);
        CREATE INDEX IF NOT EXISTS billing_deliverable_invoice ON billing_deliverables(workspace,invoice_id);
      `);
    });
  }
  private projectRow(workspace:string,id:string){
    const row=this.store.db.prepare('SELECT id,workspace,created_at,data FROM billing_projects WHERE id=? AND workspace=?').get(id,workspace);
    if(!row)throw new DomainError(404,'Project not found.');
    return {id:String(row.id),workspace:String(row.workspace),createdAt:String(row.created_at),payload:this.store.decode<ProjectPayload>(row.data,'billing_projects',String(row.id),workspace)};
  }
  private milestoneRow(workspace:string,id:string){
    const row=this.store.db.prepare('SELECT id,workspace,project_id,invoice_id,created_at,updated_at,data FROM billing_milestones WHERE id=? AND workspace=?').get(id,workspace);
    if(!row)throw new DomainError(404,'Milestone not found.');
    return {id:String(row.id),workspace:String(row.workspace),projectId:row.project_id===null?null:String(row.project_id),invoiceId:row.invoice_id===null?null:String(row.invoice_id),createdAt:String(row.created_at),updatedAt:String(row.updated_at),payload:this.store.decode<MilestonePayload>(row.data,'billing_milestones',String(row.id),workspace)};
  }
  private deliverableRow(workspace:string,id:string){
    const row=this.store.db.prepare('SELECT id,workspace,invoice_id,created_at,updated_at,data FROM billing_deliverables WHERE id=? AND workspace=?').get(id,workspace);
    if(!row)throw new DomainError(404,'Deliverable not found.');
    return {id:String(row.id),workspace:String(row.workspace),invoiceId:String(row.invoice_id),createdAt:String(row.created_at),updatedAt:String(row.updated_at),payload:this.store.decode<DeliverablePayload>(row.data,'billing_deliverables',String(row.id),workspace)};
  }
  private milestoneRows(workspace:string,projectId?:string){
    const rows=projectId===undefined
      ?this.store.db.prepare('SELECT id,workspace,project_id,invoice_id,created_at,updated_at,data FROM billing_milestones WHERE workspace=? AND project_id IS NULL ORDER BY rowid').all(workspace)
      :this.store.db.prepare('SELECT id,workspace,project_id,invoice_id,created_at,updated_at,data FROM billing_milestones WHERE workspace=? AND project_id=? ORDER BY rowid').all(workspace,projectId);
    return rows.map(row=>({id:String(row.id),workspace:String(row.workspace),projectId:row.project_id===null?null:String(row.project_id),invoiceId:row.invoice_id===null?null:String(row.invoice_id),createdAt:String(row.created_at),updatedAt:String(row.updated_at),payload:this.store.decode<MilestonePayload>(row.data,'billing_milestones',String(row.id),workspace)}));
  }
  private deliverableRows(workspace:string,invoiceId?:string){
    const rows=invoiceId===undefined
      ?this.store.db.prepare('SELECT id,workspace,invoice_id,created_at,updated_at,data FROM billing_deliverables WHERE workspace=? ORDER BY rowid').all(workspace)
      :this.store.db.prepare('SELECT id,workspace,invoice_id,created_at,updated_at,data FROM billing_deliverables WHERE workspace=? AND invoice_id=? ORDER BY rowid').all(workspace,invoiceId);
    return rows.map(row=>({id:String(row.id),workspace:String(row.workspace),invoiceId:String(row.invoice_id),createdAt:String(row.created_at),updatedAt:String(row.updated_at),payload:this.store.decode<DeliverablePayload>(row.data,'billing_deliverables',String(row.id),workspace)}));
  }
  /** Live ledger facts for a linked invoice; never a duplicated or planned total. */
  private invoiceSummary(workspace:string,invoiceId:string):BillingInvoiceSummary{
    const view=this.ledger.read(workspace,invoiceId);
    const {invoice,balance}=view;
    return {id:invoice.id,number:invoice.number,currency:invoice.currency,total:invoice.total,effectiveTotal:balance.effectiveTotal,paid:balance.paid,due:balance.due,state:balance.state,mode:balance.mode,
      ...(invoice.priceAgreement?{priceAgreementId:invoice.priceAgreement.id}:{})};
  }
  private deliverableView(row:{id:string;invoiceId:string;createdAt:string;updatedAt:string;payload:DeliverablePayload},workspace:string,invoiceNumber?:string):BillingDeliverableView{
    return {id:row.id,invoiceId:row.invoiceId,...(invoiceNumber!==undefined?{invoiceNumber}:{}),label:row.payload.label,released:row.payload.releasedAt!==undefined,releaseReady:this.releaseReady(workspace,row.invoiceId),createdAt:row.createdAt,updatedAt:row.updatedAt};
  }
  private milestoneView(row:{id:string;projectId:string|null;invoiceId:string|null;createdAt:string;updatedAt:string;payload:MilestonePayload},workspace:string,withInvoiceNumbers=false):BillingMilestoneView{
    return {id:row.id,projectId:row.projectId,label:row.payload.label,amount:row.payload.amount,currency:row.payload.currency,createdAt:row.createdAt,updatedAt:row.updatedAt,
      ...(row.invoiceId?{invoice:this.invoiceSummary(workspace,row.invoiceId)}:{}),
      deliverables:row.invoiceId?this.deliverableRows(workspace,row.invoiceId).map(item=>this.deliverableView(item,workspace,withInvoiceNumbers?this.invoiceSummary(workspace,item.invoiceId).number:undefined)):[]
    };
  }
  overview(workspace:string):BillingOverview{
    const projects=this.store.db.prepare('SELECT id,workspace,created_at,data FROM billing_projects WHERE workspace=? ORDER BY rowid').all(workspace).map(row=>{
      const project=this.store.decode<ProjectPayload>(row.data,'billing_projects',String(row.id),workspace);
      return {id:String(row.id),name:project.name,createdAt:String(row.created_at)};
    });
    const numbers=new Map<string,string>();
    for(const row of this.deliverableRows(workspace))if(!numbers.has(row.invoiceId))numbers.set(row.invoiceId,this.invoiceSummary(workspace,row.invoiceId).number);
    return {
      projects:projects.map(project=>({id:project.id,name:project.name,createdAt:project.createdAt,milestones:this.milestoneRows(workspace,project.id).map(row=>this.milestoneView(row,workspace))})),
      looseMilestones:this.milestoneRows(workspace,undefined).map(row=>this.milestoneView(row,workspace)),
      deliverables:this.deliverableRows(workspace).map(row=>this.deliverableView(row,workspace,numbers.get(row.invoiceId)))
    };
  }
  milestone(workspace:string,id:string):BillingMilestoneView{
    const row=this.milestoneRow(workspace,id);
    return this.milestoneView(row,workspace,true);
  }
  private assertProject(workspace:string,projectId:string){
    this.projectRow(workspace,projectId);
  }
  /** The invoice must belong to the caller's workspace; rechecked inside each write transaction. */
  private assertInvoice(workspace:string,invoiceId:string):Invoice{
    const invoice=this.store.getInvoice(invoiceId,workspace);
    if(!invoice)throw new DomainError(404,'Invoice not found.');
    return invoice;
  }
  private count(table:string,workspace:string,extra?:{column:string;value:string}){
    return Number(extra
      ?this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace=? AND ${extra.column}=?`).get(workspace,extra.value)!.n
      :this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace=?`).get(workspace)!.n);
  }
  createProject(workspace:string,name:string):BillingProjectView{
    name=parse(createProjectSchema,{name}).name;
    return this.store.transaction(()=>{
      if(this.count('billing_projects',workspace)>=BILLING_LIMITS.projectsPerWorkspace)throw new DomainError(429,'This workspace has reached its billing project limit. Existing records remain available.');
      this.store.assertWriteBudget();
      const id=randomUUID(),createdAt=this.now().toISOString();
      this.store.db.prepare('INSERT INTO billing_projects(id,workspace,created_at,data) VALUES(?,?,?,?)').run(id,workspace,createdAt,this.store.encode({name},'billing_projects',id,workspace));
      this.store.audit(workspace,'billing.project_created',`Billing project created: ${name}.`,createdAt);
      return {id,name,createdAt,milestones:[]};
    });
  }
  renameProject(workspace:string,id:string,name:string):BillingProjectView{
    name=parse(renameProjectSchema,{name}).name;
    return this.store.transaction(()=>{
      const row=this.projectRow(workspace,id);
      this.store.assertWriteBudget();
      this.store.db.prepare('UPDATE billing_projects SET data=? WHERE id=? AND workspace=?').run(this.store.encode({name},'billing_projects',id,workspace),id,workspace);
      this.store.audit(workspace,'billing.project_renamed',`Billing project renamed: ${name}.`,this.now().toISOString());
      return {id,name,createdAt:row.createdAt,milestones:this.milestoneRows(workspace,id).map(milestone=>this.milestoneView(milestone,workspace))};
    });
  }
  deleteProject(workspace:string,id:string):{ok:true}{
    return this.store.transaction(()=>{
      this.projectRow(workspace,id);
      if(this.count('billing_milestones',workspace,{column:'project_id',value:id})>0)throw new DomainError(409,'This project still has milestones. Delete them first.');
      this.store.db.prepare('DELETE FROM billing_projects WHERE id=? AND workspace=?').run(id,workspace);
      this.store.audit(workspace,'billing.project_deleted','Billing project deleted.',this.now().toISOString());
      return {ok:true};
    });
  }
  createMilestone(workspace:string,input:{label:string;amount:number;currency:MilestonePayloadCurrency;projectId?:string;invoiceId?:string}):BillingMilestoneView{
    input=parse(createMilestoneSchema,input);
    return this.store.transaction(()=>{
      if(this.count('billing_milestones',workspace)>=BILLING_LIMITS.milestonesPerWorkspace)throw new DomainError(429,'This workspace has reached its billing milestone limit. Existing records remain available.');
      this.store.assertWriteBudget();
      if(input.projectId!==undefined)this.assertProject(workspace,input.projectId);
      if(input.invoiceId!==undefined)this.assertInvoice(workspace,input.invoiceId);
      const id=randomUUID(),createdAt=this.now().toISOString();
      this.store.db.prepare('INSERT INTO billing_milestones(id,workspace,project_id,invoice_id,created_at,updated_at,data) VALUES(?,?,?,?,?,?,?)').run(id,workspace,input.projectId??null,input.invoiceId??null,createdAt,createdAt,this.store.encode({label:input.label,amount:input.amount,currency:input.currency},'billing_milestones',id,workspace));
      this.store.audit(workspace,'billing.milestone_created',`Billing milestone saved: ${input.label}.`,createdAt);
      return this.milestoneView(this.milestoneRow(workspace,id),workspace,true);
    });
  }
  updateMilestone(workspace:string,id:string,input:{label?:string;invoiceId?:string|null}):BillingMilestoneView{
    input=parse(updateMilestoneSchema,input);
    return this.store.transaction(()=>{
      const row=this.milestoneRow(workspace,id);
      this.store.assertWriteBudget();
      // Planned amount and currency are immutable after creation to keep planning honest.
      const label=input.label??row.payload.label;
      let invoiceId=row.invoiceId;
      if(input.invoiceId!==undefined){
        if(input.invoiceId===null)invoiceId=null;
        else{this.assertInvoice(workspace,input.invoiceId);invoiceId=input.invoiceId;}
      }
      const updatedAt=this.now().toISOString();
      this.store.db.prepare('UPDATE billing_milestones SET invoice_id=?,updated_at=?,data=? WHERE id=? AND workspace=?').run(invoiceId,updatedAt,this.store.encode({label,amount:row.payload.amount,currency:row.payload.currency},'billing_milestones',id,workspace),id,workspace);
      this.store.audit(workspace,'billing.milestone_updated',input.invoiceId!==undefined?(input.invoiceId?`Billing milestone linked to an invoice: ${label}.`:`Billing milestone unlinked: ${label}.`):`Billing milestone renamed: ${label}.`,updatedAt);
      return this.milestoneView(this.milestoneRow(workspace,id),workspace,true);
    });
  }
  deleteMilestone(workspace:string,id:string):{ok:true}{
    return this.store.transaction(()=>{
      const row=this.milestoneRow(workspace,id);
      // Milestone deletes never touch invoices, receipts, ledger entries or deliverables.
      this.store.db.prepare('DELETE FROM billing_milestones WHERE id=? AND workspace=?').run(id,workspace);
      this.store.audit(workspace,'billing.milestone_deleted',`Billing milestone deleted: ${row.payload.label}.`,this.now().toISOString());
      return {ok:true};
    });
  }
  createDeliverable(workspace:string,input:{invoiceId:string;label:string;url:string}):BillingDeliverableView{
    input=parse(createDeliverableSchema,input);
    return this.store.transaction(()=>{
      this.assertInvoice(workspace,input.invoiceId);
      if(this.count('billing_deliverables',workspace,{column:'invoice_id',value:input.invoiceId})>=BILLING_LIMITS.deliverablesPerInvoice)throw new DomainError(429,'This invoice has reached its deliverable limit. Existing records remain available.');
      if(this.count('billing_deliverables',workspace)>=BILLING_LIMITS.deliverablesPerWorkspace)throw new DomainError(429,'This workspace has reached its deliverable limit. Existing records remain available.');
      this.store.assertWriteBudget();
      const id=randomUUID(),createdAt=this.now().toISOString();
      this.store.db.prepare('INSERT INTO billing_deliverables(id,workspace,invoice_id,created_at,updated_at,data) VALUES(?,?,?,?,?,?)').run(id,workspace,input.invoiceId,createdAt,createdAt,this.store.encode({label:input.label,url:input.url},'billing_deliverables',id,workspace));
      this.store.audit(workspace,'billing.deliverable_created',`Deliverable link saved for an invoice: ${input.label}.`,createdAt);
      return this.deliverableView(this.deliverableRow(workspace,id),workspace,this.invoiceSummary(workspace,input.invoiceId).number);
    });
  }
  updateDeliverable(workspace:string,id:string,input:{label?:string;url?:string}):BillingDeliverableView{
    input=parse(updateDeliverableSchema,input);
    return this.store.transaction(()=>{
      const row=this.deliverableRow(workspace,id);
      this.store.assertWriteBudget();
      const label=input.label??row.payload.label;
      // A URL edit clears the release flag atomically: approving the old destination
      // must never silently approve a new one. Label-only edits may keep release.
      const changedUrl=input.url!==undefined&&input.url!==row.payload.url;
      const payload:DeliverablePayload={label,url:input.url??row.payload.url,...(changedUrl?{}:row.payload.releasedAt!==undefined?{releasedAt:row.payload.releasedAt}:{})};
      const updatedAt=this.now().toISOString();
      this.store.db.prepare('UPDATE billing_deliverables SET updated_at=?,data=? WHERE id=? AND workspace=?').run(updatedAt,this.store.encode(payload,'billing_deliverables',id,workspace),id,workspace);
      if(changedUrl)this.store.audit(workspace,'billing.deliverable_url_changed',`Deliverable destination changed; release cleared: ${label}.`,updatedAt);
      else this.store.audit(workspace,'billing.deliverable_updated',`Deliverable label updated: ${label}.`,updatedAt);
      return this.deliverableView(this.deliverableRow(workspace,id),workspace,this.invoiceSummary(workspace,row.invoiceId).number);
    });
  }
  deleteDeliverable(workspace:string,id:string):{ok:true}{
    return this.store.transaction(()=>{
      const row=this.deliverableRow(workspace,id);
      this.store.db.prepare('DELETE FROM billing_deliverables WHERE id=? AND workspace=?').run(id,workspace);
      this.store.audit(workspace,'billing.deliverable_deleted',`Deliverable link deleted: ${row.payload.label}.`,this.now().toISOString());
      return {ok:true};
    });
  }
  /** Release writes the owner's explicit flag only; the paid gate is evaluated on every read. */
  release(workspace:string,id:string):BillingDeliverableView{
    return this.store.transaction(()=>{
      const row=this.deliverableRow(workspace,id);
      this.store.assertWriteBudget();
      if(row.payload.releasedAt===undefined){
        const updatedAt=this.now().toISOString();
        this.store.db.prepare('UPDATE billing_deliverables SET updated_at=?,data=? WHERE id=? AND workspace=?').run(updatedAt,this.store.encode({...row.payload,releasedAt:updatedAt},'billing_deliverables',id,workspace),id,workspace);
        this.store.audit(workspace,'billing.deliverable_released',`Deliverable release requested: ${row.payload.label}. Payment is rechecked before it is shown.`,updatedAt);
      }
      return this.deliverableView(this.deliverableRow(workspace,id),workspace,this.invoiceSummary(workspace,row.invoiceId).number);
    });
  }
  unrelease(workspace:string,id:string):BillingDeliverableView{
    return this.store.transaction(()=>{
      const row=this.deliverableRow(workspace,id);
      this.store.assertWriteBudget();
      if(row.payload.releasedAt!==undefined){
        const {releasedAt:_releasedAt,...payload}=row.payload;
        const updatedAt=this.now().toISOString();
        this.store.db.prepare('UPDATE billing_deliverables SET updated_at=?,data=? WHERE id=? AND workspace=?').run(updatedAt,this.store.encode(payload,'billing_deliverables',id,workspace),id,workspace);
        this.store.audit(workspace,'billing.deliverable_unreleased',`Deliverable hidden again: ${row.payload.label}.`,updatedAt);
      }
      return this.deliverableView(this.deliverableRow(workspace,id),workspace,this.invoiceSummary(workspace,row.invoiceId).number);
    });
  }
  /** Demo and hackathon workspaces never expose deliverable links. */
  private isDemoWorkspace(workspace:string){
    if(workspace==='demo')return true;
    return Boolean(this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='hackathon_demo_workspaces'").get()
      &&this.store.db.prepare('SELECT 1 FROM hackathon_demo_workspaces WHERE id=?').get(workspace));
  }
  /**
   * Real live receipt-backed payment value: ledger payment entries that carry a live
   * receipt with provider or owner-manual verification. An invoice status flag, a
   * client-supplied mode or a stored derived balance is never payment evidence.
   */
  private liveReceiptValue(workspace:string,invoice:Invoice){
    const rows=this.store.db.prepare('SELECT id,data FROM invoice_ledger_entries WHERE invoice_id=? AND workspace=?').all(invoice.id,workspace);
    let total=0;
    for(const row of rows){
      const entry=this.store.decode<StoredLedgerEntry>(row.data,'invoice_ledger_entries',String(row.id),workspace);
      const receipt=entry?.receipt;
      if(entry?.kind==='payment'&&receipt?.mode==='live'&&(entry.verification==='provider'||entry.verification==='manual')
        &&Number.isSafeInteger(entry.amount)&&entry.amount>0&&entry.currency===invoice.currency
        &&receipt.amount===entry.amount&&receipt.currency===entry.currency&&receipt.method===entry.method&&receipt.invoiceNumber===invoice.number){
        total+=entry.amount;if(!Number.isSafeInteger(total))return 0;
      }
    }
    return total;
  }
  /** Fresh release readiness for owner display: everything except the explicit release flag. */
  private releaseReady(workspace:string,invoiceId:string){
    const invoice=this.store.getInvoice(invoiceId,workspace);
    if(!invoice||this.isDemoWorkspace(workspace)||this.store.linksRevoked(invoiceId))return false;
    const balance=this.ledger.balance(invoice,workspace);
    return balance.state==='paid'&&balance.mode==='live'&&this.liveReceiptValue(workspace,invoice)>=balance.effectiveTotal;
  }
  /**
   * The payer-facing projection, re-derived on every call from live state. Returns []
   * unless the workspace is a real private workspace, checkout links are not revoked,
   * the owner explicitly released, the authoritative ledger is paid in live mode and
   * real live receipt-backed payments cover the effective total. Whitelist: label/url.
   */
  publicDeliverables(workspace:string,invoiceId:string):PublicDeliverable[]{
    const invoice=this.store.getInvoice(invoiceId,workspace);
    if(!invoice||this.isDemoWorkspace(workspace))return [];
    if(this.store.linksRevoked(invoiceId))return [];
    const balance=this.ledger.balance(invoice,workspace);
    if(balance.state!=='paid'||balance.mode!=='live')return [];
    if(this.liveReceiptValue(workspace,invoice)<balance.effectiveTotal)return [];
    return this.deliverableRows(workspace,invoiceId).filter(row=>row.payload.releasedAt!==undefined&&typeof row.payload.url==='string'&&deliverableUrlIssue(row.payload.url)===undefined).map(row=>({label:row.payload.label,url:row.payload.url}));
  }
}
