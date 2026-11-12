import {useCallback,useEffect,useRef,useState} from 'react';
import {FileText,Plus,Trash2} from 'lucide-react';
import type {Currency,Invoice} from '../../shared/contracts';
import type {BillingDeliverableView,BillingMilestoneView,BillingOverview,BillingProjectView} from '../../shared/billing-records';
import {parseInvoiceAmount} from '../../shared/invoice-options';
import {actionKey,api,ApiError,money} from '../api';
import {Badge,ErrorMessage,Link,Loading,PageHeading,PrivacyNote,SectionCard,navigate} from '../components';
import '../billing.css';

const currencies:Currency[]=['CAD','USD','KRW','EUR','GBP','SAT'];
const stateLabels:{[key:string]:string}={unpaid:'Unpaid',partially_paid:'Partially paid',paid:'Paid',credited:'Credited',void:'Void'};

/**
 * Owner billing planning screen. Parent mounts this at /billing (owner browser only):
 * `lazy(() => import('./screens/BillingProjects').then(m => ({default: m.BillingProjects})))`.
 * Optionally receives the workspace invoice list; otherwise it loads its own.
 */
export function BillingProjects({invoices:invoiceProp}:{invoices?:Invoice[]}){
  // Retain each uncertain mutation's exact key for this mounted workspace visit.
  // Nothing is persisted to browser storage; form edits create a distinct intent.
  const pendingKeys=useRef(new Map<string,string>());
  async function mutation<T>(method:'POST'|'PATCH'|'DELETE',path:string,body?:unknown):Promise<T>{
    const fingerprint=JSON.stringify([method,path,body??null]);
    const key=pendingKeys.current.get(fingerprint)??actionKey();pendingKeys.current.set(fingerprint,key);
    try{
      const result=await api<T>('/api/billing'+path,{method,...(body!==undefined?{body:JSON.stringify(body)}:{}),headers:{'Idempotency-Key':key}});
      pendingKeys.current.delete(fingerprint);return result;
    }catch(error){
      if(error instanceof ApiError&&error.status>=400&&error.status<500&&error.status!==408&&error.status!==429)pendingKeys.current.delete(fingerprint);
      throw error;
    }
  }
  const billingPost=<T,>(path:string,body:unknown)=>mutation<T>('POST',path,body);
  const billingPatch=(path:string,body:unknown)=>mutation('PATCH',path,body);
  const billingDelete=(path:string)=>mutation('DELETE',path);

  const [overview,setOverview]=useState<BillingOverview|null>(null),[invoices,setInvoices]=useState<Invoice[]|null>(invoiceProp??null);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [projectName,setProjectName]=useState('');
  const [milestoneProject,setMilestoneProject]=useState(''),[milestoneLabel,setMilestoneLabel]=useState(''),[milestoneAmount,setMilestoneAmount]=useState(''),[milestoneCurrency,setMilestoneCurrency]=useState<Currency>('CAD');
  const [deliverableInvoice,setDeliverableInvoice]=useState(''),[deliverableLabel,setDeliverableLabel]=useState(''),[deliverableUrl,setDeliverableUrl]=useState('');
  const refresh=useCallback(async()=>{setOverview(await api<BillingOverview>('/api/billing/projects'));},[]);
  useEffect(()=>{const abort=new AbortController();void refresh().catch(e=>{if(!abort.signal.aborted)setError(e instanceof Error?e.message:'Billing records could not be loaded.');});return()=>abort.abort();},[refresh]);
  useEffect(()=>{if(invoiceProp||invoices!==null)return;const abort=new AbortController();void api<{invoices:Invoice[]}>('/api/invoices',{signal:abort.signal}).then(value=>setInvoices(value.invoices)).catch(()=>{});return()=>abort.abort();},[invoiceProp,invoices]);
  async function run(label:string,work:()=>Promise<void>){if(busy)return;setBusy(true);setError('');setNotice('');try{await work();await refresh();setNotice(label);}catch(e){setError(e instanceof Error?e.message:'This action could not be completed.');}finally{setBusy(false);}}
  function plannedAmount(){const value=parseInvoiceAmount(milestoneAmount,milestoneCurrency);if(value<=0)throw new Error('Enter a positive planned amount.');return value;}
  const invoicePicker=(value:string,onChange:(next:string)=>void,ariaLabel:string,noneLabel:string)=>(
    <select aria-label={ariaLabel} value={value} disabled={busy} onChange={event=>onChange(event.target.value)}>
      <option value="">{noneLabel}</option>
      {(invoices??[]).map(invoice=><option key={invoice.id} value={invoice.id}>{invoice.number} · {invoice.title} · {money(invoice.total,invoice.currency)}</option>)}
    </select>
  );
  const projectPicker=(value:string,onChange:(next:string)=>void,ariaLabel:string)=>(
    <select aria-label={ariaLabel} value={value} disabled={busy} onChange={event=>onChange(event.target.value)}>
      <option value="">No project</option>
      {(overview?.projects??[]).map(project=><option key={project.id} value={project.id}>{project.name}</option>)}
    </select>
  );
  const deliverableRow=(deliverable:BillingDeliverableView)=>(
    <li className="billing-deliverable" key={deliverable.id}>
      <div className="billing-deliverable-main">
        <strong>{deliverable.label}</strong>
        <div className="billing-deliverable-meta">
          {deliverable.released?<Badge tone="good">Released</Badge>:<Badge tone="warm">Locked</Badge>}
          <span>{deliverable.releaseReady?'Verified paid — shown on checkout while released.':'Not shown until an authoritative live payment covers the invoice.'}</span>
          {deliverable.invoiceNumber?<span>On {deliverable.invoiceNumber}</span>:null}
        </div>
      </div>
      <div className="billing-deliverable-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={()=>void run(deliverable.released?'Deliverable hidden again.':'Release requested. Payment is rechecked before the link is shown.',async()=>{await (deliverable.released?billingPost(`/deliverables/${encodeURIComponent(deliverable.id)}/unrelease`,{}):billingPost(`/deliverables/${encodeURIComponent(deliverable.id)}/release`,{}));})}>{deliverable.released?'Unrelease':'Release'}</button>
        <form className="billing-inline-field" onSubmit={event=>{event.preventDefault();const input=event.currentTarget.elements[0] as HTMLInputElement;void run('Delivery link updated. Release was cleared — release it again after checking the destination.',async()=>{await billingPatch(`/deliverables/${encodeURIComponent(deliverable.id)}`,{url:input.value});});}}>
          <label className="micro">Replace link<input aria-label={`New delivery link for ${deliverable.label}`} type="url" maxLength={2000} placeholder="https://" disabled={busy}/></label>
          <button type="submit" className="text-button" disabled={busy}>Update link</button>
        </form>
        <button type="button" className="icon-button" aria-label={`Delete deliverable ${deliverable.label}`} title={`Delete deliverable ${deliverable.label}`} disabled={busy} onClick={()=>{if(window.confirm(`Delete the deliverable "${deliverable.label}"? Its link disappears from checkout.`))void run('Deliverable deleted.',async()=>{await billingDelete(`/deliverables/${encodeURIComponent(deliverable.id)}`);});}}><Trash2 size={16}/></button>
      </div>
    </li>
  );
  const milestoneRow=(milestone:BillingMilestoneView)=>(
    <li className="billing-milestone" key={milestone.id}>
      <div className="billing-milestone-main">
        <strong>{milestone.label}</strong>
        <div className="billing-milestone-meta">
          <span className="billing-amount">Planned {money(milestone.amount,milestone.currency)}</span>
          {milestone.invoice?<><span>{milestone.invoice.number} · {stateLabels[milestone.invoice.state]} · effective {money(milestone.invoice.effectiveTotal,milestone.invoice.currency)} · due {money(milestone.invoice.due,milestone.invoice.currency)} · {milestone.invoice.mode}</span>
          {milestone.amount!==milestone.invoice.effectiveTotal||milestone.currency!==milestone.invoice.currency?<span className="billing-mismatch">Planned amount differs from the invoice's authoritative total.</span>:null}</>:<span>No invoice linked yet.</span>}
        </div>
      </div>
      <div className="billing-milestone-actions">
        {invoicePicker(milestone.invoice?.id??'',next=>void run(next?'Milestone linked.':'Milestone unlinked.',async()=>{await billingPatch(`/milestones/${encodeURIComponent(milestone.id)}`,{invoiceId:next||null});}),`Linked invoice for ${milestone.label}`,'No invoice')}
        <button type="button" className="button secondary" disabled={busy} onClick={()=>navigate(`/billing/milestones/${encodeURIComponent(milestone.id)}/invoice`)}><FileText size={15}/>{milestone.invoice?'Replace invoice':'Create invoice'}</button>
        <form className="billing-inline-field" onSubmit={event=>{event.preventDefault();const input=event.currentTarget.elements[0] as HTMLInputElement;void run('Milestone renamed.',async()=>{await billingPatch(`/milestones/${encodeURIComponent(milestone.id)}`,{label:input.value});});}}>
          <label className="micro">Rename<input aria-label={`Label for ${milestone.label}`} maxLength={240} defaultValue={milestone.label} disabled={busy}/></label>
          <button type="submit" className="text-button" disabled={busy}>Save label</button>
        </form>
        <button type="button" className="icon-button" aria-label={`Delete milestone ${milestone.label}`} title={`Delete milestone ${milestone.label}`} disabled={busy} onClick={()=>{if(window.confirm(`Delete the milestone "${milestone.label}"? Issued invoices, receipts and deliverables stay saved.`))void run('Milestone deleted.',async()=>{await billingDelete(`/milestones/${encodeURIComponent(milestone.id)}`);});}}><Trash2 size={16}/></button>
      </div>
      {milestone.deliverables.length?<ul className="billing-deliverables">{milestone.deliverables.map(deliverable=>deliverableRow(deliverable))}</ul>:null}
    </li>
  );
  if(error&&!overview)return <main className="main-content"><PageHeading eyebrow="BILLING PLANNING" title="Projects & milestones."/><ErrorMessage message={error}/></main>;
  if(!overview)return <main className="main-content"><Loading label="Opening your billing records…"/></main>;
  return <main className="main-content">
    <PageHeading eyebrow="BILLING PLANNING" title="Projects & milestones." description="Optional planning records tied to your existing invoices. Planned amounts are notes; the issued invoice and its ledger stay authoritative." action={<Link to="/invoices/new" className="button secondary">Create an invoice</Link>}/>
    {error?<ErrorMessage message={error}/>:null}{notice?<p role="status" className="success-message">{notice}</p>:null}
    <SectionCard title="Projects" description="Group milestone plans per piece of work. Deleting a project requires an empty milestone list." className="billing-section">
      <form onSubmit={event=>{event.preventDefault();void run('Project created.',async()=>{await billingPost('/projects',{name:projectName});setProjectName('');});}}>
        <label className="field">New project name<input aria-label="New project name" value={projectName} maxLength={240} required onChange={event=>setProjectName(event.target.value)} placeholder="e.g. Studio retainer · Q4"/></label>
        <button className="button primary" disabled={busy}><Plus size={16}/>Add project</button>
      </form>
      {overview.projects.length?overview.projects.map((project:BillingProjectView)=>(
        <article className="billing-project" key={project.id}>
          <header>
            <div className="billing-project-name">
              <h3>{project.name}</h3>
              <form className="billing-inline-field" onSubmit={event=>{event.preventDefault();const input=event.currentTarget.elements[0] as HTMLInputElement;void run('Project renamed.',async()=>{await billingPatch(`/projects/${encodeURIComponent(project.id)}`,{name:input.value});});}}>
                <label className="micro">Rename<input aria-label={`Project name for ${project.name}`} maxLength={240} defaultValue={project.name} disabled={busy}/></label>
                <button type="submit" className="text-button" disabled={busy}>Save name</button>
              </form>
            </div>
            <button type="button" className="icon-button" aria-label={`Delete project ${project.name}`} title={`Delete project ${project.name}`} disabled={busy} onClick={()=>{if(window.confirm(`Delete the project "${project.name}"? This works only when it has no milestones.`))void run('Project deleted.',async()=>{await billingDelete(`/projects/${encodeURIComponent(project.id)}`);});}}><Trash2 size={16}/></button>
          </header>
          <ul className="billing-milestones">{project.milestones.map(milestone=>milestoneRow(milestone))}</ul>
        </article>
      )):<p className="muted">No projects yet. Add one above, or save a milestone without a project below.</p>}
      <form onSubmit={event=>{event.preventDefault();void run('Milestone saved.',async()=>{await billingPost('/milestones',{label:milestoneLabel,amount:plannedAmount(),currency:milestoneCurrency,...(milestoneProject?{projectId:milestoneProject}:{})});setMilestoneLabel('');setMilestoneAmount('');});}}>
        <label className="field">Milestone label<input aria-label="Milestone label" value={milestoneLabel} maxLength={240} required onChange={event=>setMilestoneLabel(event.target.value)} placeholder="e.g. Final cut delivery"/></label>
        <label className="field">Planned amount<input aria-label="Planned amount" value={milestoneAmount} required inputMode="decimal" onChange={event=>setMilestoneAmount(event.target.value)} placeholder={milestoneCurrency==='SAT'?'210000':'1250.00'}/></label>
        <label className="field">Currency<select aria-label="Planned currency" value={milestoneCurrency} onChange={event=>setMilestoneCurrency(event.target.value as Currency)}>{currencies.map(currency=><option key={currency} value={currency}>{currency}</option>)}</select></label>
        <label className="field">Project <small>Optional</small>{projectPicker(milestoneProject,setMilestoneProject,'Milestone project')}</label>
        <button className="button primary" disabled={busy}><Plus size={16}/>Add milestone</button>
      </form>
      {overview.looseMilestones.length?<><h3 className="micro">Milestones without a project</h3><ul className="billing-milestones">{overview.looseMilestones.map(milestone=>milestoneRow(milestone))}</ul></>:null}
    </SectionCard>
    <SectionCard title="Deliverables" description="Invoice-linked delivery destinations, shown on the payer's checkout only after an authoritative live payment and your explicit release." className="billing-section">
      <form onSubmit={event=>{event.preventDefault();void run('Deliverable saved.',async()=>{await billingPost('/deliverables',{invoiceId:deliverableInvoice,label:deliverableLabel,url:deliverableUrl});setDeliverableLabel('');setDeliverableUrl('');});}}>
        <label className="field">Invoice{invoicePicker(deliverableInvoice,setDeliverableInvoice,'Deliverable invoice','Choose an invoice')}</label>
        <label className="field">Deliverable label<input aria-label="Deliverable label" value={deliverableLabel} maxLength={240} required onChange={event=>setDeliverableLabel(event.target.value)} placeholder="e.g. Final recording (MP4)"/></label>
        <label className="field">Delivery link (https://)<input aria-label="Delivery link" type="url" value={deliverableUrl} maxLength={2000} required onChange={event=>setDeliverableUrl(event.target.value)} placeholder="https://your-host.example/file"/></label>
        <button className="button primary" disabled={busy}><Plus size={16}/>Add deliverable</button>
      </form>
      {overview.deliverables.length?<ul className="billing-deliverables">{overview.deliverables.map(deliverable=>deliverableRow(deliverable))}</ul>:<p className="muted">No deliverables yet. Add an invoice-linked https link above.</p>}
      <div className="privacy-note billing-forwarded-warning"><strong>Forwarded links have no take-back.</strong>
        <p className="micro">Once a payer receives an external HTTPS link, Quiet Ledger cannot retroactively revoke, watermark, expire or access-control that destination. There is no DRM, view-auth or download-count promise. Use expiring or signed links on your own host if forwarding is a concern; Quiet Ledger only gates the display of the link inside its own checkout. Links are never fetched, proxied or previewed by this application.</p>
      </div>
    </SectionCard>
    <PrivacyNote>Billing planning records are encrypted workspace data. Releasing a deliverable never sends an email or message; the payer sees the link on their existing checkout only after a verified live payment.</PrivacyNote>
  </main>;
}
