import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,CheckCircle2,KeyRound,Link2,Plus,RefreshCw,ShieldCheck,Unplug,Wallet,X} from 'lucide-react';
import type {ConnectionInput,ConnectionProviderDefinition,ConnectionProviderField,ConnectionSummary,ConnectionsView} from '../../shared/connections';
import {actionKey,api,date,methodLabel,post} from '../api';
import {Badge,ErrorMessage,Link,Loading,PageHeading,PrivacyNote,SectionCard} from '../components';
import '../connections.css';

const endpoint='/api/account/connections';
const hasCredentials=(provider?:ConnectionProviderDefinition)=>Boolean(provider?.fields.some(field=>field.type==='password'));
const instructionsOnly=(provider:ConnectionProviderDefinition)=>provider.verification==='manual'&&!hasCredentials(provider);
const statusLabel=(connection:ConnectionSummary,provider?:ConnectionProviderDefinition)=>connection.status==='connected'?'Verified connection':connection.status==='manual'?hasCredentials(provider)?'Credentials saved · account review needed':'Saved instructions · manual confirmation':'Connection unavailable';

function ProviderField({field,value,onChange,disabled}:{field:ConnectionProviderField;value:string;onChange:(value:string)=>void;disabled:boolean}){
  const id=`connection-field-${field.key}`,helpId=field.help?`${id}-help`:undefined;
  const common={id,name:field.key,value,required:field.required,disabled,autoComplete:'off',spellCheck:false,'aria-describedby':helpId,onChange:(event:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>)=>onChange(event.target.value)};
  return <div className="field"><label htmlFor={id}>{field.label}{field.required?null:<span className="connection-optional"> (optional)</span>}</label>{field.type==='select'?<select {...common}><option value="">Choose an option</option>{field.options?.map(option=><option key={option.value} value={option.value}>{option.label}</option>)}</select>:field.type==='textarea'?<textarea {...common} placeholder={field.placeholder} rows={4} maxLength={16000}/>:<input {...common} type={field.type} placeholder={field.placeholder} maxLength={16000}/>} {field.help?<small id={helpId}>{field.help}</small>:null}</div>;
}

function ConnectionForm({provider,onSaved,onCancel}:{provider:ConnectionProviderDefinition;onSaved:(connection:ConnectionSummary)=>void;onCancel:()=>void}){
  const [label,setLabel]=useState(''),[mode,setMode]=useState<'live'|'test'>(provider.modes.includes('live')?'live':'test'),[fields,setFields]=useState<Record<string,string>>({}),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=useRef(actionKey()),active=useRef(true),heading=useRef<HTMLHeadingElement>(null),lock=useRef(false);
  useEffect(()=>{active.current=true;heading.current?.focus();return()=>{active.current=false;};},[]);
  function changed(){key.current=actionKey();setError('');}
  async function save(event:FormEvent){
    event.preventDefault();if(lock.current)return;lock.current=true;setBusy(true);setError('');
    const input:ConnectionInput={provider:provider.id,label:label.trim()||undefined,mode,fields};
    try{
      const result=await post<{connection:ConnectionSummary}>(endpoint,input,key.current);
      if(!active.current)return;
      // The form unmounts after save; clear every entered value before handing back the summary.
      setFields({});setLabel('');onSaved(result.connection);
    }catch{if(active.current)setError('The connection could not be saved. Check the details and provider access, then try again.');}
    finally{lock.current=false;if(active.current)setBusy(false);}
  }
  const manual=instructionsOnly(provider),accountReview=provider.verification==='manual'&&!manual;
  return <section className="connection-form-panel" aria-labelledby="connection-form-title"><div className="connection-form-heading"><div><p className="eyebrow">{manual?'RECEIVING INSTRUCTIONS':'YOUR EXISTING ACCOUNT'}</p><h2 id="connection-form-title" tabIndex={-1} ref={heading}>{provider.name}</h2><p>{provider.description}</p></div><button type="button" className="icon-button" disabled={busy} onClick={onCancel} aria-label="Close connection form"><X size={19}/></button></div>
    <form onSubmit={event=>void save(event)} autoComplete="off" aria-busy={busy}>
      <div className="connection-form-fields"><label className="field">Connection label (optional)<input value={label} onChange={event=>{setLabel(event.target.value);changed();}} autoComplete="off" spellCheck={false} maxLength={80} placeholder="For example, My business" disabled={busy}/></label>
      {provider.modes.length>1?<label className="field">Environment<select aria-label="Environment" value={mode} onChange={event=>{setMode(event.target.value as 'live'|'test');changed();}} disabled={busy}>{provider.modes.map(value=><option value={value} key={value}>{value==='live'?'Live · real funds / mainnet':'Test · separate test records'}</option>)}</select></label>:<p className="connection-environment"><Badge tone={mode==='live'?'ink':'warm'}>{mode==='live'?'Live · real funds / mainnet':'Test environment'}</Badge></p>}
      {provider.fields.map(field=><ProviderField key={field.key} field={field} value={fields[field.key]??''} onChange={value=>{setFields(previous=>({...previous,[field.key]:value}));changed();}} disabled={busy}/>)}</div>
      <p className="connection-form-note">{manual?'These details are saved as receiving instructions. You must independently verify each payment before confirming it.':accountReview?'Provider access is checked, while merchant details and each payment still require independent review. Saving credentials does not independently prove the merchant account binding.':mode==='test'?'We check the provider connection and save it in your account. Test receipts stay separate from live payments.':'We check the provider connection and save it in your account. Account authorization, supported currencies and payment methods still depend on the provider.'}</p>
      {error?<ErrorMessage message={error}/>:null}<div className="connection-form-actions"><button type="submit" className="button primary" disabled={busy}>{busy?<RefreshCw size={16} className="spin"/>:<ShieldCheck size={17}/>} {busy?'Checking & saving…':manual?'Save receiving instructions':'Verify & save connection'}</button><button type="button" className="button secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
    </form>
  </section>;
}

function SavedConnection({connection,provider,onUpdated,onDisconnected}:{connection:ConnectionSummary;provider?:ConnectionProviderDefinition;onUpdated:(connection:ConnectionSummary)=>void;onDisconnected:(id:string)=>void}){
  const [busy,setBusy]=useState<'check'|'disconnect'|null>(null),[confirm,setConfirm]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const active=useRef(true),lock=useRef(false),disconnect=useRef<HTMLButtonElement>(null);
  useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
  async function act(action:'check'|'disconnect'){
    if(lock.current)return;lock.current=true;setBusy(action);setError('');setMessage('');
    const path=`${endpoint}/${encodeURIComponent(connection.id)}`;
    try{
      if(action==='check'){
        const result=await post<{connection:ConnectionSummary}>(`${path}/check`,{});
        if(active.current){onUpdated(result.connection);setMessage(result.connection.status==='connected'?'Connection checked. Payment settlement still needs verification.':result.connection.status==='manual'?hasCredentials(provider)?'Provider access checked. Account details and payments still require independent review.':'Receiving instructions are saved. Confirm each payment independently.':'The connection is unavailable. Check access with your provider before trying again.');}
      }else{
        await api<{disconnected:true}>(path,{method:'DELETE'});if(active.current)onDisconnected(connection.id);
      }
    }catch{if(active.current)setError(action==='check'?'The connection could not be checked. Try again when provider access is available.':'The connection could not be disconnected. Try again.');}
    finally{lock.current=false;if(active.current)setBusy(null);}
  }
  function cancel(){setConfirm(false);setError('');disconnect.current?.focus();}
  return <article className="saved-connection" aria-label={`${connection.label} connection`}><div className="saved-connection-top"><span className="connection-symbol"><Link2 size={21}/></span><div className="saved-connection-name"><h3>{connection.label}</h3><p>{provider?.name??'Saved provider'} · {connection.mode==='live'?'Live':'Test'}</p></div><Badge tone={connection.status==='connected'?'good':connection.status==='manual'?'neutral':'warm'}>{statusLabel(connection,provider)}</Badge></div><p className="connection-detail">{connection.detail}</p>
    <div className="connection-methods" aria-label="Payment methods">{connection.methods.map(method=><span key={method}>{methodLabel(method)}</span>)}</div><p className="connection-dates">Saved {date(connection.createdAt)}{connection.verifiedAt?` · Last checked ${date(connection.verifiedAt)}`:''}</p>
    {message?<p className="connection-result" role="status">{message}</p>:null}{error?<ErrorMessage message={error}/>:null}
    <div className="saved-connection-actions"><button type="button" className="button secondary small" disabled={Boolean(busy)} onClick={()=>void act('check')}><RefreshCw size={15} className={busy==='check'?'spin':undefined}/>{busy==='check'?'Checking…':'Recheck connection'}</button><button type="button" ref={disconnect} className="text-button connection-disconnect" disabled={Boolean(busy)} aria-expanded={confirm} aria-controls={`disconnect-${connection.id}`} onClick={()=>{setConfirm(true);setError('');}}><Unplug size={15}/>Disconnect</button></div>
    {confirm?<div className="connection-disconnect-confirm" id={`disconnect-${connection.id}`} role="group" aria-labelledby={`disconnect-title-${connection.id}`}><h4 id={`disconnect-title-${connection.id}`}>Disconnect {connection.label}?</h4><p>Saved credentials and instructions will be deleted. Existing requests at the provider are not cancelled. Automated payment checks through this connection will stop; independently review outstanding payments.</p><div className="connection-form-actions"><button type="button" className="button secondary connection-danger" disabled={Boolean(busy)} onClick={()=>void act('disconnect')}>{busy==='disconnect'?'Disconnecting…':'Confirm disconnect'}</button><button type="button" className="button secondary" disabled={Boolean(busy)} onClick={cancel}>Keep connection</button></div></div>:null}
  </article>;
}

export function ConnectionsPage(){
  const [view,setView]=useState<ConnectionsView|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[selected,setSelected]=useState<ConnectionProviderDefinition|null>(null),[message,setMessage]=useState('');
  const generation=useRef(0),savedHeading=useRef<HTMLHeadingElement>(null),providerButtons=useRef<Map<string,HTMLButtonElement>>(new Map()),returnFocus=useRef<string|null>(null);
  const load=useCallback(async()=>{
    const current=++generation.current;setLoading(true);setError('');
    try{const result=await api<ConnectionsView>(endpoint);if(current===generation.current)setView(result);}
    catch{if(current===generation.current)setError('Your saved connections could not be loaded. Try again.');}
    finally{if(current===generation.current)setLoading(false);}
  },[]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  useEffect(()=>{if(!selected&&returnFocus.current){providerButtons.current.get(returnFocus.current)?.focus();returnFocus.current=null;}},[selected]);
  function invalidateList(){generation.current++;setLoading(false);setError('');}
  function saved(connection:ConnectionSummary){invalidateList();setView(previous=>previous?{...previous,connections:[connection,...previous.connections.filter(row=>row.id!==connection.id)]}:previous);setSelected(null);setMessage('Connection saved to your account. It will be here when you sign in again.');savedHeading.current?.focus();}
  function updated(connection:ConnectionSummary){invalidateList();setView(previous=>previous?{...previous,connections:previous.connections.map(row=>row.id===connection.id?connection:row)}:previous);}
  function disconnected(id:string){invalidateList();setView(previous=>previous?{...previous,connections:previous.connections.filter(row=>row.id!==id)}:previous);setMessage('Connection disconnected. Saved credentials have been deleted.');savedHeading.current?.focus();}
  function closeForm(){returnFocus.current=selected?.id??null;setSelected(null);}
  const count=view?.connections.length??0;
  return <div className="connections-page"><PageHeading eyebrow="YOUR ACCOUNTS, CONNECTED" title="Connect once. Come back ready." description="Save your Bitcoin wallets, payment providers and bank instructions to your private account. Your connections stay available across visits." action={<Link to="/payment-methods" className="button secondary">Payment methods<ArrowRight size={16}/></Link>}/>
    <div className="connections-intro"><span className="connections-intro-icon"><Wallet size={26}/></span><div><h2>Bring the accounts you already use.</h2><p>You need an existing provider account and its API credentials, or a Lightning address / LNURL. Bank details are saved receiving instructions; each bank payment needs your independent confirmation.</p><p>Never enter a wallet seed phrase or private wallet key.</p></div><Badge tone="ink">Saved to your account</Badge></div>
    {message?<div className="success-message" role="status"><CheckCircle2 size={18}/><span>{message}</span></div>:null}
    {error?<ErrorMessage message={error} onRetry={()=>void load()}/>:null}{loading&&!view?<Loading label="Loading saved connections…"/>:null}
    {view?<><section className="panel saved-connections-panel" aria-labelledby="saved-connections-title"><div className="panel-heading"><div><h2 id="saved-connections-title" tabIndex={-1} ref={savedHeading}>Your saved connections</h2><p>{count?`${count} saved connection${count===1?'':'s'}. A connection check verifies provider details, not a payment.`:'Connect a provider below to start receiving.'}</p></div><button type="button" className="button secondary small" disabled={loading} onClick={()=>void load()}><RefreshCw size={15} className={loading?'spin':undefined}/>{loading?'Refreshing…':'Refresh list'}</button></div>{count?<div className="saved-connections-list">{view.connections.map(connection=><SavedConnection key={connection.id} connection={connection} provider={view.providers.find(provider=>provider.id===connection.provider)} onUpdated={updated} onDisconnected={disconnected}/>)}</div>:<div className="connections-empty"><span><Link2 size={23}/></span><div><h3>No saved connections yet.</h3><p>Choose a Bitcoin or fiat provider below. Save it once and return to the same connection after signing in.</p></div></div>}</section>
    {selected?<ConnectionForm key={selected.id} provider={selected} onSaved={saved} onCancel={closeForm}/>:null}
    <SectionCard title="Add a connection" description="Choose a supported connection for your existing account. Provider authorization and eligibility still apply." className="connection-providers-panel"><div className="connection-provider-grid">{view.providers.map(provider=><article className={`connection-provider ${selected?.id===provider.id?'connection-provider-selected':''}`} key={provider.id}><div className="connection-provider-heading"><span className="connection-symbol">{provider.verification==='manual'?<Wallet size={20}/>:<Link2 size={20}/>}</span><Badge tone="neutral">{provider.verification==='manual'?hasCredentials(provider)?'Account review needed':'Manual confirmation':'Connection check'}</Badge></div><h3>{provider.name}</h3><p>{provider.description}</p><div className="connection-methods">{provider.methods.map(method=><span key={method}>{methodLabel(method)}</span>)}</div><button type="button" ref={element=>{if(element)providerButtons.current.set(provider.id,element);else providerButtons.current.delete(provider.id);}} className="button secondary" aria-label={`Connect ${provider.name}`} disabled={Boolean(selected)} onClick={()=>{setSelected(provider);setMessage('');}}><Plus size={16}/>{instructionsOnly(provider)?'Save instructions':'Connect provider'}</button></article>)}</div>{!view.providers.length?<p className="connection-provider-empty">No connection types are currently available. Try refreshing the list.</p>:null}</SectionCard></>:null}
    <div className="connections-footnote"><PrivacyNote>A saved connection does not confirm a payment. Credentials are encrypted on the server; the hosting operator can decrypt them. Entered credentials are cleared after saving and are never returned in connection summaries.</PrivacyNote><Link to="/account" className="text-link"><KeyRound size={16}/>Manage API keys<ArrowRight size={15}/></Link></div>
  </div>;
}
