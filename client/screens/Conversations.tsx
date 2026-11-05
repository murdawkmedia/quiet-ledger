import {useCallback,useEffect,useRef,useState,type KeyboardEvent} from 'react';
import {ArrowLeft,ArrowRight,Check,FileText,LockKeyhole,MessageCircle,RefreshCw,Send,ShieldCheck} from 'lucide-react';
import type {Dashboard,Invoice,PublicInvoice} from '../../shared/contracts';
import type {MarmotMessage,MarmotMessageKind,MarmotParticipant,MarmotRole,MarmotTransport} from '../marmot-engine';
import {api,ApiError,money} from '../api';
import {Badge,Brand,Empty,ErrorMessage,Link,Loading,PageHeading,PrivacyNote} from '../components';
import '../conversations.css';

type ConversationView={conversation:{id:string;role:MarmotRole;transportBase:string;peerPubkey?:string};invoice?:PublicInvoice};
type DemoView={invoice:Invoice;checkoutToken:string;expiresAt:string};
type Snapshot={pubkey:string;messages:MarmotMessage[];ready:boolean};
const blank:Snapshot={pubkey:'',messages:[],ready:false};
const messageLabels:Record<MarmotMessageKind,string>={update:'Private update',acknowledge:'Acknowledgement',review:'Review request','receipt-notice':'Receipt notice'};
const browserNote='Conversation keys stay in this browser; clearing site data loses access. Use a trusted device.';

function snapshot(participant:MarmotParticipant):Snapshot{return {pubkey:participant.pubkey,messages:participant.messages(),ready:participant.conversation().ready};}
function request<T>(path:string,signal:AbortSignal,body?:unknown){return api<T>(path,{signal,...(body===undefined?{}:{method:'POST',body:JSON.stringify(body)})});}
function transport(view:ConversationView,role:MarmotRole,signal:AbortSignal):MarmotTransport{
  const base=view.conversation.transportBase;
  if(view.conversation.role!==role||!base.startsWith('/api/')||base.includes('//')||base.includes('?')||base.includes('#'))throw new Error('Private transport unavailable.');
  return {async publish(event){await request(`${base}/events`,signal,{event});},async query(filters){return (await request<{events:Parameters<MarmotTransport['publish']>[0][]}>(`${base}/query`,signal,{filters})).events;}};
}

function MessageHistory({view,role}:{view:Snapshot;role:MarmotRole}){
  return <div className="conversation-history" role="log" aria-label={`${role==='merchant'?'Merchant':'Customer'} decrypted messages`} aria-live="polite" aria-relevant="additions text">
    {view.messages.length?<ol>{view.messages.map(message=><li key={message.id} className={message.sender===view.pubkey?'message-sent':'message-received'}><div className="conversation-message-meta"><span>{message.sender===view.pubkey?'You':role==='merchant'?'Customer':'Merchant'} · {messageLabels[message.kind]}</span><LockKeyhole size={12} aria-hidden="true"/></div><p>{message.text}</p><time dateTime={new Date(message.createdAt*1000).toISOString()}>{new Intl.DateTimeFormat('en-CA',{hour:'numeric',minute:'2-digit'}).format(message.createdAt*1000)}</time></li>)}</ol>:<div className="conversation-history-empty"><LockKeyhole size={25}/><p>{view.ready?'Your private channel is ready.':'Your private channel will appear here.'}</p><small>Only decrypted messages from this participant’s device appear here.</small></div>}
  </div>;
}

function ConversationRole({role,view,busy,paid,onSend,demo=false}:{role:MarmotRole;view:Snapshot;busy:boolean;paid:boolean;onSend:(kind:MarmotMessageKind)=>void;demo?:boolean}){
  const merchant=role==='merchant';
  return <section className={`conversation-role conversation-role-${role}`} aria-label={`${merchant?'Merchant':'Customer'} conversation`}>
    <header className="conversation-role-heading"><span className="conversation-avatar" aria-hidden="true">{merchant?'M':'C'}</span><div><p className="eyebrow">{demo?'FICTIONAL PARTICIPANT':merchant?'YOUR WORKSPACE':'YOUR BROWSER'}</p><h2>{merchant?'Merchant':'Customer'}</h2></div><span className={`conversation-connection ${view.ready?'is-ready':''}`}><i/>{view.ready?'Connected':'Not connected'}</span></header>
    <MessageHistory view={view} role={role}/>
    <div className="conversation-presets" role="group" aria-label={`${merchant?'Merchant':'Customer'} message actions`}>
      {merchant?<><button type="button" className="button primary" disabled={busy||!view.ready} onClick={()=>onSend('update')}><Send size={15}/>Send private update</button><button type="button" className="button secondary" disabled={busy||!view.ready||!paid} onClick={()=>onSend('receipt-notice')}><FileText size={15}/>Send receipt notice</button>{!paid?<p className="conversation-action-help">A receipt notice becomes available after payment is recorded.</p>:null}</>:<><button type="button" className="button primary" disabled={busy||!view.ready} onClick={()=>onSend('acknowledge')}><Check size={16}/>Acknowledge update</button><button type="button" className="button secondary" disabled={busy||!view.ready} onClick={()=>onSend('review')}><MessageCircle size={15}/>Request review</button></>}
      <p className="conversation-action-help">Preset notices only. Invoice details and payment information stay out of messages.</p>
    </div>
  </section>;
}

function InvoiceContext({invoice,demo=false}:{invoice:PublicInvoice;demo?:boolean}){
  return <div className="conversation-invoice"><div className="conversation-invoice-icon"><FileText size={23}/></div><div className="conversation-invoice-main"><p className="eyebrow">{demo?'FICTIONAL INVOICE':'THIS INVOICE'} · {invoice.number}</p><h2>{invoice.title}</h2><p>{invoice.customerName}</p></div><div className="conversation-invoice-total"><strong>{money(invoice.total,invoice.currency)}</strong><Badge tone={invoice.status==='paid'?'good':'warm'}>{invoice.status==='paid'?(demo||invoice.settlementMode==='simulation')?'Simulated payment recorded':'Payment recorded':'Awaiting payment'}</Badge></div></div>;
}

export function HackathonDemoPage(){
  const [view,setView]=useState<DemoView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(''),[ready,setReady]=useState(false),[merchant,setMerchant]=useState<Snapshot>(blank),[customer,setCustomer]=useState<Snapshot>(blank),[tab,setTab]=useState<MarmotRole>('merchant');
  const participants=useRef<Partial<Record<MarmotRole,MarmotParticipant>>>({}),active=useRef(true),generation=useRef(0),controller=useRef(new AbortController()),lock=useRef(false),tabButtons=useRef<Partial<Record<MarmotRole,HTMLButtonElement>>>({});
  const dispose=useCallback(async()=>{const previous=participants.current;participants.current={};await Promise.allSettled(Object.values(previous).map(participant=>participant.dispose()));},[]);
  const load=useCallback(async()=>{
    const current=generation.current;setLoading(true);setError('');
    try{const result=await request<DemoView>('/api/hackathon-demo',controller.current.signal);if(active.current&&current===generation.current)setView(result);}
    catch{if(active.current&&current===generation.current)setError('The fictional demo could not be loaded. Try again.');}
    finally{if(active.current&&current===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{active.current=true;controller.current=new AbortController();void load();return()=>{active.current=false;generation.current++;controller.current.abort();void dispose();};},[load,dispose]);
  function refreshViews(){if(!active.current)return;const pair=participants.current;if(pair.merchant)setMerchant(snapshot(pair.merchant));if(pair.customer)setCustomer(snapshot(pair.customer));}
  async function act(label:string,operation:()=>Promise<void>,failure:string){
    if(lock.current)return;lock.current=true;setBusy(label);setError('');const current=generation.current;
    try{await operation();if(active.current&&current===generation.current)refreshViews();}
    catch{if(active.current&&current===generation.current)setError(failure);}
    finally{lock.current=false;if(active.current&&current===generation.current)setBusy('');}
  }
  function prepare(){if(!view)return;void act('Preparing private channel…',async()=>{
    setReady(false);await dispose();
    const signal=controller.current.signal;
    const owner=await request<ConversationView>(`/api/invoices/${encodeURIComponent(view.invoice.id)}/conversation`,signal,{});
    const payer=await request<ConversationView>(`/api/checkout/${encodeURIComponent(view.checkoutToken)}/conversation`,signal,{});
    if(owner.conversation.id!==payer.conversation.id)throw new Error('Conversation mismatch.');
    const engine=await import('../marmot-engine');const device=await engine.getMarmotDeviceId();
    try{
      for(const [role,metadata] of [['merchant',owner],['customer',payer]] as const){
        const participant=await engine.createMarmotParticipant({namespace:`invoice:${metadata.conversation.id}:${device}:${role}`,role,network:transport(metadata,role,signal)});
        if(!active.current||signal.aborted){await participant.dispose();throw new Error('Conversation closed.');}
        participants.current[role]=participant;
      }
      const {merchant:sender,customer:recipient}=participants.current;
      if(!sender||!recipient||sender.pubkey===recipient.pubkey)throw new Error('Distinct messaging identities required.');
      await Promise.all([sender.ensureKeyPackage(),recipient.ensureKeyPackage()]);
      await sender.createConversation(recipient.pubkey);
      if(!await recipient.acceptInvitation(sender.pubkey))throw new Error('Invitation not yet available.');
      await Promise.all([sender.sync(),recipient.sync()]);
      if(active.current)setReady(true);
    }catch(error){await dispose();throw error;}
  },'The private demo channel could not be prepared. Try preparing it again in this browser.');}
  function send(role:MarmotRole,kind:MarmotMessageKind){if(kind==='receipt-notice'&&view?.invoice.status!=='paid')return;void act('Delivering private message…',async()=>{
    const sender=participants.current[role],recipient=participants.current[role==='merchant'?'customer':'merchant'];if(!sender||!recipient)throw new Error('Prepare first.');
    await sender.send(kind);await Promise.all([sender.sync(),recipient.sync()]);
  },'The private message could not be delivered. Use Refresh messages to retry delivery.');}
  function simulate(){void act('Recording simulated payment…',async()=>{const result=await request<DemoView>('/api/hackathon-demo/simulate-payment',controller.current.signal,{});if(active.current)setView(result);},'The simulated payment could not be recorded. Try again.');}
  useEffect(()=>{
    if(!ready)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{if(!stopped&&document.visibilityState==='visible'&&!lock.current){try{await Promise.all(Object.values(participants.current).map(participant=>participant.sync()));if(!stopped)refreshViews();}catch{if(!stopped)setError('The private channel could not refresh. Use Refresh messages to retry.');}}if(!stopped)timer=setTimeout(()=>void tick(),5000);};
    timer=setTimeout(()=>void tick(),5000);return()=>{stopped=true;clearTimeout(timer);};
  },[ready]);
  function changeTab(event:KeyboardEvent<HTMLButtonElement>){if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'merchant':event.key==='End'?'customer':tab==='merchant'?'customer':'merchant';setTab(next);tabButtons.current[next]?.focus();}}
  const paid=view?.invoice.status==='paid';
  return <div className="conversations-page marmot-demo"><PageHeading eyebrow="QUIET LEDGER × MARMOT" title="A private conversation. A clear paper trail." description="Walk through a fictional invoice with two independent messaging identities. The conversation uses real Marmot encryption; the payment is simulated."/>
    <p className="demo-invoice-actions"><Link to="/demo/new" className="button secondary">Create a demo invoice<FileText size={16}/></Link> <Link to="/demo/team" className="button primary">Meet Riley and Jordan<MessageCircle size={16}/></Link></p>
    <div className="conversation-demo-banner"><span><ShieldCheck size={19}/>Fictional demo · no real money moves</span><Badge tone="ink">Real Marmot / MLS messaging</Badge></div>
    {error?<ErrorMessage message={error} onRetry={!view?()=>void load():undefined}/>:null}
    {loading&&!view?<Loading label="Opening the fictional demo…"/>:null}
    {view?<><InvoiceContext invoice={view.invoice} demo/><div className="conversation-demo-layout"><aside className="conversation-guide"><p className="eyebrow">TRY THE WHOLE STORY</p><h2>From update<br/>to accounted for.</h2><ol className="conversation-steps"><li className={ready?'is-complete':''}><span>{ready?<Check size={14}/>:1}</span><div><strong>Prepare two identities</strong><p>Separate merchant and customer identities, together in this browser.</p></div></li><li className={customer.messages.some(message=>message.kind==='update')?'is-complete':''}><span>2</span><div><strong>Send a private update</strong><p>Watch the customer decrypt it, then reply.</p></div></li><li className={paid?'is-complete':''}><span>3</span><div><strong>Simulate payment</strong><p>The fictional invoice gets a clearly labelled simulation receipt.</p></div></li><li className={customer.messages.some(message=>message.kind==='receipt-notice')?'is-complete':''}><span>4</span><div><strong>Send the receipt notice</strong><p>A generic encrypted message tells the customer to return to the ledger.</p></div></li></ol>
      <button type="button" className="button primary full" disabled={Boolean(busy)||ready||loading} onClick={prepare}>{busy&&!ready?<RefreshCw size={16} className="spin"/>:<LockKeyhole size={16}/>} {ready?'Demo prepared':busy&&!ready?busy:'Prepare demo'}</button>
      <button type="button" className="button secondary full" disabled={Boolean(busy)||!ready||paid} onClick={simulate}>{busy==='Recording simulated payment…'?busy:paid?'Payment simulated':'Simulate payment'}<ArrowRight size={15}/></button>
      <p className="conversation-demo-link"><Link to={`/pay/${encodeURIComponent(view.checkoutToken)}`} className="text-link">View fictional invoice<ArrowRight size={14}/></Link></p>
    </aside><div className="conversation-demo-messages"><div className="conversation-protocol" role="status"><span className={ready?'protocol-ready':''}><i/>{ready?'Both participants connected':busy||'Ready when you are'}</span><small>{ready?'Signed encrypted events · private app transport':'Device keys are created when you prepare the demo.'}</small></div>
      <div className="conversation-tabs" role="tablist" aria-label="Demo participant"><button type="button" role="tab" id="merchant-tab" aria-controls="merchant-panel" aria-selected={tab==='merchant'} tabIndex={tab==='merchant'?0:-1} ref={element=>{tabButtons.current.merchant=element??undefined;}} onKeyDown={changeTab} onClick={()=>setTab('merchant')}>Merchant</button><button type="button" role="tab" id="customer-tab" aria-controls="customer-panel" aria-selected={tab==='customer'} tabIndex={tab==='customer'?0:-1} ref={element=>{tabButtons.current.customer=element??undefined;}} onKeyDown={changeTab} onClick={()=>setTab('customer')}>Customer</button></div>
      <div className="conversation-role-grid"><div id="merchant-panel" role="tabpanel" aria-labelledby="merchant-tab" className={tab==='merchant'?'is-active':''}><ConversationRole role="merchant" view={merchant} busy={Boolean(busy)} paid={Boolean(paid)} onSend={kind=>send('merchant',kind)} demo/></div><div id="customer-panel" role="tabpanel" aria-labelledby="customer-tab" className={tab==='customer'?'is-active':''}><ConversationRole role="customer" view={customer} busy={Boolean(busy)} paid={Boolean(paid)} onSend={kind=>send('customer',kind)} demo/></div></div>
      {ready?<button type="button" className="text-button conversation-refresh" disabled={Boolean(busy)} onClick={()=>void act('Refreshing messages…',async()=>{await Promise.all(Object.values(participants.current).map(participant=>participant.sync()));},'The private channel could not refresh. Try again.')}><RefreshCw size={14}/>Refresh messages</button>:null}
    </div></div><div className="conversation-boundaries"><PrivacyNote>{browserNote} The two demo roles use separate browser key stores. No wallet keys or Nostr account are needed.</PrivacyNote><p>Only these conversation messages are end-to-end encrypted. Invoice and payment records remain readable by the Quiet Ledger operator. Private app delivery keeps encrypted events off public relays.</p></div></>:null}
  </div>;
}

function ConversationPane({endpoint,role,initialInvoice}:{endpoint:string;role:MarmotRole;initialInvoice?:PublicInvoice}){
  const [metadata,setMetadata]=useState<ConversationView|null>(null),[invoice,setInvoice]=useState<PublicInvoice|undefined>(initialInvoice),[view,setView]=useState<Snapshot>(blank),[busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState(''),[started,setStarted]=useState(false),[loading,setLoading]=useState(true);
  const participant=useRef<MarmotParticipant|null>(null),active=useRef(true),generation=useRef(0),controller=useRef(new AbortController()),lock=useRef(false);
  const load=useCallback(async()=>{
    const current=generation.current;
    try{
      let result:ConversationView;
      try{result=await request<ConversationView>(endpoint,controller.current.signal);}
      catch(error){
        if(!(error instanceof ApiError&&error.status===404))throw error;
        if(role==='customer'){
          const checkout=await request<{invoice:PublicInvoice}>(endpoint.slice(0,-'/conversation'.length),controller.current.signal);
          if(active.current&&current===generation.current){setInvoice(checkout.invoice);setError('');}
        }
        return;
      }
      if(active.current&&current===generation.current){setMetadata(result);if(result.invoice)setInvoice(result.invoice);setError('');}
    }
    catch{if(active.current&&current===generation.current)setError('This private conversation could not be opened. Try again.');}
    finally{if(active.current&&current===generation.current)setLoading(false);}
  },[endpoint,role]);
  useEffect(()=>{active.current=true;controller.current=new AbortController();void load();return()=>{active.current=false;generation.current++;controller.current.abort();const previous=participant.current;participant.current=null;void previous?.dispose();};},[load]);
  function refresh(){if(active.current&&participant.current)setView(snapshot(participant.current));}
  async function act(label:string,operation:()=>Promise<void>,failure:string){if(lock.current)return;lock.current=true;setBusy(label);setError('');setNotice('');const current=generation.current;try{await operation();if(active.current&&current===generation.current)refresh();}catch{if(active.current&&current===generation.current)setError(failure);}finally{lock.current=false;if(active.current&&current===generation.current)setBusy('');}}
  function start(){void act('Preparing private conversation…',async()=>{
    const signal=controller.current.signal;const result=await request<ConversationView>(endpoint,signal,{});
    if(active.current){setMetadata(result);if(result.invoice)setInvoice(result.invoice);}
    const engine=await import('../marmot-engine');const device=await engine.getMarmotDeviceId();
    const current=await engine.createMarmotParticipant({namespace:`invoice:${result.conversation.id}:${device}:${role}`,role,network:transport(result,role,signal)});
    if(!active.current||signal.aborted){await current.dispose();return;}
    participant.current=current;
    try{await current.ensureKeyPackage();await current.sync();await load();if(active.current)setStarted(true);}
    catch(error){participant.current=null;await current.dispose();throw error;}
  },'The private conversation could not start. Try again in this browser.');}
  async function fetchLatest(){const result=await request<ConversationView>(endpoint,controller.current.signal);if(active.current){setMetadata(result);if(result.invoice)setInvoice(result.invoice);}return result;}
  function connect(){void act(role==='merchant'?'Connecting customer…':'Checking invitation…',async()=>{
    const latest=await fetchLatest(),current=participant.current,peer=latest.conversation.peerPubkey;if(!current||!peer)throw new Error('The other participant is not ready.');
    if(role==='merchant')await current.createConversation(peer);else if(!await current.acceptInvitation(peer)){if(active.current)setNotice('Waiting for the merchant’s invitation.');return;}
    await current.sync();
  },'The private channel could not connect. Ask the other participant to open this invoice’s conversation, then try again.');}
  function send(kind:MarmotMessageKind){if(kind==='receipt-notice'&&invoice?.status!=='paid')return;void act('Delivering private message…',async()=>{
    if(kind==='receipt-notice'){const latest=await fetchLatest();if(latest.invoice?.status!=='paid')throw new Error('Payment is not recorded.');}
    if(!participant.current)throw new Error('Start the conversation first.');await participant.current.send(kind);await participant.current.sync();
  },'The private message could not be delivered. Check the invoice status and use Refresh messages to retry delivery.');}
  function sync(){void act('Refreshing messages…',async()=>{await fetchLatest();await participant.current?.sync();},'The private channel could not refresh. Try again.');}
  useEffect(()=>{
    if(!started)return;let stopped=false;let timer:ReturnType<typeof setTimeout>;
    const tick=async()=>{if(!stopped&&document.visibilityState==='visible'&&!lock.current){try{await fetchLatest();await participant.current?.sync();if(!stopped)refresh();}catch{if(!stopped)setError('The private channel could not refresh. Use Refresh messages to retry.');}}if(!stopped)timer=setTimeout(()=>void tick(),5000);};
    timer=setTimeout(()=>void tick(),5000);return()=>{stopped=true;clearTimeout(timer);};
  },[started]);
  return <div className="conversation-pane">{invoice?<InvoiceContext invoice={invoice}/>:null}{error?<ErrorMessage message={error} onRetry={!started?()=>void load():undefined}/>:null}{loading?<Loading label="Opening private conversation…"/>:null}
    <div className="conversation-setup"><div><span className="conversation-setup-icon"><LockKeyhole size={21}/></span><h2>{view.ready?'Your private channel is ready.':started?'Waiting for the other participant.':'A private channel, just for this invoice.'}</h2><p>{view.ready?'Send a preset notice below. No invoice details are included in the message.':started?role==='merchant'?'Ask the customer to open the conversation from their invoice link. Connect only when you expect this customer.':'Keep this page open while the merchant connects. Accept only when you expect this invoice’s merchant.':'This optional conversation creates a separate messaging identity in your browser. You do not need a Nostr account, extension or wallet key.'}</p></div>
      {!started?<button type="button" className="button primary" disabled={Boolean(busy)||loading} onClick={start}>{busy||'Start private conversation'}<ArrowRight size={16}/></button>:!view.ready?<button type="button" className="button primary" disabled={Boolean(busy)||!metadata?.conversation.peerPubkey} onClick={connect}>{busy|| (role==='merchant'?'Connect customer':'Accept private invitation')}<ArrowRight size={16}/></button>:<Badge tone="good">Marmot channel connected</Badge>}
      {started&&!metadata?.conversation.peerPubkey?<p className="conversation-action-help" role="status">{role==='merchant'?'Waiting for the customer to open this conversation.':'Waiting for the merchant to open this conversation.'}</p>:null}
    </div>{notice?<p className="conversation-notice" role="status">{notice}</p>:null}{busy?<p className="conversation-notice" role="status">{busy}</p>:null}
    <ConversationRole role={role} view={view} busy={Boolean(busy)} paid={invoice?.status==='paid'} onSend={send}/>{started?<button type="button" className="text-button conversation-refresh" disabled={Boolean(busy)} onClick={sync}><RefreshCw size={14}/>Refresh messages</button>:null}
    <div className="conversation-boundaries"><PrivacyNote>{browserNote} No wallet or login keys are imported.</PrivacyNote><p>Conversation messages are end-to-end encrypted with Marmot. Invoice and payment records remain readable by the Quiet Ledger operator. The app delivers encrypted events privately, without public relays.</p></div>
  </div>;
}

export function ConversationsPage({data}:{data:Dashboard}){
  const [selected,setSelected]=useState(data.invoices[0]?.id??'');
  const invoice=data.invoices.find(row=>row.id===selected)??data.invoices[0];
  return <div className="conversations-page"><PageHeading eyebrow="OPTIONAL · PRIVATE MESSAGING" title="Keep the conversation close." description="A separate Marmot conversation for each invoice. Send generic updates and receipt notices; customers can reply from their private invoice link."/>
    {invoice?<><label className="field conversation-selector">Choose an invoice<select value={invoice.id} onChange={event=>setSelected(event.target.value)}>{data.invoices.map(row=><option value={row.id} key={row.id}>{row.number} · {row.customerName}</option>)}</select></label><ConversationPane key={invoice.id} endpoint={`/api/invoices/${encodeURIComponent(invoice.id)}/conversation`} role="merchant" initialInvoice={invoice}/></>:<Empty title="An invoice starts the conversation." action={<Link to="/invoices/new" className="button primary">Create an invoice<ArrowRight size={16}/></Link>}>Your customer can open the optional conversation from their private invoice link.</Empty>}
  </div>;
}

export function CustomerConversationPage({token}:{token:string}){
  return <div className="public-page customer-conversation-page"><header className="public-header"><Brand compact/><Badge tone="ink">Optional private conversation</Badge></header><main className="customer-conversation-content"><Link to={`/pay/${encodeURIComponent(token)}`} className="text-link"><ArrowLeft size={15}/>Back to invoice</Link><PageHeading eyebrow="JUST THIS INVOICE" title="A little privacy, built in." description="Reply to the merchant with a private preset message. Your usual invoice checkout works whether you use this conversation or not."/><ConversationPane key={token} endpoint={`/api/checkout/${encodeURIComponent(token)}/conversation`} role="customer"/></main><footer className="public-footer"><ShieldCheck size={14}/>A private conversation by Quiet Ledger.</footer></div>;
}
