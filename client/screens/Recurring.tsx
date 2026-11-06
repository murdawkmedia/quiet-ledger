import {useEffect,useRef,useState} from 'react';
import type {InvoiceTemplate} from '../../shared/invoice-options';
import type {RecurringDraft,RecurringPlan,RecurringPrepareResult} from '../../shared/recurring';
import {actionKey,api,ApiError,date,post} from '../api';
import {ErrorMessage,Link,Loading,PageHeading} from '../components';
import '../recurring.css';

type PendingAction={path:string;body:Record<string,unknown>;key:string;kind:'create'|'prepare'|'pause'};
const frequencyLabel=(plan:RecurringPlan)=>plan.frequency.type==='monthly'?'Monthly':`Every ${plan.frequency.intervalDays} days`;
export function RecurringPage(){
 const [plans,setPlans]=useState<RecurringPlan[]>(),[drafts,setDrafts]=useState<RecurringDraft[]>(),[templates,setTemplates]=useState<InvoiceTemplate[]>();
 const [templateId,setTemplateId]=useState(''),[label,setLabel]=useState(''),[startDate,setStartDate]=useState(()=>new Date().toISOString().slice(0,10)),[frequency,setFrequency]=useState('monthly'),[intervalDays,setIntervalDays]=useState('30'),[dueOffset,setDueOffset]=useState('');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[pending,setPending]=useState<PendingAction|null>(null),[hasMore,setHasMore]=useState(false);
 const inFlight=useRef(false),mounted=useRef(true);
 const selected=templates?.find(row=>row.id===templateId),legacyDue=selected?.draft.paymentTermDays===undefined&&Boolean(selected?.draft.dueDate);
 const loaded=plans!==undefined&&drafts!==undefined&&templates!==undefined,disabled=busy||pending!==null||!loaded;
 async function load(signal?:AbortSignal){
  const [p,d,t]=await Promise.all([api<{plans:RecurringPlan[]}>('/api/recurring/plans',{signal}),api<{drafts:RecurringDraft[]}>('/api/recurring/drafts',{signal}),api<{templates:InvoiceTemplate[]}>('/api/invoice-templates',{signal})]);
  if(mounted.current){setPlans(p.plans);setDrafts(d.drafts);setTemplates(t.templates);}
 }
 useEffect(()=>{mounted.current=true;const abort=new AbortController();void load(abort.signal).catch(e=>{if(!abort.signal.aborted)setError(e.message);});return()=>{mounted.current=false;abort.abort();};},[]);
 async function execute(action:PendingAction){
  if(inFlight.current)return;inFlight.current=true;setBusy(true);setError('');setNotice('');setPending(action);
  try{
   const result=await post<RecurringPrepareResult>(action.path,action.body,action.key);if(!mounted.current)return;
   setPending(null);
   if(action.kind==='prepare'){setHasMore(result.hasMore);setNotice(result.createdCount===0?'No new drafts are due.':`${result.createdCount} ${result.createdCount===1?'draft is':'drafts are'} ready for review.`);}
   else if(action.kind==='create'){setLabel('');setNotice('Recurring plan saved. Prepare due drafts when you are ready.');}
   else setNotice(action.body.paused?'Plan paused.':'Plan resumed. Prepare due drafts to catch up.');
   await load();
  }catch(e){if(mounted.current){setError((e as Error).message);if(e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==408)setPending(null);}}
  finally{inFlight.current=false;if(mounted.current)setBusy(false);}
 }
 function save(event:React.FormEvent){event.preventDefault();if(disabled)return;
  const body={templateId,label,startDate,frequency:frequency==='monthly'?{type:'monthly'}:{type:'days',intervalDays:Number(intervalDays)},...(legacyDue?{dueOffsetDays:Number(dueOffset)}:{})};
  void execute({path:'/api/recurring/plans',body,key:actionKey(),kind:'create'});
 }
 return <div className="recurring-page"><PageHeading eyebrow="AT YOUR OWN PACE" title="Recurring drafts." description="Save a rhythm for repeat work. Prepare due drafts, then review and issue each invoice yourself."/>
  {error?<ErrorMessage message={error}/>:null}
  {notice?<p className="success-message" role="status">{notice}</p>:null}
  {pending&&!busy?<div className="recurring-retry"><p>The result is uncertain. Retry the saved action to recover its outcome.</p><button className="button secondary" onClick={()=>void execute(pending)}>Retry saved action</button></div>:null}
  <div className="recurring-grid"><section className="panel recurring-form"><span className="eyebrow">01 · SAVE THE RHYTHM</span><h2>Create a recurring plan</h2>
   <p className="muted">Each plan keeps a snapshot of its template. Later template edits apply to new plans.</p>
   <form onSubmit={save}><fieldset className="recurring-fields" disabled={disabled}>
    <label className="field">Saved invoice template<select aria-label="Saved invoice template" required value={templateId} onChange={e=>{setTemplateId(e.target.value);setDueOffset('');}}><option value="">Choose a saved template</option>{templates?.map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
    {templates?.length===0?<p>Save an invoice template in the <Link to="/invoices/new">invoice editor</Link> first.</p>:null}
    <label className="field">Plan name<input aria-label="Plan name" required maxLength={80} value={label} onChange={e=>setLabel(e.target.value)}/></label>
    <label className="field">First issue date<input aria-label="First issue date" type="date" required min="0001-01-01" max="9999-12-31" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label>
    <label className="field">Frequency<select aria-label="Frequency" value={frequency} onChange={e=>setFrequency(e.target.value)}><option value="monthly">Monthly</option><option value="days">Every fixed number of days</option></select></label>
    {frequency==='days'?<label className="field">Repeat every (days)<input aria-label="Repeat every (days)" type="number" required min={1} max={3650} step={1} value={intervalDays} onChange={e=>setIntervalDays(e.target.value)}/></label>:<p className="recurring-hint">Monthly plans keep the first date's day of the month. Shorter months use their last day.</p>}
    {legacyDue?<div className="recurring-conversion"><p>This template has an absolute due date. Choose a relative payment term for each recurring invoice.</p><label className="field">Days until payment is due<input aria-label="Days until payment is due" type="number" required min={0} max={3650} step={1} value={dueOffset} onChange={e=>setDueOffset(e.target.value)}/></label></div>:selected?.draft.paymentTermDays!==undefined?<p className="recurring-hint">Payment is due {selected.draft.paymentTermDays===0?'on the issue date':`${selected.draft.paymentTermDays} days after each issue date`}.</p>:null}
    <button className="button primary" disabled={disabled||!templateId}>{busy&&pending?.kind==='create'?'Saving…':'Save recurring plan'}</button>
   </fieldset></form>
  </section>
  <section className="panel recurring-form"><span className="eyebrow">02 · PREPARE WHEN READY</span><h2>Your plans</h2>
   <p className="muted">The first issue date starts each plan. Preparing catches up through today, at most 24 drafts at a time.</p>
   <div className="recurring-actions"><button className="button primary" disabled={disabled||!plans?.some(plan=>!plan.paused)} onClick={()=>void execute({path:'/api/recurring/prepare',body:{},key:actionKey(),kind:'prepare'})}>{busy&&pending?.kind==='prepare'?'Preparing…':'Prepare due drafts'}</button></div>
   {hasMore?<p role="status">More periods are due. Prepare due drafts again for the next batch.</p>:null}
   {!plans?<Loading/>:plans.length?<ul className="recurring-list">{plans.map(plan=><li key={plan.id}><div className="recurring-row"><strong>{plan.label}</strong><span className="recurring-state">{plan.paused?'Paused':'Active'}</span></div><p>{frequencyLabel(plan)} · from {date(plan.startDate)}</p><p className="muted">{plan.templateLabel}{plan.dueOffsetDays!==undefined?` · Due after ${plan.dueOffsetDays} days`:''}</p><button className="button secondary" disabled={disabled} aria-label={`${plan.paused?'Resume':'Pause'} ${plan.label}`} onClick={()=>void execute({path:`/api/recurring/plans/${encodeURIComponent(plan.id)}/pause`,body:{paused:!plan.paused},key:actionKey(),kind:'pause'})}>{plan.paused?'Resume plan':'Pause plan'}</button></li>)}</ul>:<p>No recurring plans saved yet.</p>}
  </section></div>
  <section className="panel recurring-form recurring-drafts"><span className="eyebrow">03 · REVIEW EVERY INVOICE</span><h2>Prepared drafts</h2><p className="muted">Open a draft to review its dates, amounts and payment terms before issuing.</p>
   {!drafts?<Loading/>:drafts.length?<ul className="recurring-list recurring-draft-list">{drafts.map(draft=><li key={draft.id}><div><strong>{draft.draft.title}</strong><p>{draft.planLabel} · {date(draft.periodDate)}</p><p className="muted">{draft.draft.customerName} · {draft.draft.currency}{draft.draft.dueDate?` · Due ${date(draft.draft.dueDate)}`:''}</p></div>{draft.status==='issued'?<Link className="button secondary" to={`/invoices/${encodeURIComponent(draft.invoiceId!)}/ledger`}>Open issued invoice</Link>:<Link className="button secondary" to={`/recurring/drafts/${encodeURIComponent(draft.id)}`}>Review draft</Link>}</li>)}</ul>:<p>No prepared drafts yet. Choose Prepare due drafts when you are ready.</p>}
  </section>
 </div>;
}
