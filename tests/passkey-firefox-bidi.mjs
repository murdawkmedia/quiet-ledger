/** Actual installed Firefox; synthetic manager responses. No user profile/vault is opened. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash,generateKeyPairSync,randomBytes,sign} from 'node:crypto';
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {isoCBOR} from '@simplewebauthn/server/helpers';
const origin='http://localhost:4332',artifacts=resolve(process.env.QUIET_LEDGER_PASSKEY_ARTIFACTS??'.runtime/passkey-firefox-artifacts');
const directory=await mkdtemp(join(tmpdir(),'quiet-ledger-firefox-'));
const temporaryPort=await new Promise(resolve=>{const server=createServer();server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(()=>resolve(port));});});
const wait=milliseconds=>new Promise(resolve=>setTimeout(resolve,milliseconds));
let fixture,firefox,socket,sequence=0,rpc;const pending=new Map(),events=[],checks=[];
async function eventually(read,predicate=Boolean){for(let i=0;i<200;i++){const value=await read();if(predicate(value))return value;await wait(50);}throw new Error('Condition was not met within 10 seconds.');}
const start=(command,args)=>{const child=spawn(command,args,{stdio:['ignore','pipe','pipe']});child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});return child;};
async function stop(child){if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),wait(5000)]);if(child.exitCode===null)child.kill('SIGKILL');}
try{
  fixture=start(process.execPath,['--import','tsx','tests/hosted-accounts-app.ts']);
  await eventually(async()=>{try{return (await fetch(origin+'/api/health')).ok;}catch{return false;}});
  firefox=start(process.env.FIREFOX_EXECUTABLE??'/usr/bin/firefox',['--headless','--no-remote','--profile',directory,'--remote-debugging-port',String(temporaryPort),'about:blank']);
  socket=await eventually(async()=>{const candidate=new WebSocket(`ws://127.0.0.1:${temporaryPort}/session`);try{await new Promise((resolve,reject)=>{candidate.onopen=resolve;candidate.onerror=reject;});return candidate;}catch{candidate.close();return null;}});
  socket.onmessage=({data})=>{const message=JSON.parse(data);if(message.id){const promise=pending.get(message.id);pending.delete(message.id);if(message.type==='error')promise?.reject(new Error(JSON.stringify(message)));else promise?.resolve(message.result);}else events.push(message);};
  rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  const session=await rpc('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:false}}});
  await rpc('session.subscribe',{events:['log.entryAdded']});
  let installedAddon=null;
  if(process.env.QUIET_LEDGER_BITWARDEN_XPI)installedAddon=await rpc('webExtension.install',{extensionData:{type:'path',path:resolve(process.env.QUIET_LEDGER_BITWARDEN_XPI)}});
  const {context}=await rpc('browsingContext.create',{type:'tab'});
  const evaluate=async(expression,awaitPromise=true)=>{const result=await rpc('script.evaluate',{expression,target:{context},awaitPromise,resultOwnership:'none'});if(result.type==='exception')throw new Error(result.exceptionDetails.text);return result.result.value;};
  const click=async text=>{
    const coordinates=JSON.parse(await evaluate(`JSON.stringify((()=>{const button=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()===${JSON.stringify(text)});if(!button||button.disabled)throw new Error('Button unavailable: '+${JSON.stringify(text)});button.scrollIntoView({block:'center'});const r=button.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})())`));
    await rpc('browsingContext.activate',{context});await rpc('input.performActions',{context,actions:[{type:'pointer',id:'mouse',parameters:{pointerType:'mouse'},actions:[{type:'pointerMove',...coordinates},{type:'pointerDown',button:0},{type:'pointerUp',button:0}]}]});
  };
  const button=label=>evaluate(`[...document.querySelectorAll('button')].some(x=>!x.disabled&&x.textContent.trim()===${JSON.stringify(label)})`);
  const navigate=async path=>{await rpc('browsingContext.navigate',{context,url:origin+path,wait:'complete'});};
  await navigate('/');await eventually(()=>button('Create an account'));const originalCreate=await evaluate('navigator.credentials.create.toString().slice(0,100)');
  await click('Create an account');await eventually(()=>button('Use a password manager'));
  await evaluate(`window.__fixtureCalls=[];window.__fixtureVerifies=0;const originalFetch=window.fetch;window.fetch=function(input,...rest){if(String(input).endsWith('/api/auth/passkey/verify'))window.__fixtureVerifies++;return originalFetch.call(this,input,...rest);};navigator.credentials.create=options=>new Promise(resolve=>{window.__fixtureResolve=resolve;window.__fixtureCalls.push({active:navigator.userActivation.isActive,selection:options.publicKey.authenticatorSelection,challenge:Array.from(new Uint8Array(options.publicKey.challenge)),user:Array.from(new Uint8Array(options.publicKey.user.id)),rpID:options.publicKey.rp.id});});`);
  await click('Use a password manager');await eventually(()=>button('Open password manager'));assert.equal(await evaluate('window.__fixtureCalls.length'),0);
  await click('Open password manager');await eventually(()=>evaluate('window.__fixtureCalls.length===1'));
  const firstCall=JSON.parse(await evaluate('JSON.stringify(window.__fixtureCalls[0])'));assert.equal(firstCall.active,true);assert.equal(firstCall.selection.userVerification,'required');assert.equal(firstCall.selection.residentKey,'required');assert.equal(firstCall.selection.authenticatorAttachment,undefined);
  await click('Cancel passkey request');await eventually(()=>button('Create account with a passkey'));assert.match(await evaluate('document.querySelector("[role=alert]").textContent'),/cancelled/);assert.equal(await evaluate('window.__fixtureVerifies'),0);checks.push('trusted-click continuation and ignored-abort cancellation');
  await click('Use a password manager');await eventually(()=>button('Open password manager'));await click('Open password manager');await eventually(()=>evaluate('window.__fixtureCalls.length===2'));
  const call=JSON.parse(await evaluate('JSON.stringify(window.__fixtureCalls[1])'));
  const hash=value=>createHash('sha256').update(value).digest(),pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),jwk=pair.publicKey.export({format:'jwk'}),id=randomBytes(32);
  const cose=new Map([[1,2],[3,-7],[-1,1],[-2,new Uint8Array(Buffer.from(jwk.x,'base64url'))],[-3,new Uint8Array(Buffer.from(jwk.y,'base64url'))]]),length=Buffer.alloc(2);length.writeUInt16BE(id.length);
  const authData=Buffer.concat([hash(call.rpID),Buffer.from([0x45]),Buffer.alloc(4),Buffer.alloc(16),length,id,Buffer.from(isoCBOR.encode(cose))]);
  const client=Buffer.from(JSON.stringify({type:'webauthn.create',challenge:Buffer.from(call.challenge).toString('base64url'),origin,crossOrigin:false}));
  const attestation=Buffer.from(isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',new Uint8Array(authData)]])));
  await evaluate(`(()=>{const buffer=value=>Uint8Array.from(atob(value),x=>x.charCodeAt(0)).buffer;window.__fixtureResolve({id:${JSON.stringify(id.toString('base64url'))},rawId:buffer(${JSON.stringify(id.toString('base64'))}),type:'public-key',authenticatorAttachment:'cross-platform',response:{clientDataJSON:buffer(${JSON.stringify(client.toString('base64'))}),attestationObject:buffer(${JSON.stringify(attestation.toString('base64'))}),getTransports:()=>['hybrid','internal']},getClientExtensionResults:()=>({})});})()`);
  await eventually(()=>evaluate('location.pathname==="/dashboard"'));checks.push('synthetic manager registration verified by real server and established Firefox session');
  const first=JSON.parse(await evaluate('fetch("/api/session").then(r=>r.json()).then(JSON.stringify)'));assert.equal(first.authenticated,true);
  await eventually(()=>button('Leave workspace'));await click('Leave workspace');await eventually(()=>button('Use a password manager'));
  await evaluate(`window.__fixtureLogin=null;navigator.credentials.get=options=>new Promise(resolve=>{window.__fixtureLogin={challenge:Array.from(new Uint8Array(options.publicKey.challenge)),rpID:options.publicKey.rpId,active:navigator.userActivation.isActive,uv:options.publicKey.userVerification};window.__fixtureResolveLogin=resolve;});`);
  await click('Use a password manager');await eventually(()=>button('Open password manager'));await click('Open password manager');await eventually(()=>evaluate('Boolean(window.__fixtureLogin)'));
  const login=JSON.parse(await evaluate('JSON.stringify(window.__fixtureLogin)'));assert.equal(login.active,true);assert.equal(login.uv,'required');
  const counter=Buffer.alloc(4);counter.writeUInt32BE(1);const loginData=Buffer.concat([hash(login.rpID),Buffer.from([5]),counter]),loginClient=Buffer.from(JSON.stringify({type:'webauthn.get',challenge:Buffer.from(login.challenge).toString('base64url'),origin,crossOrigin:false})),signature=sign('sha256',Buffer.concat([loginData,hash(loginClient)]),pair.privateKey);
  await evaluate(`(()=>{const buffer=value=>Uint8Array.from(atob(value),x=>x.charCodeAt(0)).buffer;window.__fixtureResolveLogin({id:${JSON.stringify(id.toString('base64url'))},rawId:buffer(${JSON.stringify(id.toString('base64'))}),type:'public-key',authenticatorAttachment:'cross-platform',response:{clientDataJSON:buffer(${JSON.stringify(loginClient.toString('base64'))}),authenticatorData:buffer(${JSON.stringify(loginData.toString('base64'))}),signature:buffer(${JSON.stringify(signature.toString('base64'))}),userHandle:new Uint8Array(${JSON.stringify(call.user)}).buffer},getClientExtensionResults:()=>({})});})()`);
  await eventually(()=>evaluate('location.pathname==="/dashboard"'));const second=JSON.parse(await evaluate('fetch("/api/session").then(r=>r.json()).then(JSON.stringify)'));assert.equal(second.accountId,first.accountId);checks.push('synthetic manager signature verified on login to the same Firefox account');
  await mkdir(artifacts,{recursive:true});await writeFile(join(artifacts,'firefox-bidi.json'),JSON.stringify({browser:session.capabilities.browserName,version:session.capabilities.browserVersion,headless:session.capabilities['moz:headless'],installedAddon,bitwardenVaultUsed:false,actualBitwardenCeremony:false,manager:'synthetic WebAuthn override',originalCreate,checks,consoleErrors:events.filter(x=>x.params?.level==='error').map(x=>x.params.text)},null,2));
  console.log(JSON.stringify({browser:session.capabilities.browserVersion,checks,actualBitwardenCeremony:false}));
}finally{
  if(rpc&&socket?.readyState===WebSocket.OPEN){await rpc('session.end').catch(()=>{});socket.close();}
  await stop(firefox);await stop(fixture);await rm(directory,{recursive:true,force:true});
}
