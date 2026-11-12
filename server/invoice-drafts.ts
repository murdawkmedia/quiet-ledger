import {z} from 'zod';
import type {Invoice} from '../shared/contracts.js';
import {INVOICE_EDITOR_DRAFTS_LIMITS,canonicalSnapshot,validateInvoiceEditorSnapshot,snapshotSummaryFields,type InvoiceEditorSnapshot,type SavedInvoiceDraft,type SavedInvoiceDraftSummary} from '../shared/invoice-editor-drafts.js';
import {createInvoice,invoiceSchema,parse} from './domain.js';
import {Store,DomainError,hash} from './store.js';

export const INVOICE_EDITOR_DRAFT_LIMITS=INVOICE_EDITOR_DRAFTS_LIMITS;
const table='invoice_editor_drafts';
const idSchema=z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,'Enter a valid draft identifier.');
const saveSchema=z.object({expectedRevision:z.number().int().min(0),snapshot:z.unknown()}).strict();
const issueSchema=z.object({expectedRevision:z.number().int().min(0),invoice:invoiceSchema}).strict();
interface StoredDraft {
  id:string;revision:number;createdAt:string;updatedAt:string;status:'draft'|'issued';
  snapshot:InvoiceEditorSnapshot;invoiceId?:string;issuedAt?:string;issuedInputFingerprint?:string;issuedInvoice?:Invoice;
}
function canonical(value:unknown):string {if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',')+'}';return JSON.stringify(value)??'null';}
function retryKey(value:string|undefined){if(!value||!(/^[A-Za-z0-9._:-]{1,128}$/).test(value))throw new DomainError(400,'A valid Idempotency-Key header is required.');return value;}

/**
 * Private encrypted invoice editor drafts, scoped to one owner workspace.
 *
 * A draft is a strict versioned snapshot of raw editor values, so incomplete
 * forms survive exactly as typed while strict invoice validation stays at issue
 * time. Saving never allocates an invoice number or checkout token and never
 * sends anything. Revisions prevent silent last-writer overwrites: an exact
 * retry of the last applied save replays its result without advancing again,
 * while any other stale write returns 409. Issuing is atomic and exactly-once
 * per draft; the issued payload fingerprint makes same-payload retries (even
 * with a new key) return the original invoice and changed payloads conflict.
 * Issued drafts are immutable and cannot be discarded.
 */
export class InvoiceEditorDrafts {
  constructor(private store:Store,private now:()=>Date){store.db.exec(`
   CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT UNIQUE REFERENCES invoices(id),data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS invoice_editor_drafts_workspace ON ${table}(workspace);
  `);}
  private summary(draft:StoredDraft):SavedInvoiceDraftSummary{
    return {id:draft.id,revision:draft.revision,createdAt:draft.createdAt,updatedAt:draft.updatedAt,status:draft.status,...(draft.invoiceId?{invoiceId:draft.invoiceId}:{}),...snapshotSummaryFields(draft.snapshot)};
  }
  list(workspace:string):SavedInvoiceDraftSummary[]{return this.store.db.prepare(`SELECT id,data FROM ${table} WHERE workspace=? ORDER BY rowid DESC LIMIT ${INVOICE_EDITOR_DRAFT_LIMITS.drafts}`).all(workspace).map(row=>this.summary(this.store.decode<StoredDraft>(row.data,table,String(row.id),workspace)));}
  private stored(workspace:string,id:string):StoredDraft|undefined{const row=this.store.db.prepare(`SELECT data FROM ${table} WHERE id=? AND workspace=?`).get(id,workspace);return row?this.store.decode<StoredDraft>(row.data,table,id,workspace):undefined;}
  get(workspace:string,id:string):SavedInvoiceDraft{
    const draft=this.stored(workspace,parse(idSchema,id));
    if(!draft)throw new DomainError(404,'Saved draft not found.');
    return {...this.summary(draft),snapshot:draft.snapshot};
  }
  private write(workspace:string,draft:StoredDraft){const result=this.store.db.prepare(`INSERT INTO ${table}(id,workspace,invoice_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET invoice_id=excluded.invoice_id,data=excluded.data WHERE workspace=excluded.workspace`).run(draft.id,workspace,draft.invoiceId??null,this.store.encode(draft,table,draft.id,workspace));if(Number(result.changes)!==1)throw new DomainError(404,'Saved draft not found.');}
  save(workspace:string,id:string,body:unknown):{draft:SavedInvoiceDraftSummary}{
    const input=parse(saveSchema,body),draftId=parse(idSchema,id);
    const checked=validateInvoiceEditorSnapshot(input.snapshot);
    if(!checked.ok)throw new DomainError(400,checked.error);
    const content=canonicalSnapshot(checked.snapshot);
    return this.store.transaction(()=>{
      const existing=this.stored(workspace,draftId);
      if(existing){
        if(existing.status==='issued')throw new DomainError(409,'This draft has already been issued. Its saved invoice remains unchanged.');
        const stored=canonicalSnapshot(existing.snapshot);
        // Exact retry of the currently stored content, or of the immediately
        // previous save after an uncertain outcome: replay without advancing.
        if(content===stored&&(input.expectedRevision===existing.revision||input.expectedRevision===existing.revision-1))return {draft:this.summary(existing)};
        if(input.expectedRevision!==existing.revision)throw new DomainError(409,'This draft was saved again elsewhere. Reopen it to continue from the saved version.');
        const updated:StoredDraft={...existing,revision:existing.revision+1,updatedAt:this.now().toISOString(),snapshot:checked.snapshot};
        this.store.assertWriteBudget();this.write(workspace,updated);return {draft:this.summary(updated)};
      }
      if(input.expectedRevision!==0)throw new DomainError(404,'This saved draft no longer exists. It may have been discarded in another window.');
      if(Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace=?`).get(workspace)!.n)>=INVOICE_EDITOR_DRAFT_LIMITS.drafts)throw new DomainError(429,'This workspace has reached its saved-draft limit.');
      this.store.assertWriteBudget();
      const timestamp=this.now().toISOString(),created:StoredDraft={id:draftId,revision:1,createdAt:timestamp,updatedAt:timestamp,status:'draft',snapshot:checked.snapshot};
      this.write(workspace,created);return {draft:this.summary(created)};
    });
  }
  remove(workspace:string,id:string){
    const draftId=parse(idSchema,id),existing=this.stored(workspace,draftId);
    if(!existing)throw new DomainError(404,'Saved draft not found.');
    if(existing.status==='issued')throw new DomainError(409,'This draft has already been issued. Its saved invoice remains unchanged.');
    this.store.db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace=?`).run(draftId,workspace);
    return {deleted:true};
  }
  issue(workspace:string,id:string,body:unknown,key:string|undefined){
    retryKey(key);
    const input=parse(issueSchema,body),draftId=parse(idSchema,id);
    const fingerprint=this.store.indexValue('invoice-draft-issued-input',hash(canonical(input.invoice)));
    return this.store.transaction(()=>{
      const existing=this.stored(workspace,draftId);
      if(!existing)throw new DomainError(404,'Saved draft not found.');
      if(existing.status==='issued'&&existing.issuedInputFingerprint!==fingerprint)throw new DomainError(409,'This draft has already been issued with different invoice details. Open the issued invoice.');
      return this.store.idempotent('invoice-draft-issue:'+workspace,key,{id:draftId,expectedRevision:input.expectedRevision,invoice:input.invoice},201,()=>{
        if(existing.status==='issued')return {invoice:existing.issuedInvoice!,draft:this.summary(existing)};
        if(existing.revision!==input.expectedRevision)throw new DomainError(409,'This draft has newer saved changes. Reopen it and issue the saved version.');
        const timestamp=this.now(),invoice=createInvoice(this.store,workspace,input.invoice,timestamp) as Invoice;
        const issued:StoredDraft={...existing,status:'issued',invoiceId:invoice.id,issuedAt:timestamp.toISOString(),issuedInputFingerprint:fingerprint,issuedInvoice:invoice};
        this.write(workspace,issued);
        return {invoice,draft:this.summary(issued)};
      });
    });
  }
}
