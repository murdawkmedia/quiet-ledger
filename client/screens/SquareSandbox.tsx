import {useCallback,useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CheckCircle2,CreditCard,Download,RefreshCw,ShieldCheck} from 'lucide-react';
import {actionKey,api,date,downloadJson,money,post} from '../api';
import type {Invoice,SquareSandboxView,SquareTestCheckout} from '../../shared/contracts';
import {Badge,Brand,CopyButton,ErrorMessage,Link,Loading,PageHeading,PrivacyNote,SectionCard} from '../components';

const statusName={creation_pending:'Recover checkout',awaiting_payment:'Awaiting test payment',paid:'Test payment verified'};

export function SquareSandboxPage(){
  const [state,setState]=useState<SquareSandboxView|null>(null);
  const [invoices,setInvoices]=useState<Invoice[]>([]),[invoiceId,setInvoiceId]=useState('');
  const [error,setError]=useState(''),[busy,setBusy]=useState('');
  const keys=useRef<Record<string,string>>({});
  const refresh=useCallback(async()=>{
    const [status,list]=await Promise.all([api<SquareSandboxView>('/api/square-sandbox'),api<{invoices:Invoice[]}>('/api/invoices')]);
    setState(status);setInvoices(list.invoices.filter(invoice=>invoice.status==='open'));
  },[]);
  useEffect(()=>{void refresh().catch(error=>setError(error.message));},[refresh]);
  async function act(label:string,action:()=>Promise<unknown>){
    setBusy(label);setError('');
    try{await action();await refresh();}catch(error){setError((error as Error).message);await refresh().catch(()=>{});}finally{setBusy('');}
  }
  async function create(id:string){
    keys.current[id]??=actionKey();
    await post('/api/square-sandbox/checkouts',{invoiceId:id},keys.current[id]);
  }
  if(!state)return error?<ErrorMessage message={error}/>:<Loading label="Checking Square sandbox setup…"/>;
  return <>
    <PageHeading eyebrow="SQUARE · TEST ENVIRONMENT" title="Test your card checkout." description="Try a provider checkout from one invoice, then verify its test payment. Your simulated balance stays separate."/>
    {error?<ErrorMessage message={error}/>:null}
    <SectionCard title="Your sandbox connection" description="A test credential stays in a private server file. No card or banking details belong here." className="square-section">
      <div className="square-connection">
        <Badge tone={state.connection?'good':'warm'}>{state.connection?'Sandbox location verified':state.configured?'Ready to verify':'Awaiting sandbox credentials'}</Badge>
        {state.connection?<p>{state.connection.currency} checkout location · verified {date(state.connection.verifiedAt)}</p>:<p>{state.configured?'Verify the test credential before creating a checkout.':'The complete simulation remains available while account access is being resolved.'}</p>}
        <button className="button secondary" disabled={!state.configured||Boolean(busy)} onClick={()=>void act('connection',()=>post('/api/square-sandbox/connection',{}))}><ShieldCheck size={17}/>{busy==='connection'?'Verifying…':'Verify sandbox connection'}</button>
      </div>
      <PrivacyNote>Square receives a generic test description and the invoice total/currency. Customer details, notes and your private scenario stay here.</PrivacyNote>
    </SectionCard>
    <SectionCard title="Try an invoice" description="This creates a separate test snapshot. It does not mark the original simulated invoice paid." className="square-section">
      <form className="square-create" onSubmit={event=>{event.preventDefault();if(invoiceId)void act('create',()=>create(invoiceId));}}>
        <label className="field">Invoice to test<select required value={invoiceId} onChange={event=>setInvoiceId(event.target.value)} disabled={!state.configured||Boolean(busy)}><option value="">Choose an open invoice</option>{invoices.map(invoice=><option key={invoice.id} value={invoice.id} disabled={Boolean(state.connection&&invoice.currency!==state.connection.currency)}>{invoice.number} · {money(invoice.total,invoice.currency)}</option>)}</select></label>
        <button className="button primary" disabled={!state.configured||!invoiceId||Boolean(busy)}><CreditCard size={17}/>{busy==='create'?'Preparing test checkout…':'Create Square test checkout'}</button>
      </form>
      {!invoices.length?<p className="micro">Create a fictional invoice first. <Link to="/invoices/new" className="text-link">Create invoice<ArrowUpRight size={14}/></Link></p>:null}
    </SectionCard>
    <SectionCard title="Test checkouts" description="Only Square's own completed payment readback can produce a test receipt." className="square-section">
      {!state.checkouts.length?<p className="square-empty">No Square test checkouts yet.</p>:<div className="square-checkouts">{state.checkouts.map(checkout=><article className="square-checkout" key={checkout.id}>
        <div className="square-checkout-top"><div><strong>{checkout.invoiceNumber}</strong><p>{money(checkout.amount,checkout.currency)} · Square sandbox</p></div><Badge tone={checkout.status==='paid'?'good':'warm'}>{statusName[checkout.status]}</Badge></div>
        <div className="square-actions"><Link to={`/square-test/${checkout.token}`} className="button secondary">Open test payment page<ArrowUpRight size={15}/></Link><CopyButton label="Copy test payment page" value={`${window.location.origin}/square-test/${checkout.token}`}/>{checkout.status!=='creation_pending'?<button className="button secondary" disabled={Boolean(busy)||checkout.status==='paid'} onClick={()=>void act(checkout.id,()=>post(`/api/square-sandbox/checkouts/${checkout.id}/reconcile`,{}))}><RefreshCw size={15}/>{busy===checkout.id?'Checking…':'Check test payment'}</button>:<button className="button secondary" disabled={Boolean(busy)} onClick={()=>void act(checkout.id,()=>create(checkout.invoiceId))}>Retry saved checkout</button>}</div>
        {checkout.receipt?<p className="micro">{checkout.receipt.number} · verified {date(checkout.receipt.verifiedAt)} · test receipt only</p>:null}
      </article>)}</div>}
    </SectionCard>
    <PrivacyNote>Test receipts never fund a bank or bill payout. This connection uses payment readback; inbound Square webhooks are not subscribed.</PrivacyNote>
  </>;
}

export function SquareTestPage({token}:{token:string}){
  const [checkoutData,setCheckout]=useState<SquareTestCheckout|null>(null),[loadedFor,setLoadedFor]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const checkout=loadedFor===token?checkoutData:null,generation=useRef(0);
  useEffect(()=>{
    const current=++generation.current;setLoadedFor('');setError('');setBusy(false);
    api<{checkout:SquareTestCheckout}>(`/api/square-test/${encodeURIComponent(token)}`).then(result=>{if(current===generation.current){setCheckout(result.checkout);setLoadedFor(token);}}).catch(error=>{if(current===generation.current)setError(error.message);});
    document.title='Square test checkout · Quiet Ledger';return()=>{generation.current++;};
  },[token]);
  async function check(){
    if(!checkout||busy)return;const current=generation.current;setBusy(true);setError('');
    try{const result=await post<{checkout:SquareTestCheckout}>(`/api/square-test/${encodeURIComponent(token)}/check`,{});if(current===generation.current)setCheckout(result.checkout);}
    catch(error){if(current===generation.current)setError((error as Error).message);}
    finally{if(current===generation.current)setBusy(false);}
  }
  const paid=checkout?.status==='paid'&&Boolean(checkout.receipt);
  return <div className="public-page receipt-page"><header className="public-header"><Brand compact/><Badge tone="warm">Square sandbox</Badge></header>
    {!checkout?<main className="public-error">{error?<ErrorMessage message={error}/>:<Loading label="Opening the test invoice…"/>}</main>:<main className="receipt-paper square-test-paper">
      <div className="receipt-success">{paid?<CheckCircle2 size={28}/>:<CreditCard size={28}/>}<span>{paid?'PROVIDER READBACK VERIFIED':'TEST CHECKOUT · NO REAL MONEY'}</span></div>
      <h1>{paid?'Test payment verified.':'A Square test checkout.'}</h1>
      <p className="receipt-subtitle">Separate test snapshot of invoice {checkout.invoiceNumber}.</p>
      <div className="receipt-amount">{money(checkout.amount,checkout.currency)}<span>{checkout.currency}</span></div>
      {paid?<><dl className="receipt-facts"><div><dt>Receipt number</dt><dd>{checkout.receipt!.number}</dd></div><div><dt>Verified</dt><dd>{date(checkout.receipt!.verifiedAt)}</dd></div><div><dt>Mode</dt><dd>Square sandbox · no real funds</dd></div></dl><button className="button primary" onClick={()=>downloadJson(checkout.receipt,`${checkout.receipt!.number}.json`)}><Download size={17}/>Download test receipt</button></>:<><p>Use only Square's sandbox test action. Return here afterward and check the payment. Opening or returning from Square does not confirm payment.</p><div className="square-actions">{checkout.url?<a href={checkout.url} target="_blank" rel="noreferrer" className="button primary">Open Square test checkout<ArrowUpRight size={16}/></a>:<p>Checkout creation needs recovery in the owner's workspace.</p>}<button className="button secondary" disabled={busy||!checkout.url} onClick={()=>void check()}><RefreshCw size={16}/>{busy?'Checking Square…':'Check test payment'}</button></div></>}
      {error?<ErrorMessage message={error}/>:null}
      <PrivacyNote>This is a provider test receipt, separate from the simulated ledger. It does not establish real payment, bank credit or lender acceptance.</PrivacyNote>
    </main>}
    <footer className="public-footer"><ShieldCheck size={14}/>Quiet Ledger · Square test environment</footer>
  </div>;
}
