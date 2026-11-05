import {useEffect,useRef,useState} from 'react';
import {ArrowUpRight,CheckCircle2,Download,RefreshCw,ShieldCheck,Wallet} from 'lucide-react';
import type {ReceivingRecord} from '../../shared/receiving';
import {api,date,downloadJson,methodLabel,money,post} from '../api';
import {Badge,Brand,CopyButton,ErrorMessage,Loading,PrivacyNote} from '../components';

export type AdapterView={label?:string;id:string;methods:string[];mode:'live'|'test';configured?:boolean;verified?:boolean;supportedCurrencies?:string[]};
export type ReceiveRequest=ReceivingRecord&{receiptToken?:string;nativePayment?:{asset:string;atomicAmount:string;network:string}};
export function safePaymentUrl(value?:string){try{const url=new URL(value??'');return url.protocol==='https:'?url.href:undefined;}catch{return undefined;}}
export function nativeAmount(request:ReceiveRequest){
  if(!['bitcoin','lightning','liquid','cashu','ark','usdt','usdc'].includes(request.method))return `${money(request.amount,request.currency)} ${request.currency}`;
  const value=request.expectedAtomic,asset=request.intent?.asset??(request.method==='usdt'?'USDT':request.method==='usdc'?'USDC':'BTC');
  if(!/^\d+$/.test(value))return `${value} ${asset} atomic units`;
  if(['bitcoin','lightning','liquid','cashu','ark'].includes(request.method))return `${BigInt(value).toLocaleString()} sats`;
  return `${BigInt(value).toLocaleString()} ${asset} atomic units`;
}
export function ReceivingDetails({request}:{request:ReceiveRequest}){
  const url=safePaymentUrl(request.intent?.url);
  const expired=Date.parse(request.expiresAt)<=Date.now();
  const expiry=new Intl.DateTimeFormat('en-CA',{dateStyle:'medium',timeStyle:'short'}).format(new Date(request.expiresAt));
  return <div className="receiving-details">
    <div className="native-amount"><Wallet size={22}/><strong>{nativeAmount(request)}</strong></div>
    <p className="receive-fiat">Invoice value {money(request.amount,request.currency)} {request.currency}</p>
    <dl className="receive-facts"><div><dt>Method</dt><dd>{methodLabel(request.method)}</dd></div><div><dt>Network</dt><dd>{request.intent?.network??'Provider checkout'}</dd></div>{request.intent?.asset?<div><dt>Asset</dt><dd>{request.intent.asset}</dd></div>:null}<div><dt>Expires</dt><dd>{expiry}</dd></div></dl>
    {expired?<div className="review-message" role="status"><strong>Payment request expired</strong><p>Ask the owner for a fresh request before sending. If you already paid, you can still check its status for review.</p></div>:request.intent?.request?<div className="payment-request receiving-address"><code>{request.intent.request}</code><CopyButton value={request.intent.request} label="Copy payment request"/></div>:null}
    {request.intent?.instructions?.map((instruction,index)=><div className="receive-instruction" key={index}><strong>{instruction.label}</strong><p>{instruction.value}</p></div>)}
    {url&&!expired?<a href={url} target="_blank" rel="noreferrer" className="button primary full">Open secure provider checkout<ArrowUpRight size={16}/></a>:null}
  </div>;
}

export function ReceivePage({token}:{token:string}){
  const [record,setRecord]=useState<ReceiveRequest|null>(null),[loadedFor,setLoadedFor]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const generation=useRef(0),request=loadedFor===token?record:null;
  async function load(){const current=++generation.current;setRecord(null);setLoadedFor('');setError('');setBusy(false);try{const result=await api<{request:ReceiveRequest}>(`/api/receive/${encodeURIComponent(token)}`);if(current===generation.current){setRecord(result.request);setLoadedFor(token);}}catch(e){if(current===generation.current)setError((e as Error).message);}}
  useEffect(()=>{void load();document.title='Payment request · Quiet Ledger';return()=>{generation.current++;};},[token]);
  async function check(){if(!request||busy)return;const current=generation.current;setBusy(true);setError('');try{const result=await post<{request:ReceiveRequest}>(`/api/receive/${encodeURIComponent(token)}/check`,{});if(current===generation.current)setRecord(result.request);}catch(e){if(current===generation.current)setError((e as Error).message);}finally{if(current===generation.current)setBusy(false);}}
  const paid=request?.status==='paid'&&Boolean(request.receipt),live=request?.mode==='live';
  return <div className="public-page receipt-page"><header className="public-header"><Brand compact/><Badge tone={live?'good':'warm'}>{request?live?'Live payment':'Test payment':'Payment request'}</Badge></header>
    {!request?<main className="public-error">{error?<ErrorMessage message={error} onRetry={()=>void load()}/>:<Loading label="Opening your payment request…"/>}</main>:<main className="receipt-paper receive-paper">
      <div className="receipt-success">{paid?<CheckCircle2 size={28}/>:<Wallet size={28}/>}<span>{paid?'PAYMENT VERIFIED':request.reviewReason?'OWNER REVIEW REQUIRED':'YOUR PRIVATE PAYMENT REQUEST'}</span></div>
      <h1>{paid?'Payment verified.':request.reviewReason?'Awaiting payment review.':'A place for your payment.'}</h1><p className="receipt-subtitle">Invoice {request.invoiceNumber}{paid?'':live?' · Live payment · real funds':' · Test environment · no real funds'}</p>
      {paid?<><div className="receipt-amount">{money(request.receipt!.amount,request.receipt!.currency)}<span>{request.receipt!.currency}</span></div><dl className="receipt-facts"><div><dt>Receipt number</dt><dd>{request.receipt!.number}</dd></div><div><dt>Method</dt><dd>{methodLabel(request.method)}</dd></div><div><dt>Verified</dt><dd>{date(request.receipt!.verifiedAt)}</dd></div><div><dt>Mode</dt><dd>{live?'Live payment · real funds':'Test payment · no real funds'}</dd></div></dl><button className="button primary" onClick={()=>downloadJson(request.receipt,`${request.receipt!.number}.json`)}><Download size={17}/>Download {live?'payment':'test'} receipt</button></>:<><ReceivingDetails request={request}/>{request.reviewReason?<div className="review-message" role="status"><strong>Awaiting owner review</strong><p>{request.reviewReason}</p><p>A payment report or provider approval alone is not a paid receipt.</p></div>:null}{request.status==='creation_pending'?<p className="receive-instruction">The owner is recovering this saved request. Wait for an available payment request before sending.</p>:<button className="button secondary full" disabled={busy} onClick={()=>void check()}><RefreshCw size={16}/>{busy?'Checking payment…':'Check payment'}</button>}</>}
      {error?<ErrorMessage message={error}/>:null}<PrivacyNote>{live?'Use the exact asset, network and amount shown. A receipt appears only after verification. This page never asks for wallet keys or a recovery phrase.':'This test request and receipt stay separate from real payments and the simulated payout balance.'}</PrivacyNote>
    </main>}<footer className="public-footer"><ShieldCheck size={14}/>A private payment page by Quiet Ledger.</footer></div>;
}
