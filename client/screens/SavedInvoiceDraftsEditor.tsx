import{useEffect,useState}from'react';
import type{SavedInvoiceDraft}from'../../shared/invoice-editor-drafts';
import{getInvoiceDraft}from'../invoice-drafts';
import{ErrorMessage,Link,Loading}from'../components';
import{InvoiceEditor}from'./InvoiceEditor';

/**
 * Restore a private saved draft into the editor with persistence enabled:
 * edits keep autosaving onto the same draft, reload restores it from this
 * route, and issuing happens exactly once from the reviewed content. Issued
 * drafts are immutable and cannot be reopened for editing.
 */
export function SavedInvoiceDraftsEditor({id,onCreated}:{id:string;onCreated:()=>Promise<void>}){
  const[draft,setDraft]=useState<SavedInvoiceDraft|undefined>(undefined),[failure,setFailure]=useState('');
  useEffect(()=>{let current=true;void getInvoiceDraft(id).then(value=>{if(current)setDraft(value.draft);}).catch(e=>{if(current)setFailure(e instanceof Error?e.message:'This saved draft could not be loaded.');});return()=>{current=false;};},[id]);
  if(failure)return <ErrorMessage message={failure}/>;
  if(draft===undefined)return <Loading label="Opening your saved draft…"/>;
  if(draft.status==='issued')return <><ErrorMessage message="This draft was already issued. Its invoice keeps the original totals."/><p><Link to="/invoices" className="text-link">Back to invoices</Link></p></>;
  return <InvoiceEditor key={draft.id} restoredDraft={{id:draft.id,revision:draft.revision,snapshot:draft.snapshot}} persistence onCreated={onCreated}/>;
}
