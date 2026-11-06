import {useEffect,useRef,useState} from 'react';
import {ArrowLeft,ArrowUpRight,CheckCircle2,RefreshCw} from 'lucide-react';
import type {InvoiceLedgerView} from '../../shared/invoice-ledger';
import {invoiceAllowsMethod,parseInvoiceAmount,currencyScale} from '../../shared/invoice-options';
import {METHOD_DEFINITIONS,type MethodId} from '../../shared/payment-methods';
import {receivingAdapterSupportsCurrency} from '../../shared/receiving';
import {actionKey,api,ApiError,date,methodLabel,money,post} from '../api';
import {Badge,CopyButton,ErrorMessage,Link,Loading,PageHeading,PrivacyNote,SectionCard} from '../components';
import type {AdapterView,ReceiveRequest} from './Receiving';

type ReceivingView={adapters:AdapterView[];requests:ReceiveRequest[];nextCursor?:string|null};
type PendingAction={kind:'receiving'|'credit'|'void';path:string;body:Record<string,unknown>;key:string};
const stateLabels={unpaid:'Unpaid',partially_paid:'Partially paid',paid:'Paid',credited:'Credited',void:'Void'};
const amountText=(amount:number,currency:string)=>(amount/currencyScale(currency)).toFixed(currency==='KRW'?0:2);

export function InvoiceLedger({id,onChanged}:{id:string;onChanged:()=>Promise<void>}){
  const [view,setView]=useState<InvoiceLedgerView|null>(null),[receiving,setReceiving]=useState<ReceivingView>({adapters:[],requests:[]});
  const [error,setError]=useState(''),[receivingError,setReceivingError]=useState(''),[busy,setBusy]=useState(false),[refreshing,setRefreshing]=useState(false),[notice,setNotice]=useState('');
  const [amount,setAmount]=useState(''),[method,setMethod]=useState(''),[adapterId,setAdapterId]=useState('');
  const [creditAmount,setCreditAmount]=useState(''),[creditReason,setCreditReason]=useState(''),[voidReason,setVoidReason]=useState(''),[voidConfirmed,setVoidConfirmed]=useState(false);
  const [pending,setPending]=useState<PendingAction|null>(null),epoch=useRef(0),loadSequence=useRef(0),inFlight=useRef(false);
  async function invoiceRequests():Promise<ReceivingView>{
    const requests:ReceiveRequest[]=[],seen=new Set<string>();let cursor:string|undefined,adapters:AdapterView[]=[];
    for(let page=0;page<100;page++){
      const query=new URLSearchParams({invoiceId:id,limit:'100',...(cursor?{cursor}:{})});
      const result=await api<ReceivingView>('/api/receiving?'+query);adapters=result.adapters;requests.push(...result.requests);
      if(!result.nextCursor)return {adapters,requests};
      if(seen.has(result.nextCursor))throw new Error('Payment request pagination did not advance.');
      seen.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw new Error('Payment requests exceed the supported page limit.');
  }
  async function load(initial=false){
    const current=epoch.current,sequence=++loadSequence.current;setRefreshing(true);
    const result=await Promise.allSettled([api<InvoiceLedgerView>(`/api/invoices/${encodeURIComponent(id)}/ledger`),invoiceRequests()]);
    if(current!==epoch.current||sequence!==loadSequence.current)return;
    if(result[0].status==='fulfilled'){
      const next=result[0].value;setView(next);
      if(initial){setAmount(amountText(next.balance.due,next.balance.currency));setCreditAmount(amountText(next.balance.due,next.balance.currency));}
    }else setError(result[0].reason.message);
    if(result[1].status==='fulfilled'){
      const next=result[1].value;setReceiving(next);setReceivingError('');
      if(initial&&result[0].status==='fulfilled'){
        const invoice=result[0].value.invoice;
        const adapter=next.adapters.find(row=>row.mode==='live'&&row.configured!==false&&row.methods.some(value=>invoiceAllowsMethod(invoice,value as MethodId)&&receivingAdapterSupportsCurrency(row,invoice.currency,value)));
        const selected=adapter?.methods.find(value=>invoiceAllowsMethod(invoice,value as MethodId)&&receivingAdapterSupportsCurrency(adapter,invoice.currency,value));
        setMethod(selected??'');setAdapterId(adapter?.id??'');
      }
    }else setReceivingError('Payment requests could not be refreshed. Retry before creating a request.');
    setRefreshing(false);
  }
  useEffect(()=>{void load(true);return()=>{epoch.current++;loadSequence.current++;};},[id]);
  const invoice=view?.invoice,balance=view?.balance;
  const eligible=receiving.adapters.filter(row=>row.mode==='live'&&row.configured!==false).map(row=>({...row,methods:row.methods.filter(value=>invoice&&invoiceAllowsMethod(invoice,value as MethodId)&&receivingAdapterSupportsCurrency(row,invoice.currency,value))})).filter(row=>row.methods.length);
  const choices=eligible.filter(row=>row.methods.includes(method)),outstanding=receiving.requests.some(row=>row.invoiceId===id&&row.mode==='live'&&row.status!=='paid');
  const locked=busy||refreshing||Boolean(pending),collectable=Boolean(balance&&balance.due>0&&!['void','credited'].includes(balance.state));
  function positiveAmount(text:string){
    const value=parseInvoiceAmount(text,balance!.currency);
    if(value<=0)throw new Error('Enter a positive amount.');
    if(value>balance!.due)throw new Error('Amount cannot exceed the current amount due. Refresh the balance if it has changed.');
    return value;
  }
  async function submit(action:PendingAction){
    if(inFlight.current)return;inFlight.current=true;const current=epoch.current;setBusy(true);setError('');setNotice('');setPending(action);
    try{
      if(action.kind==='receiving'){
        const result=await post<{request:ReceiveRequest}>(action.path,action.body,action.key);
        if(current!==epoch.current)return;
        setReceiving(existing=>({...existing,requests:[result.request,...existing.requests.filter(row=>row.id!==result.request.id)]}));setNotice('Payment request saved. Open its payment page below.');
      }else{
        const result=await post<InvoiceLedgerView>(action.path,action.body,action.key);
        if(current!==epoch.current)return;setView(result);setNotice(action.kind==='credit'?'Credit note recorded. No payment receipt was created.':'Invoice voided. No payment receipt was created.');
        if(action.kind==='credit'){setCreditReason('');setCreditAmount('');}else{setVoidConfirmed(false);setVoidReason('');}
      }
      setPending(null);await load();if(current===epoch.current)await onChanged();
    }catch(e){
      if(current!==epoch.current)return;
      // An uncertain response retains the exact operation. Retrying may recover a
      // saved result; it must never allocate a second amount or issue a new key.
      const definitive=e instanceof ApiError&&e.status>=400&&e.status<500&&e.status!==408&&e.code!=='RECEIVING_UNCERTAIN';
      if(definitive)setPending(null);
      setError((e as Error).message);await load();
    }finally{if(current===epoch.current){setBusy(false);inFlight.current=false;}}
  }
  function create(event:React.FormEvent){
    event.preventDefault();if(locked||!collectable)return;
    try{const value=positiveAmount(amount);if(!method||!choices.some(row=>row.id===adapterId))throw new Error('Choose a configured payment method and connection.');void submit({kind:'receiving',path:'/api/receiving',body:{invoiceId:id,amount:value,method,adapterId},key:actionKey()});}catch(e){setError((e as Error).message);}
  }
  function credit(event:React.FormEvent){
    event.preventDefault();if(locked||!collectable)return;
    try{const value=positiveAmount(creditAmount);if(!creditReason.trim())throw new Error('Enter a reason for the credit note.');void submit({kind:'credit',path:`/api/invoices/${encodeURIComponent(id)}/credits`,body:{amount:value,reason:creditReason.trim()},key:actionKey()});}catch(e){setError((e as Error).message);}
  }
  function voidInvoice(event:React.FormEvent){
    event.preventDefault();if(locked||!view||balance!.paid!==0||outstanding||receivingError||!collectable||!voidConfirmed)return;
    if(!voidReason.trim()){setError('Enter a reason for voiding this invoice.');return;}
    void submit({kind:'void',path:`/api/invoices/${encodeURIComponent(id)}/void`,body:{reason:voidReason.trim()},key:actionKey()});
  }
  if(!view)return error?<ErrorMessage message={error} onRetry={()=>void load(true)}/>:<Loading label="Opening the invoice ledger…"/>;
  return <div className="invoice-ledger">
    <Link to="/invoices" className="text-link"><ArrowLeft size={15}/>All invoices</Link>
    <PageHeading eyebrow={invoice!.number} title="Invoice ledger" description={`${invoice!.title} · ${invoice!.customerName}`} action={<button className="button secondary" disabled={busy||refreshing} onClick={()=>void load()}><RefreshCw size={16}/>{refreshing?'Refreshing…':'Refresh balance'}</button>}/>
    <div className="ledger-status"><Badge tone={balance!.due===0?'good':'warm'}>{stateLabels[balance!.state]}</Badge><span>{balance!.mode==='live'?'Live invoice ledger':'Simulation ledger'} · {balance!.currency}</span><Link to={`/pay/${invoice!.token}`} className="text-link">Customer invoice<ArrowUpRight size={15}/></Link></div>
    {error?<ErrorMessage message={error}/>:null}
    {notice?<div className="success-message" role="status"><CheckCircle2 size={18}/>{notice}</div>:null}
    {pending&&!busy?<div className="review-message" role="status"><strong>The last response is uncertain.</strong><p>The saved amount and details are fixed until the same request returns a result. The current balance is shown below.</p><button className="button secondary" disabled={refreshing} onClick={()=>void submit(pending)}>Retry saved {pending.kind==='receiving'?'payment request':pending.kind==='credit'?'credit note':'void'}</button></div>:null}
    <dl className="ledger-balances" aria-label="Invoice balance">
      {([['total','Original total'],['paid','Paid'],['credited','Credits'],['due','Amount due'],['overpaid','Overpaid']] as const).map(([key,label])=><div key={key} className={key==='due'?'ledger-balance-due':''}><dt>{label}</dt><dd data-testid={`ledger-${key}`}>{money(balance![key],balance!.currency)}</dd></div>)}
    </dl>
    {balance!.overpaid>0?<p className="review-message">The recorded value exceeds the invoice total. Review the individual payments and credits before arranging any refund.</p>:null}
    <SectionCard title="Ledger entries" description="Payments, credits and voids remain separate in this permanent record.">
      {view.entries.length?<div className="table-scroll"><table className="data-table ledger-entries"><thead><tr><th>Entry</th><th>Recorded</th><th className="numeric">Amount</th><th>Details</th></tr></thead><tbody>{view.entries.map(entry=><tr key={entry.id}><td><strong>{entry.kind==='payment'?'Payment':entry.kind==='credit'?'Credit note':'Void'}</strong></td><td>{date(entry.createdAt)}</td><td className="numeric">{money(entry.amount,entry.currency)}</td><td>{entry.reason?<p>{entry.reason}</p>:null}{entry.method?<span>{methodLabel(entry.method)}{entry.verification?` · ${entry.verification==='provider'?'Provider verified':'Owner verified'}`:''}</span>:null}{entry.kind==='payment'&&entry.receiptToken?<Link to={`/receipt/${entry.receiptToken}`} className="text-link">Receipt {entry.receiptNumber??entry.id}<ArrowUpRight size={14}/></Link>:null}</td></tr>)}</tbody></table></div>:<p className="ledger-empty">No payments or adjustments recorded.</p>}
    </SectionCard>
    <SectionCard title="Payment requests" description="Each request keeps its original amount and quote. Opening a request does not record a payment.">
      {receivingError?<ErrorMessage message={receivingError}/>:null}
      {collectable?<form className="ledger-form" onSubmit={create}>
        <label className="field">Payment request amount ({balance!.currency})<input inputMode={balance!.currency==='KRW'?'numeric':'decimal'} required value={amount} disabled={locked} onChange={event=>setAmount(event.target.value)}/></label>
        <label className="field">Receiving method<select value={method} disabled={locked} required onChange={event=>{setMethod(event.target.value);setAdapterId(eligible.find(row=>row.methods.includes(event.target.value))?.id??'');}}>{!method?<option value="">Choose a method</option>:null}{METHOD_DEFINITIONS.filter(row=>eligible.some(adapter=>adapter.methods.includes(row.id))).map(row=><option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
        <label className="field">Payment connection<select value={adapterId} disabled={locked} required onChange={event=>setAdapterId(event.target.value)}>{!adapterId?<option value="">Choose a connection</option>:null}{choices.map(row=><option key={row.id} value={row.id}>{row.label??row.id}</option>)}</select></label>
        <button className="button primary" disabled={locked||!method||!choices.some(row=>row.id===adapterId)||Boolean(receivingError)}>Create payment request</button>
        {!eligible.length?<p>No configured live connection supports this invoice’s currency and accepted methods. <Link to="/payment-methods" className="text-link">Review payment methods</Link></p>:null}
      </form>:null}
      <div className="ledger-request-list">{receiving.requests.filter(row=>row.invoiceId===id).map(row=><article key={row.id}><div><strong>{money(row.amount,row.currency)} {row.currency}</strong><p>{methodLabel(row.method)} · {row.mode==='live'?'Live':'Test'} · {row.status==='paid'?'Verified':row.status==='creation_pending'?'Creation needs recovery':row.reviewReason?'Owner review required':'Awaiting payment'}</p></div><div className="row-actions"><Link to={`/receive/${row.token}`} className="text-link">Open payment request<ArrowUpRight size={14}/></Link><CopyButton value={`${location.origin}/receive/${row.token}`} label="Copy receiving page"/></div></article>)}</div>
    </SectionCard>
    {collectable?<div className="ledger-adjustments"><SectionCard title="Credit note" description="Reduce the amount due with a recorded reason. A credit creates no payment or receipt."><form onSubmit={credit}><label className="field">Credit amount ({balance!.currency})<input required inputMode={balance!.currency==='KRW'?'numeric':'decimal'} value={creditAmount} disabled={locked} onChange={event=>setCreditAmount(event.target.value)}/></label><label className="field">Credit reason<textarea required maxLength={1000} value={creditReason} disabled={locked} onChange={event=>setCreditReason(event.target.value)}/></label><button className="button secondary" disabled={locked}>Record credit note</button></form></SectionCard>
      {balance!.paid===0?<SectionCard title="Void unpaid invoice" description="Retire an unpaid invoice while keeping its original amount and history."><form onSubmit={voidInvoice}>{outstanding?<p className="review-message">Existing external payment requests cannot be cancelled by voiding this invoice.</p>:null}<label className="field">Void reason<textarea required maxLength={1000} value={voidReason} disabled={locked} onChange={event=>setVoidReason(event.target.value)}/></label><label className="ledger-confirm"><input type="checkbox" checked={voidConfirmed} disabled={locked} onChange={event=>setVoidConfirmed(event.target.checked)}/><span>I confirm this unpaid invoice should be voided.</span></label><button className="button secondary" disabled={locked||outstanding||Boolean(receivingError)||!voidConfirmed||!voidReason.trim()}>Void unpaid invoice</button></form></SectionCard>:null}
    </div>:null}
    <PrivacyNote>The issued invoice total stays unchanged. Payment receipts record verified payments; credits and voids cannot establish a transfer of funds.</PrivacyNote>
  </div>;
}
