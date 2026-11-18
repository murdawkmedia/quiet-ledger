import {useEffect,useRef,useState} from 'react';
import type {ReceivingRecord} from '../shared/receiving';
import {api,post,actionKey} from './api';
import {sanitizeDemoLiveRequest,type DemoLivePaymentView} from '../shared/demo-live-payment';
import {CashuPaymentTools} from './screens/CashuWalletHandoff';
import {CopyButton} from './components';

function checkedView(value:DemoLivePaymentView):DemoLivePaymentView {
  if(!value||typeof value.enabled!=='boolean'||typeof value.receiver!=='string'||!value.receiver||value.receiver.length>254||value.amountSats!==21||value.rail!=='lightning')throw new Error('The real-payment sample is unavailable right now.');
  return {...value,...(value.request?{request:sanitizeDemoLiveRequest(value.request)}:{})};
}

/**
 * Optional real-payment sample inside the demo: one fixed 21-sat live Lightning
 * invoice for Count's existing Coinos receiver. No separate account, token or
 * seed entry; no receiver settings; payment is never simulated here and paid
 * status is only ever read back from the provider via the demo API.
 */
export function DemoLivePayment(){
  const [view,setView]=useState<DemoLivePaymentView|undefined>(undefined);
  const [error,setError]=useState<string|undefined>(undefined);
  const [busy,setBusy]=useState(false);
  const [acknowledged,setAcknowledged]=useState(false);
  const [clock,setClock]=useState(Date.now());
  const keyRef=useRef<string>('');
  const expiry=view?.request?Math.min(Date.parse(view.request.expiresAt),Date.parse(view.request.intent?.expiresAt??view.request.expiresAt)):undefined;
  useEffect(()=>{
    if(expiry===undefined||view?.request?.status==='paid'||!Number.isFinite(expiry))return;
    const timer=setTimeout(()=>setClock(Date.now()),Math.min(2147483647,Math.max(0,expiry-Date.now())));
    return()=>clearTimeout(timer);
  },[expiry,view?.request?.status]);
  useEffect(()=>{
    let active=true;
    api<DemoLivePaymentView>('/api/hackathon-demo/live-payment')
      .then(value=>{const checked=checkedView(value);if(active){setView(checked);setClock(Date.now());}})
      .catch(()=>{if(active)setError('The real-payment sample is unavailable right now.');});
    return()=>{active=false;};
  },[]);
  if(!view)return error?<p className="micro demo-live-payment" role="alert">{error}</p>:null;
  if(!view.enabled)return <section className="panel demo-live-payment" aria-label="Optional real Lightning payment sample">
    <h2>Optional real Lightning sample</h2>
    <p role="status">The real Lightning sample is unavailable right now. You can continue using the simulated demo.</p>
  </section>;
  const request=view.request;
  const expired=Boolean(request&&request.status!=='paid'&&expiry!==undefined&&expiry<=Math.max(clock,Date.now()));
  async function run(operation:()=>Promise<DemoLivePaymentView>){
    setBusy(true);setError(undefined);
    try{setView(checkedView(await operation()));setClock(Date.now());}
    catch(cause){
      // A lost response can still leave the original request reserved. Read it back;
      // no invoice creation or provider check is repeated automatically.
      try{setView(checkedView(await api<DemoLivePaymentView>('/api/hackathon-demo/live-payment')));setClock(Date.now());}catch{/* Retain the last validated view and retry identity. */}
      setError(cause instanceof Error&&cause.message?cause.message:'The real-payment sample is unavailable right now.');
    }
    finally{setBusy(false);}
  }
  const create=()=>run(()=>{
    // Keep this component's retry key stable; the server mapping also preserves
    // the original request identity across navigation, reload and server restart.
    keyRef.current=keyRef.current||actionKey();
    return post<DemoLivePaymentView>('/api/hackathon-demo/live-payment',{acknowledgeRealFunds:true},keyRef.current);
  });
  const check=()=>run(()=>post<DemoLivePaymentView>('/api/hackathon-demo/live-payment/check',{}));
  const refresh=()=>run(()=>api<DemoLivePaymentView>('/api/hackathon-demo/live-payment'));
  const state=()=>{
    if(!request)return undefined;
    if(request.status==='paid')return {tone:'good' as const,text:'Real Lightning payment received'};
    if(expired)return {tone:'warm' as const,text:'This invoice expired'};
    if(request.creationUncertain)return {tone:'warm' as const,text:'Still confirming the original invoice'};
    if(request.status==='creation_pending')return {tone:'warm' as const,text:'Creating the original invoice'};
    if(request.reviewReason)return {tone:'warm' as const,text:'Needs review before a receipt'};
    return {tone:'neutral' as const,text:'Waiting for payment'};
  };
  const badge=state();
  return <section className="panel demo-live-payment" aria-label="Optional real Lightning payment sample">
    <div className="panel-heading">
      <div>
        <h2>Optional real Lightning sample</h2>
        <p>Pay {view.receiver} exactly {view.amountSats} sats over Lightning with real funds. Paying is voluntary; the rest of this demo stays fictional and simulated. Your receipt will say Lightning, not simulated.</p>
      </div>
      {badge?<span className={`badge badge-${badge.tone}`}><i/>{badge.text}</span>:null}
    </div>
    {request?.status==='paid'&&request.receipt?<p className="micro">Receipt {request.receipt.number} — verified real Lightning payment of {request.receipt.amount} sats at {new Date(request.receipt.verifiedAt).toLocaleString()}.</p>:null}
    {!request&&!expired?<label className="receive-instruction demo-live-consent">
      <input type="checkbox" checked={acknowledged} onChange={event=>setAcknowledged(event.target.checked)}/>
      <span>I understand this creates a real 21-sat Lightning invoice for {view.receiver} and that real funds may move. This is not part of the simulated demo.</span>
    </label>:null}
    {!request&&!expired?<button type="button" className="button full" disabled={!acknowledged||busy} onClick={create}>{busy?'Preparing…':'Create my real 21-sat Lightning invoice'}</button>:null}
    {request&&!request.receipt&&!expired?<p className="micro">Only the original invoice for this visit is reused. A new invoice is never created automatically.</p>:null}
    {request?.creationUncertain?<p role="status">We are still confirming whether the original invoice was created. Do not pay a different invoice. Refresh its saved state or retry only the original request; nothing is recreated automatically.</p>:null}
    {request&&!busy&&!error&&!expired&&!request.reviewReason&&!request.creationUncertain&&request.status==='awaiting_payment'&&request.intent?.request?
      <div className="receive-instruction">
        <p>Pay exactly 21 sats from a Lightning wallet (Minibits or Zeus can melt ecash to this invoice; fees vary):</p>
        <div className="payment-request receiving-address"><code>{request.intent.request}</code><CopyButton value={request.intent.request} label="Copy Lightning invoice"/></div>
      </div>:null}
    {request?<CashuPaymentTools key={request.id} request={request as unknown as ReceivingRecord} onSettled={()=>void check()}/>:null}
    {expired?<p role="status">This visit's invoice expired and stays saved. Start a fresh demo visit for a new sample; nothing is recreated here automatically.</p>:null}
    {request?.reviewReason?<p role="alert">{request.reviewReason}</p>:null}
    {request?.status==='creation_pending'?<button type="button" className="button secondary full" disabled={busy} onClick={refresh}>{busy?'Refreshing…':'Refresh saved invoice'}</button>:null}
    {request?.status==='creation_pending'&&!expired?<button type="button" className="button secondary full" disabled={busy} onClick={create}>{busy?'Preparing…':'Retry original invoice'}</button>:null}
    {request?.intent&&request.status!=='paid'?<button type="button" className="button secondary full" disabled={busy} onClick={check}>{busy?'Checking…':'Check payment'}</button>:null}
    {error?<p className="micro" role="alert">{error}</p>:null}
  </section>;
}
