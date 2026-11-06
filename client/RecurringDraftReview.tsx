import {useEffect,useState} from 'react';
import type {Invoice} from '../shared/contracts';
import type {InvoiceDraft} from '../shared/invoice-options';
import type {RecurringDraft} from '../shared/recurring';
import {api,post} from './api';
import {ErrorMessage,Link,Loading,navigate} from './components';
import {InvoiceEditor} from './screens/InvoiceEditor';

export function RecurringDraftReview({id,onChanged}:{id:string;onChanged:()=>Promise<void>}){
 const [record,setRecord]=useState<RecurringDraft|null>(null),[error,setError]=useState('');
 useEffect(()=>{const controller=new AbortController();setRecord(null);setError('');void api<{draft:RecurringDraft}>(`/api/recurring/drafts/${encodeURIComponent(id)}`,{signal:controller.signal}).then(v=>{if(!controller.signal.aborted)setRecord(v.draft);}).catch(e=>{if(!controller.signal.aborted)setError(e.message);});return()=>controller.abort();},[id]);
 if(error)return <ErrorMessage message={error}/>;
 if(!record)return <Loading label="Opening the recurring draft…"/>;
 if(record.status==='issued')return <div className="panel form-panel"><h1>This draft has already been issued.</h1><p>Its saved invoice remains unchanged.</p>{record.invoiceId?<Link to={`/invoices/${record.invoiceId}/ledger`} className="button primary">Open invoice ledger</Link>:null}<Link to="/recurring" className="text-link">Back to recurring drafts</Link></div>;
 async function issue(draft:InvoiceDraft,key:string){const value=await post<{invoice:Invoice}>(`/api/recurring/drafts/${encodeURIComponent(id)}/issue`,{draft},key);return value.invoice;}
 return <><div className="review-message"><strong>Review before issuing.</strong><p>{record.planLabel} · period {record.periodDate}. This draft has not been emailed, charged or issued.</p><Link to="/recurring" className="text-link">Back to recurring drafts</Link></div><InvoiceEditor key={record.id} initialDraft={record.draft} submitDraft={issue} onCreated={async()=>{await onChanged();navigate('/invoices');}}/></>;
}
