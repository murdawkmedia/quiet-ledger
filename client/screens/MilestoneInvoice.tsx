import {useEffect,useRef,useState} from 'react';
import {RefreshCw} from 'lucide-react';
import type {Invoice} from '../../shared/contracts';
import type {BillingMilestoneView} from '../../shared/billing-records';
import type {InvoiceDraft} from '../../shared/invoice-options';
import {api,post} from '../api';
import {ErrorMessage,Link,Loading,PageHeading,PrivacyNote,navigate} from '../components';
import {InvoiceEditor} from './InvoiceEditor';
import '../billing.css';

/**
 * Owner wrapper that prefills the existing immutable InvoiceEditor from a
 * workspace-owned milestone. Parent mounts it at /billing/milestones/:id/invoice:
 * `lazy(() => import('./screens/MilestoneInvoice').then(m => ({default: m.MilestoneInvoice})))`
 * with the milestone id taken from the route path — never a query string or storage.
 * The editor is keyed per milestone so background refreshes cannot overwrite edits.
 */
export function MilestoneInvoice({id,onCreated}:{id:string;onCreated?:()=>Promise<void>}){
  const [milestone,setMilestone]=useState<BillingMilestoneView|null>(null),[error,setError]=useState('');
  const [created,setCreated]=useState<{invoice:Invoice;linkError:string}|null>(null);
  const outcome=useRef<{invoice:Invoice;linkError:string}|null>(null);
  const linkKeys=useRef(new Map<string,string>());
  useEffect(()=>{const abort=new AbortController();setMilestone(null);setError('');
    void api<{milestone:BillingMilestoneView}>(`/api/billing/milestones/${encodeURIComponent(id)}`,{signal:abort.signal}).then(value=>setMilestone(value.milestone)).catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'This milestone could not be loaded.');});
    return()=>abort.abort();
  },[id]);
  // A separate stable mutation key per created invoice: link retries can never
  // issue a second invoice or reuse the invoice-creation key.
  function linkKeyFor(invoiceId:string){
    const existing=linkKeys.current.get(invoiceId);
    if(existing)return existing;
    const key=`billing-link-${id}-${invoiceId}`;
    linkKeys.current.set(invoiceId,key);
    return key;
  }
  async function link(invoiceId:string){
    return api(`/api/billing/milestones/${encodeURIComponent(id)}`,{method:'PATCH',body:JSON.stringify({invoiceId}),headers:{'Idempotency-Key':linkKeyFor(invoiceId)}});
  }
  /**
   * Existing POST /api/invoices with its frozen idempotent retry: the editor keeps
   * the exact draft and key on uncertain outcomes, so a retry replays the same
   * invoice. After creation, the link step runs with its own stable key; a link
   * failure never rethrows — the issued invoice is preserved and surfaced instead.
   */
  async function submitDraft(draft:InvoiceDraft,key:string):Promise<Invoice>{
    const result=await post<Invoice|{invoice:Invoice}>('/api/invoices',draft,key);
    const invoice='invoice' in result?result.invoice:result;
    try{await link(invoice.id);outcome.current=null;}
    catch(e){outcome.current={invoice,linkError:e instanceof Error?e.message:'The invoice was created, but linking it to this milestone failed.'};setCreated(outcome.current);}
    return invoice;
  }
  async function finish(){
    if(outcome.current)return; // A failed link keeps this page and its retry state.
    if(onCreated){await onCreated();return;}
    navigate('/billing');
  }
  async function retryLink(){
    if(!outcome.current)return;
    const {invoice}=outcome.current;
    try{await link(invoice.id);outcome.current=null;setCreated(null);if(onCreated)await onCreated();else navigate('/billing');}
    catch(e){outcome.current={invoice,linkError:e instanceof Error?e.message:'Linking this invoice failed again.'};setCreated(outcome.current);}
  }
  if(error)return <main className="main-content"><PageHeading eyebrow="BILLING" title="Create a milestone invoice." action={<Link to="/billing" className="button secondary">Back to billing</Link>}/><ErrorMessage message={error}/></main>;
  if(!milestone)return <main className="main-content"><Loading label="Opening this milestone…"/></main>;
  if(created)return <main className="main-content">
    <PageHeading eyebrow="BILLING" title="The invoice is issued." description="Linking it to the milestone did not complete. The issued invoice itself is safe and unchanged." action={<Link to="/billing" className="button secondary">Back to billing</Link>}/>
    <section className="panel form-panel">
      <h2>{created.invoice.number} · {created.invoice.title}</h2>
      <p className="success-message" role="status">Invoice {created.invoice.number} was created for {created.invoice.customerName}. It was not linked to the milestone yet.</p>
      <ErrorMessage message={created.linkError}/>
      <div className="billing-milestone-actions">
        <button type="button" className="button primary" onClick={()=>void retryLink()}><RefreshCw size={16}/>Retry link</button>
        <Link to="/billing" className="button secondary">Link it manually from billing</Link>
      </div>
      <PrivacyNote>Do not create the invoice again: retrying the link uses the same saved operation and never issues a second invoice.</PrivacyNote>
    </section>
  </main>;
  const initialDraft:InvoiceDraft={customerName:'',title:milestone.label,currency:milestone.currency,items:[{description:milestone.label,quantity:1,unitAmount:milestone.amount,kind:'service',adjustmentEligible:true}]};
  return <main className="main-content">
    <PageHeading eyebrow="BILLING" title={`Invoice "${milestone.label}"`} description="The planned label, currency and amount prefill this draft. The issued invoice is authoritative; the plan stays a note." action={<Link to="/billing" className="button secondary">Back to billing</Link>}/>
    <InvoiceEditor key={milestone.id} initialDraft={initialDraft} submitDraft={submitDraft} onCreated={finish}/>
  </main>;
}
