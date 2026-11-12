import{useCallback,useEffect,useState}from'react';
import{Plus}from'lucide-react';
import type{SavedInvoiceDraftSummary}from'../../shared/invoice-editor-drafts';
import{deleteInvoiceDraft,listInvoiceDrafts}from'../invoice-drafts';
import{Badge,Empty,ErrorMessage,Link,Loading,PageHeading,PrivacyNote}from'../components';

/**
 * Owner list of private server-saved invoice editor drafts. A draft is only
 * a copy of what was typed: it holds no invoice number, checkout link or
 * outbound action until the owner issues it, and issued drafts cannot be
 * discarded or reopened for editing.
 */
export function SavedInvoiceDrafts(){
  const[drafts,setDrafts]=useState<SavedInvoiceDraftSummary[]|undefined>(undefined),[failure,setFailure]=useState(''),[busy,setBusy]=useState(false),[notice,setNotice]=useState('');
  const reload=useCallback(async()=>{try{const value=await listInvoiceDrafts();setDrafts(value.drafts);setFailure('');}catch(e){setFailure(e instanceof Error?e.message:'Saved drafts could not be loaded.');}},[]);
  useEffect(()=>{void reload();},[reload]);
  async function discard(id:string){
    if(busy)return;setBusy(true);
    try{await deleteInvoiceDraft(id);setDrafts(rows=>(rows??[]).filter(row=>row.id!==id));setNotice('Draft discarded. Issued invoices keep their own records.');}
    catch(e){setFailure(e instanceof Error?e.message:'This draft could not be discarded.');}
    finally{setBusy(false);}
  }
  return <><PageHeading eyebrow="PRIVATE WORKSPACE" title="Saved invoice drafts." description="Unfinished invoices stay encrypted in your workspace. Opening one restores exactly what you typed." action={<Link to="/invoices/new" className="button primary"><Plus size={17}/>New invoice</Link>}/>{failure?<ErrorMessage message={failure}/>:null}{notice?<div className="success-message" role="status">{notice}</div>:null}
  {drafts===undefined?<Loading label="Opening saved drafts…"/>:drafts.length===0?<Empty title="No saved drafts yet"><p>Start an invoice and it will be saved here privately as you work.</p></Empty>:<section className="panel"><div className="saved-draft-list" data-testid="saved-draft-list">{drafts.map(draft=><div className="saved-draft-row" key={draft.id} data-testid="saved-draft-row"><div className="saved-draft-row-main"><strong><Link to={`/drafts/${draft.id}`} className="text-link">{draft.title.trim()||'Untitled draft'}</Link></strong><small>{draft.customerName.trim()||'Unnamed customer'} · {draft.currency} · updated {new Date(draft.updatedAt).toLocaleString()}</small></div><div className="saved-draft-row-actions">{draft.status==='issued'?<Badge tone="good">Issued</Badge>:<Badge tone="warm">Draft</Badge>}{draft.status==='draft'?<button type="button" className="text-button" disabled={busy} onClick={()=>void discard(draft.id)} data-testid="saved-draft-discard">Discard</button>:null}</div></div>)}</div></section>}
  <PrivacyNote>Saved drafts are encrypted in your workspace. Saving or issuing an invoice sends no email and charges no payment. You choose when to share it.</PrivacyNote></>;
}
