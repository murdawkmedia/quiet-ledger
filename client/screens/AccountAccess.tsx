import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowUpRight,Fingerprint,KeyRound,LoaderCircle,ShieldCheck} from 'lucide-react';
import {startAuthentication,startRegistration,WebAuthnAbortService} from '@simplewebauthn/browser';
import {api,post,setCsrf,ApiError} from '../api';
import type {Session} from '../types';
import {Brand,ErrorMessage,PrivacyNote,navigate} from '../components';
import '../account-access.css';

export type AccountAuthAction='register'|'login'|'link';
type SigningEvent={kind:number;created_at:number;content:string;tags:string[][]};
type SignedEvent=SigningEvent&{id:string;pubkey:string;sig:string};
export interface BrowserNostrSigner {getPublicKey():Promise<string>;signEvent(event:SigningEvent):Promise<SignedEvent>}
declare global {interface Window {nostr?:BrowserNostrSigner}}
interface AuthConfiguration {mode:'hosted';methods:('passkey'|'nostr')[];registrationOpen:boolean;publicOrigin:string}
interface NostrChallenge {challengeId:string;nonce:string;action:AccountAuthAction;expiresAt:string;verifyUrl:string;payload:{challengeId:string;nonce:string;action:AccountAuthAction;pubkey:string;displayName?:string}}
type RegistrationOptions=Parameters<typeof startRegistration>[0]['optionsJSON'];
type AuthenticationOptions=Parameters<typeof startAuthentication>[0]['optionsJSON'];
type IsCurrent=()=>boolean;
class InterruptedFlow extends Error {constructor(){super('Account request is no longer active.');}}
class AccountInteractionError extends Error {}
function active(current:IsCurrent){if(!current())throw new InterruptedFlow();}
const always=()=>true;

function base64Utf8(value:string){return btoa(Array.from(new TextEncoder().encode(value),byte=>String.fromCharCode(byte)).join(''));}
async function sha256(value:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),byte=>byte.toString(16).padStart(2,'0')).join('');}

/** The signer retains its key. Only a signed, same-origin login proof is sent. */
export async function authenticateWithNostr(action:AccountAuthAction,displayName?:string,current:IsCurrent=always):Promise<unknown>{
  const signer=window.nostr;
  if(!signer)throw new AccountInteractionError('Open this page in a browser with a Nostr signer, then try again. Your private key stays in the signer.');
  const pubkey=(await signer.getPublicKey()).toLowerCase();active(current);
  if(!/^[0-9a-f]{64}$/.test(pubkey))throw new AccountInteractionError('The signer did not return a valid public key. Choose a key in your signer and try again.');
  const challenge=await post<NostrChallenge>('/api/auth/nostr/challenge',{action,pubkey,...(displayName?.trim()?{displayName:displayName.trim()}:{})});active(current);
  let destination:URL;try{destination=new URL(challenge.verifyUrl);}catch{throw new AccountInteractionError('The sign-in address could not be verified. Refresh this page before trying again.');}
  if(destination.origin!==window.location.origin||destination.pathname!=='/api/auth/nostr/verify'||destination.search||destination.hash||challenge.action!==action||challenge.payload?.pubkey!==pubkey||challenge.payload?.action!==action)throw new AccountInteractionError('The sign-in address could not be verified. Refresh this page before trying again.');
  const body=JSON.stringify(challenge.payload),payloadHash=await sha256(body);active(current);
  const proof=await signer.signEvent({kind:27235,created_at:Math.floor(Date.now()/1000),content:'',tags:[['u',destination.href],['method','POST'],['payload',payloadHash]]});active(current);
  return api('/api/auth/nostr/verify',{method:'POST',body,headers:{Authorization:'Nostr '+base64Utf8(JSON.stringify(proof))}});
}

export type PasskeyStage='preparing'|'waiting'|'verifying';
export interface PreparedPasskey {challengeId:string;options:RegistrationOptions|AuthenticationOptions;action:AccountAuthAction;preparedAt:number}
interface PasskeyInteraction {signal?:AbortSignal;onStage?:(stage:PasskeyStage)=>void}

/** Bound our own wait: an extension may ignore both the browser timeout and AbortSignal. */
export async function accountAuthStep<T>(work:(signal:AbortSignal)=>Promise<T>,milliseconds:number,message:string,signal?:AbortSignal,cancel?:()=>void):Promise<T>{
  if(signal?.aborted)throw new AccountInteractionError('The passkey request was cancelled. You can try again.');
  const controller=new AbortController();
  const abort=(reason:unknown)=>{if(!controller.signal.aborted){controller.abort(reason);cancel?.();}};
  const stopped=new Promise<never>((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
  const cancelled=()=>abort(new AccountInteractionError('The passkey request was cancelled. You can try again.'));
  signal?.addEventListener('abort',cancelled,{once:true});
  const timer=setTimeout(()=>abort(new AccountInteractionError(message)),milliseconds);
  try{return await Promise.race([work(controller.signal),stopped]);}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',cancelled);}
}
export async function preparePasskey(action:AccountAuthAction,displayName?:string,current:IsCurrent=always,interaction:PasskeyInteraction={}):Promise<PreparedPasskey>{
  if(!window.PublicKeyCredential||!navigator.credentials)throw new AccountInteractionError('Passkeys are unavailable in this browser. Enable your passkey manager or use a supported browser.');
  interaction.onStage?.('preparing');
  const preparedAt=Date.now();
  const challenge=await accountAuthStep(signal=>api<{challengeId:string;options:RegistrationOptions|AuthenticationOptions}>('/api/auth/passkey/options',{method:'POST',body:JSON.stringify({action,...(displayName?.trim()?{displayName:displayName.trim()}:{})}),signal}),15000,'Preparing the passkey request took too long. Check your connection and try again.',interaction.signal);active(current);
  return {...challenge,action,preparedAt};
}
export async function completePasskey(challenge:PreparedPasskey,current:IsCurrent=always,interaction:PasskeyInteraction={}):Promise<unknown>{
  active(current);const remaining=105000-(Date.now()-challenge.preparedAt);
  if(remaining<=0)throw new AccountInteractionError('This passkey request expired. Start again for a fresh request.');
  interaction.onStage?.('waiting');
  // Do not await another request or probe platform-authenticator support here.
  // This lets an explicit continuation invoke the manager within its click gesture.
  const response=await accountAuthStep<Awaited<ReturnType<typeof startAuthentication>>|Awaited<ReturnType<typeof startRegistration>>>(()=>challenge.action==='login'?startAuthentication({optionsJSON:challenge.options as AuthenticationOptions}):startRegistration({optionsJSON:challenge.options as RegistrationOptions}),remaining,'Your passkey manager did not finish the request. Unlock Bitwarden, enable “Ask to save and use passkeys”, then try again.',interaction.signal,()=>WebAuthnAbortService.cancelCeremony());active(current);
  interaction.onStage?.('verifying');
  return accountAuthStep(signal=>api('/api/auth/passkey/verify',{method:'POST',body:JSON.stringify({challengeId:challenge.challengeId,response}),signal}),15000,'Passkey confirmation took too long. Check your connection and try signing in before creating another account.',interaction.signal);
}
export async function authenticateWithPasskey(action:AccountAuthAction,displayName?:string,current:IsCurrent=always,interaction:PasskeyInteraction={}):Promise<unknown>{
  return completePasskey(await preparePasskey(action,displayName,current,interaction),current,interaction);
}
export function PasskeyHelp(){return <PrivacyNote>Using Bitwarden? Unlock the extension and enable “Ask to save and use passkeys”. Allow it on this site and in private windows if needed. <a href="https://bitwarden.com/help/storing-passkeys/" target="_blank" rel="noreferrer">Passkey help</a></PrivacyNote>;}

export function accountAuthError(error:unknown,method:'passkey'|'nostr'){
  if(error instanceof ApiError)return error.message;
  if(error instanceof AccountInteractionError)return error.message;
  const candidate=error&&typeof error==='object'?error as {name?:string;code?:string;message?:string;cause?:{name?:string}}:{};
  if(['NotAllowedError','AbortError'].includes(candidate.name??'')||['NotAllowedError','AbortError'].includes(candidate.cause?.name??'')||candidate.code==='ERROR_CEREMONY_ABORTED')return method==='passkey'?'The passkey request was cancelled or unavailable. If no prompt appeared, unlock Bitwarden and enable “Ask to save and use passkeys”, then use the password manager option below.':'The signer request was cancelled. Try again when you are ready.';
  if(method==='passkey'&&(candidate.code==='ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED'||candidate.name==='InvalidStateError'))return 'This authenticator already has a passkey for the account. Choose another device or authenticator to add a backup.';
  if(method==='nostr'&&/cancel|reject|denied/i.test(candidate.message??''))return 'The signer request was cancelled. Try again when you are ready.';
  if(method==='passkey'&&(['SecurityError','NotSupportedError','ConstraintError','DataCloneError'].includes(candidate.name??'')||candidate.name==='WebAuthnError'))return 'Your passkey manager could not complete this request. Update and unlock Bitwarden or your authenticator, check its passkey settings, then try again. This account requires user verification.';
  return method==='nostr'?'The signer could not complete this request. Check that it is unlocked, then try again.':'Sign-in could not be completed. Check your connection and try again.';
}

export function AccountAccess({onLogin,demoAvailable=false}:{onLogin:(session:Session)=>void;demoAvailable?:boolean}){
  const [configuration,setConfiguration]=useState<AuthConfiguration|null>(null),[mode,setMode]=useState<'login'|'register'>('login'),[displayName,setDisplayName]=useState(''),[busy,setBusy]=useState<'passkey'|'nostr'|'demo'|null>(null),[error,setError]=useState('');
  const [demoOpen,setDemoOpen]=useState(false),[demoPassword,setDemoPassword]=useState('');
  const [passkeyStage,setPasskeyStage]=useState<PasskeyStage>('preparing'),[preparedPasskey,setPreparedPasskey]=useState<PreparedPasskey|null>(null);
  const generation=useRef(0),locked=useRef(false),passkeyController=useRef<AbortController|null>(null);
  const load=useCallback(async()=>{const current=++generation.current;setError('');try{const result=await accountAuthStep(signal=>api<AuthConfiguration>('/api/auth/config',{signal}),15000,'Sign-in options took too long to load. Check your connection and try again.');if(current!==generation.current)return;if(result.mode!=='hosted'||!Array.isArray(result.methods))throw new Error('Account sign-in is unavailable. Refresh the page and try again.');setConfiguration(result);}catch(error){if(current===generation.current)setError((error as Error).message);}},[]);
  useEffect(()=>{void load();return()=>{generation.current++;passkeyController.current?.abort();WebAuthnAbortService.cancelCeremony();};},[load]);
  async function enter(method:'passkey'|'nostr',prepareOnly=false){
    if(locked.current||!configuration||!configuration.methods.includes(method))return;
    if(mode==='register'&&!configuration.registrationOpen){setError('New account creation is currently unavailable. You can still sign in.');return;}
    locked.current=true;setBusy(method);setError('');const current=generation.current,isCurrent=()=>current===generation.current;
    const controller=new AbortController();if(method==='passkey')passkeyController.current=controller;
    try{
      if(method==='passkey'){
        const interaction={signal:controller.signal,onStage:setPasskeyStage};
        const challenge=preparedPasskey??await preparePasskey(mode,displayName,isCurrent,interaction);
        if(prepareOnly||(!preparedPasskey&&navigator.userActivation&&!navigator.userActivation.isActive)){setPreparedPasskey(challenge);return;}
        setPreparedPasskey(null);await completePasskey(challenge,isCurrent,interaction);
      }else{setPreparedPasskey(null);await authenticateWithNostr(mode,displayName,isCurrent);}
      active(isCurrent);const session=method==='passkey'?await accountAuthStep(signal=>api<Session>('/api/session',{signal}),15000,'Sign-in confirmation took too long. Check your connection and try signing in again.',controller.signal):await api<Session>('/api/session');active(isCurrent);
      if(!session.authenticated)throw new AccountInteractionError('The sign-in could not be confirmed. Try signing in again.');
      setCsrf(session.csrfToken);onLogin(session);navigate('/dashboard');
    }catch(error){if(isCurrent()&&!(error instanceof InterruptedFlow)){setPreparedPasskey(null);setError(accountAuthError(error,method));}}
    finally{if(passkeyController.current===controller)passkeyController.current=null;locked.current=false;if(isCurrent())setBusy(null);}
  }
  async function enterDemo(event:FormEvent){
    event.preventDefault();if(locked.current||!demoAvailable)return;locked.current=true;setBusy('demo');setError('');const current=generation.current;
    try{const session=await accountAuthStep(signal=>api<Session>('/api/session/hackathon-demo',{method:'POST',body:JSON.stringify({password:demoPassword}),signal}),15000,'The demo took too long to open. Check your connection and try again.');if(current!==generation.current)return;setCsrf(session.csrfToken);onLogin(session);navigate('/demo');}
    catch(error){if(current===generation.current)setError(error instanceof ApiError?error.message:'The demo could not be opened. Try again.');}
    finally{locked.current=false;if(current===generation.current)setBusy(null);}
  }
  function switchMode(){if(busy)return;setMode(mode==='login'?'register':'login');setPreparedPasskey(null);setError('');}
  function submit(event:FormEvent){event.preventDefault();void enter('passkey');}
  return <main className="entry account-entry"><div className="entry-story"><Brand/><div className="entry-copy"><p className="eyebrow">YOUR WORK. YOUR WORKSPACE.</p><h1>Good work.<br/>A quieter<br/><em>way in.</em></h1><p>Private invoices and payment records, with an account that does not need a password or phone number.</p><div className="account-entry-promise"><ShieldCheck size={19}/><span>One account. Your own records.</span></div></div><p className="entry-foot"><ShieldCheck size={14}/>No tracking pixels. No financial data on public relays.</p></div>
    <div className="entry-access"><div className="entry-card"><span className="entry-leaf"><KeyRound size={28}/></span><p className="eyebrow">WELCOME TO QUIET LEDGER</p><h2>{mode==='login'?'Sign in without a password.':'Start with a private workspace.'}</h2><p>{mode==='login'?'Use the passkey or Nostr signer already linked to your account.':'Choose how to secure your new account. You can link another credential after signing in.'}</p>
      {error?<ErrorMessage message={error} onRetry={!configuration?()=>void load():undefined}/>:null}
      {!configuration&&!error?<p className="account-wait" role="status"><LoaderCircle className="spin" size={17}/>Checking sign-in options…</p>:null}
      <form onSubmit={submit} className="account-access-form">
        {mode==='register'?<div className="account-alias-field"><label className="field" htmlFor="account-display-name">Private display name (optional)<input id="account-display-name" aria-describedby="account-display-name-help" autoComplete="nickname" maxLength={80} value={displayName} onChange={event=>{setDisplayName(event.target.value);setPreparedPasskey(null);}} disabled={Boolean(busy)} placeholder="A name for your workspace"/></label><small id="account-display-name-help">For your account. It is not fetched from a public profile.</small></div>:null}
        <div className="account-options">
          <button className="button primary full" type="submit" disabled={Boolean(busy)||!configuration?.methods.includes('passkey')}>{busy==='passkey'?<><LoaderCircle className="spin" size={18}/>Waiting for your passkey…</>:<><Fingerprint size={19}/>{preparedPasskey?'Open password manager':mode==='login'?'Continue with a passkey':'Create account with a passkey'}<ArrowUpRight size={17}/></>}</button>
          <button className="button secondary full" type="button" disabled={Boolean(busy)||!configuration?.methods.includes('nostr')} onClick={()=>void enter('nostr')}>{busy==='nostr'?<><LoaderCircle className="spin" size={18}/>Waiting for your signer…</>:<><KeyRound size={18}/>{mode==='login'?'Continue with Nostr':'Create account with Nostr'}<ArrowUpRight size={17}/></>}</button>
        </div>
      </form>
      {busy==='passkey'?<div><p className="account-wait" role="status">{passkeyStage==='preparing'?'Preparing your passkey request…':passkeyStage==='waiting'?'Waiting for your password manager or authenticator. Check its prompt.':'Confirming your passkey with Quiet Ledger…'}</p><button className="text-button" type="button" onClick={()=>passkeyController.current?.abort()}>Cancel passkey request</button></div>:null}
      {preparedPasskey&&!busy?<p className="account-wait" role="status">Your request is ready. Continue to your password manager using the button above.</p>:null}
      {!busy&&!preparedPasskey&&configuration?.methods.includes('passkey')?<button className="text-button entry-switch" type="button" onClick={()=>void enter('passkey',true)}>Use a password manager</button>:null}
      {demoAvailable?<div className="hackathon-demo-access"><button className="button secondary full" type="button" disabled={Boolean(busy)} aria-expanded={demoOpen} onClick={()=>{setDemoOpen(!demoOpen);setError('');}}>Hackathon demo</button>{demoOpen?<form onSubmit={enterDemo}><p>Try a prebuilt fictional business with real Marmot messaging and simulated payments. Public demo password: <strong>marmot</strong>.</p><label className="field">Demo password<input type="password" autoComplete="off" value={demoPassword} onChange={event=>setDemoPassword(event.target.value)} maxLength={128} required disabled={Boolean(busy)}/></label><button className="button primary full" disabled={Boolean(busy)}>{busy==='demo'?'Opening demo…':'Enter hackathon demo'}</button><small>Your demo invoices stay saved in this browser for 30 days. Sign-ins last two hours. No wallet or real funds.</small></form>:null}</div>:null}
      <PasskeyHelp/>
      {configuration?.registrationOpen||mode==='register'?<button className="text-button entry-switch" onClick={switchMode} disabled={Boolean(busy)}>{mode==='login'?'Create an account':'Already have an account? Sign in'}</button>:null}
      <div className="account-privacy-detail"><strong>Encrypted storage, with clear limits.</strong><p>The hosting operator can decrypt your records. This is not zero-knowledge storage. Your signing key stays in your signer or authenticator.</p><p>Using an existing Nostr key can link this account to that public identity.</p></div>
      <PrivacyNote>Keep access to your signer or passkey backup. There is no email or SMS recovery.</PrivacyNote>
    </div><p className="entry-access-foot">NO PASSWORD. NO PHONE NUMBER. YOUR CHOICE.</p></div>
  </main>;
}
