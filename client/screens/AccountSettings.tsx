import {useCallback,useEffect,useRef,useState} from 'react';
import {Fingerprint,KeyRound,LoaderCircle,ShieldCheck,Plus,Eye,EyeOff} from 'lucide-react';
import {WebAuthnAbortService} from '@simplewebauthn/browser';
import {api,date,post,ApiError} from '../api';
import {Badge,CopyButton,ErrorMessage,Loading,PageHeading,PrivacyNote,SectionCard} from '../components';
import {accountAuthError,accountAuthStep,authenticateWithNostr,preparePasskey,completePasskey,PasskeyHelp,type PasskeyStage,type PreparedPasskey} from './AccountAccess';
import '../account-access.css';

interface AccountProfile {account:{id:string;workspaceId:string;displayName?:string;createdAt:string};credentials:{id:string;type:'passkey'|'nostr';createdAt:string;label?:string}[]}
const scopeOptions=[
  {id:'invoices:read',label:'Read invoices'},
  {id:'invoices:write',label:'Create invoices'},
  {id:'receiving:read',label:'Read receive requests'},
  {id:'receiving:write',label:'Create and check receive requests'},
  {id:'collateral:read',label:'Read configured collateral'},
  {id:'payments:confirm',label:'Manually confirm payments',detail:'Can mark a received payment as manually verified. Give this only to a trusted operator.'},
  {id:'records:read',label:'Export workspace records',detail:'Can read the complete invoice, payment and activity export.'},
] as const;
type KeyScope=typeof scopeOptions[number]['id'];
interface AccountApiKey {id:string;label?:string;scopes:KeyScope[];createdAt:string;expiresAt:string;revokedAt?:string}
function AccountApiKeys(){
  const [keys,setKeys]=useState<AccountApiKey[]>([]),[cursor,setCursor]=useState<string|null>(null),[loaded,setLoaded]=useState(false),[label,setLabel]=useState(''),[days,setDays]=useState('30'),[scopes,setScopes]=useState<KeyScope[]>(scopeOptions.slice(0,5).map(scope=>scope.id)),[pending,setPending]=useState<string|null>(null),[error,setError]=useState(''),[uncertain,setUncertain]=useState(false),[created,setCreated]=useState<(AccountApiKey&{token:string})|null>(null),[reveal,setReveal]=useState(false);
  const generation=useRef(0),reads=useRef(0),locked=useRef(false);
  const read=useCallback(async(next?:string)=>{const current=generation.current,request=++reads.current;try{const response=await api<{keys:AccountApiKey[];nextCursor?:string|null}>('/api/account/api-keys'+(next?'?cursor='+encodeURIComponent(next):''));if(current!==generation.current||request!==reads.current)return;if(!Array.isArray(response.keys))throw new Error('API keys could not be read.');setKeys(previous=>next?[...previous,...response.keys.filter(row=>!previous.some(old=>old.id===row.id))]:response.keys);setCursor(response.nextCursor??null);setLoaded(true);}catch(error){if(current===generation.current&&request===reads.current)setError((error as Error).message);}},[]);
  useEffect(()=>{void read();return()=>{generation.current++;};},[read]);
  async function create(event:React.FormEvent){
    event.preventDefault();if(locked.current||created||!scopes.length||!/^\d+$/.test(days)||Number(days)<1||Number(days)>90)return;
    locked.current=true;setPending('create');setError('');setUncertain(false);const current=generation.current;
    try{
      const result=await post<{key:AccountApiKey&{token:string}}>('/api/account/api-keys',{...(label.trim()?{label:label.trim()}:{}),scopes,expiresInDays:Number(days)});
      if(current!==generation.current)return;const {token,...metadata}=result.key;setCreated({...metadata,token});setReveal(false);setKeys(previous=>[metadata,...previous.filter(row=>row.id!==metadata.id)]);setLabel('');await read();
    }catch(error){if(current===generation.current){setError((error as Error).message);setUncertain(!(error instanceof ApiError)||error.status>=500);}}
    finally{locked.current=false;if(current===generation.current)setPending(null);}
  }
  async function revoke(id:string){
    if(locked.current)return;locked.current=true;setPending(id);setError('');const current=generation.current;
    try{await api('/api/account/api-keys/'+encodeURIComponent(id),{method:'DELETE'});if(current!==generation.current)return;setKeys(previous=>previous.map(key=>key.id===id?{...key,revokedAt:new Date().toISOString()}:key));if(created?.id===id){setCreated(null);setReveal(false);}await read();}
    catch(error){if(current===generation.current)setError((error as Error).message);}
    finally{locked.current=false;if(current===generation.current)setPending(null);}
  }
  function toggle(scope:KeyScope){setScopes(current=>current.includes(scope)?current.filter(value=>value!==scope):[...current,scope]);}
  return <SectionCard title="Website and agent API keys" description="Give each connection only the permissions it needs. Keys belong to this account." className="account-settings-section">
    {error?<div className="account-key-error"><ErrorMessage message={error} onRetry={()=>{setError('');void read();}}/>{uncertain?<p className="account-key-uncertain">The create result may be uncertain. Refresh the list, revoke any new key you cannot retrieve, then create a fresh key. Tokens cannot be recovered from the list.</p>:null}</div>:null}
    {created?<div className="account-new-token" role="region" aria-label="New API key"><strong>Save this token now.</strong><p>It is shown only for this response. It will not appear in the key list or after a refresh.</p><label className="field">New API token<input type={reveal?'text':'password'} readOnly autoComplete="off" spellCheck={false} value={created.token}/></label><div className="account-token-actions"><button type="button" className="button secondary" onClick={()=>setReveal(!reveal)}>{reveal?<EyeOff size={16}/>:<Eye size={16}/>} {reveal?'Hide API token':'Show API token'}</button><CopyButton value={created.token} label="Copy API token"/><button type="button" className="button primary" onClick={()=>{setCreated(null);setReveal(false);}}>Done — hide this token</button></div></div>:<form className="account-api-form" onSubmit={event=>void create(event)}><div className="account-api-fields"><label className="field">Key label (optional)<input maxLength={80} value={label} onChange={event=>setLabel(event.target.value)} disabled={Boolean(pending)} placeholder="My website or agent"/></label><label className="field">Expires in days<input inputMode="numeric" type="number" min={1} max={90} required value={days} onChange={event=>setDays(event.target.value)} disabled={Boolean(pending)}/></label></div><fieldset className="account-key-scopes"><legend>Permissions</legend>{scopeOptions.map((scope,index)=><label className={index>4?'account-key-scope elevated':'account-key-scope'} key={scope.id}><input type="checkbox" checked={scopes.includes(scope.id)} disabled={Boolean(pending)} onChange={()=>toggle(scope.id)}/><span><strong>{scope.label}</strong>{'detail'in scope?<small>{scope.detail}</small>:null}</span></label>)}</fieldset><button className="button primary" disabled={Boolean(pending)||!scopes.length}>{pending==='create'?<LoaderCircle className="spin" size={17}/>:<Plus size={17}/>}Create API key</button><p className="account-api-note">A key never permits spending, signing, wallet recovery or collateral locking. Keep it in your connection's private secret store.</p></form>}
    {!loaded&&!error?<div className="account-api-loading"><Loading label="Reading your API keys…"/></div>:null}
    <div className="account-key-list">{keys.map(key=><article key={key.id}><div><strong>{key.label||'API connection'}</strong><p>{key.scopes.map(scope=>scopeOptions.find(option=>option.id===scope)?.label??scope).join(' · ')}</p><small>Created {date(key.createdAt)} · Expires {date(key.expiresAt)}</small></div>{key.revokedAt?<Badge>Revoked</Badge>:<button type="button" className="button secondary" disabled={Boolean(pending)} onClick={()=>void revoke(key.id)}>{pending===key.id?<LoaderCircle className="spin" size={15}/>:null}Revoke key</button>}</article>)}</div>
    {loaded&&!keys.length?<p className="account-api-empty">No API keys have been created for this account.</p>:null}
    {cursor?<div className="account-key-more"><button className="text-button" disabled={Boolean(pending)} onClick={()=>void read(cursor)}>Load more keys</button></div>:null}
  </SectionCard>;
}
export function AccountSettingsPage(){
  const [profile,setProfile]=useState<AccountProfile|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState<'passkey'|'nostr'|null>(null),[saved,setSaved]=useState('');
  const [passkeyStage,setPasskeyStage]=useState<PasskeyStage>('preparing'),[preparedPasskey,setPreparedPasskey]=useState<PreparedPasskey|null>(null);
  const generation=useRef(0),locked=useRef(false),passkeyController=useRef<AbortController|null>(null);
  const refresh=useCallback(async()=>{const current=++generation.current;setError('');try{const result=await api<AccountProfile>('/api/auth/account');if(current===generation.current)setProfile(result);}catch(error){if(current===generation.current)setError((error as Error).message);}},[]);
  useEffect(()=>{void refresh();return()=>{generation.current++;passkeyController.current?.abort();WebAuthnAbortService.cancelCeremony();};},[refresh]);
  async function link(method:'passkey'|'nostr',prepareOnly=false){
    if(locked.current||!profile)return;locked.current=true;setBusy(method);setError('');setSaved('');
    const current=generation.current,isCurrent=()=>current===generation.current;
    const controller=new AbortController();if(method==='passkey')passkeyController.current=controller;
    try{
      if(method==='passkey'){
        const interaction={signal:controller.signal,onStage:setPasskeyStage};
        const challenge=preparedPasskey??await preparePasskey('link',undefined,isCurrent,interaction);
        if(prepareOnly||(!preparedPasskey&&navigator.userActivation&&!navigator.userActivation.isActive)){setPreparedPasskey(challenge);return;}
        setPreparedPasskey(null);await completePasskey(challenge,isCurrent,interaction);
      }else{setPreparedPasskey(null);await authenticateWithNostr('link',undefined,isCurrent);}
      if(!isCurrent())return;
      const next=method==='passkey'?await accountAuthStep(signal=>api<AccountProfile>('/api/auth/account',{signal}),15000,'Passkey confirmation could not be read. Check your connection and refresh this page before linking another passkey.',controller.signal):await api<AccountProfile>('/api/auth/account');if(!isCurrent())return;setProfile(next);setSaved(method==='passkey'?'Another passkey is linked to your account.':'The Nostr signer is linked to your account.');
    }catch(error){if(isCurrent()){setPreparedPasskey(null);setError(accountAuthError(error,method));}}
    finally{if(passkeyController.current===controller)passkeyController.current=null;locked.current=false;if(isCurrent())setBusy(null);}
  }
  return <><PageHeading eyebrow="YOUR ACCOUNT, YOUR ACCESS" title="A private way back in." description="Manage the credentials that open your workspace. Linking a credential never moves funds."/>
    {error?<ErrorMessage message={error} onRetry={!profile?()=>void refresh():undefined}/>:null}
    {!profile&&!error?<Loading label="Opening your account…"/>:null}
    {saved?<div className="success-message" role="status"><ShieldCheck size={18}/>{saved}</div>:null}
    {profile?<><SectionCard title={profile.account.displayName||'Your private workspace'} description={`Account created ${date(profile.account.createdAt)}.`} className="account-settings-section"><div className="account-settings-intro"><ShieldCheck size={23}/><p>Your invoices and payment records belong to this workspace. Other accounts do not receive access when you link a credential.</p><Badge tone="good">Private workspace</Badge></div></SectionCard>
      <SectionCard title="Ways to sign in" description="Add another credential while you still have access to this account." className="account-settings-section"><div className="account-credentials">{profile.credentials.map(credential=><article key={credential.id}><span className="account-credential-icon">{credential.type==='passkey'?<Fingerprint size={21}/>:<KeyRound size={21}/>}</span><div><strong>{credential.label||(credential.type==='passkey'?'Passkey':'Nostr signer')}</strong><p>{credential.type==='passkey'?'Your authenticator keeps the private key.':'Your signer keeps the private key.'}</p><small>Linked {date(credential.createdAt)}</small></div><Badge tone="good">Linked</Badge></article>)}</div><div className="account-link-actions"><button className="button primary" onClick={()=>void link('passkey')} disabled={Boolean(busy)}>{busy==='passkey'?<LoaderCircle className="spin" size={18}/>:<Fingerprint size={18}/>}{preparedPasskey?'Open password manager':'Add another passkey'}</button><button className="button secondary" onClick={()=>void link('nostr')} disabled={Boolean(busy)}>{busy==='nostr'?<LoaderCircle className="spin" size={18}/>:<KeyRound size={18}/>}Link a Nostr signer</button></div>
        {busy==='passkey'?<div className="account-recovery-copy"><p role="status">{passkeyStage==='preparing'?'Preparing your passkey request…':passkeyStage==='waiting'?'Waiting for your password manager or authenticator. Check its prompt.':'Confirming your passkey with Quiet Ledger…'}</p><button className="text-button" type="button" onClick={()=>passkeyController.current?.abort()}>Cancel passkey request</button></div>:null}
        {preparedPasskey&&!busy?<p className="account-recovery-copy" role="status">Your request is ready. Continue to your password manager using the button above.</p>:null}
        {!busy&&!preparedPasskey?<div className="account-recovery-copy"><button className="text-button" type="button" onClick={()=>void link('passkey',true)}>Use a password manager</button></div>:null}
        <div className="account-recovery-copy"><PasskeyHelp/></div></SectionCard>
      <AccountApiKeys/>
      <SectionCard title="Keep a way back in" description="Account recovery depends on the credentials you keep." className="account-settings-section"><div className="account-recovery-copy"><p>Keep a backup of your signer or passkey through its own recovery tools. A second linked credential can give you another way to sign in. There is no email, password or SMS recovery.</p><p>Using an existing Nostr key can link this account to that public identity. Quiet Ledger does not fetch your profile or publish your account and financial records to relays.</p><p>Your records are encrypted on the server. The hosting operator can decrypt them; this is not zero-knowledge storage.</p></div></SectionCard></>:null}
    <PrivacyNote>Never enter a private key, wallet seed or recovery phrase here. Signing happens in your authenticator or Nostr signer.</PrivacyNote>
  </>;
}
