import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {test} from 'node:test';
import * as bolt11 from 'bolt11';
import * as bech32 from 'bech32';
import {createLnurlAdapter as factory} from '../integrations/lnurl-receiving.js';
import type {ReceivingContext,ReceivingIntent} from '../shared/receiving.js';
import type {HttpFetch} from '../integrations/http.js';

const sec=Math.floor(Date.now()/1000);
const preimage='ab'.repeat(32),hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
const metadata=JSON.stringify([['text/plain','Fictional receiving fixture'],['text/identifier','fixture@wallet.example']]);
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const context=(extra:Partial<ReceivingContext>={}):ReceivingContext=>({requestId:'fixture-request',method:'lightning',amount:2500,currency:'CAD',expectedAtomic:'10000',idempotencyKey:'fixture-idempotency',createdAt:new Date((sec-5)*1000).toISOString(),expiresAt:new Date((sec+3500)*1000).toISOString(),mode:'live',...extra});
const network=(bech32='bc')=>({bech32,pubKeyHash:bech32==='bc'?0:111,scriptHash:bech32==='bc'?5:196,validWitnessVersions:[0,1]});
function invoice(extra:Partial<bolt11.PaymentRequestObject>={}):string {
  // Published secp256k1 scalar 1 is fixture signing material; no wallet is involved.
  return bolt11.sign(bolt11.encode({network:network(),timestamp:sec,millisatoshis:'10000000',tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:digest(metadata)},{tagName:'expire_time',data:3600}],...extra}), '0'.repeat(63)+'1').paymentRequest!;
}
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
function fixture(){
  const state={calls:[] as {url:string;init?:RequestInit}[],metadata:{tag:'payRequest',callback:'https://wallet.example/callback?username=fixture',minSendable:1000,maxSendable:100_000_000,metadata},callback:{status:'OK',routes:[],pr:invoice(),verify:`https://wallet.example/verify?payment_hash=${hash}`} as any,verify:{status:'OK',settled:false,preimage:null as unknown,pr:''},fail:'',redirect:false};
  const fetcher:HttpFetch=async(url,init)=>{
    state.calls.push({url,init});const path=new URL(url).pathname;
    if(path===state.fail)throw new Error('SECRET_PROVIDER_TRANSPORT');
    if(state.redirect)return new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private?token=SECRET'}});
    if(path==='/pay'||path==='/.well-known/lnurlp/fixture')return response(state.metadata);
    if(path==='/callback')return response(state.callback);
    if(path==='/verify')return response({...state.verify,pr:state.verify.pr||state.callback.pr});
    throw new Error('Unexpected fixture endpoint.');
  };
  const config={id:'lnurl',url:'https://wallet.example/pay',fetcher};
  return {state,fetcher,config,adapter:factory(config)};
}

test('LNURL refuses insecure endpoints and credential URLs before any request',async()=>{
  for(const url of ['http://wallet.example/pay','https://user:SECRET@wallet.example/pay','https://wallet.example/pay?token=SECRET','https://wallet.example/pay?arbitrary_secret=SECRET','https://127.0.0.1/pay','https://10.0.0.1/pay','https://[::ffff:127.0.0.1]/pay','http://127.0.0.1:9000/pay','https://metadata.google.internal/pay','https://wallet.local/pay','https://100.100.100.200/pay','https://[fe80::1]/pay','https://[2::1]/pay','https://wallet.example/pay#SECRET']){
    assert.throws(()=>factory({id:'lnurl',url}),error=>error instanceof Error&&!error.message.includes('SECRET'));
  }
});
test('LNURL requires one trusted receiving destination and explicit compatible test network',()=>{
  assert.throws(()=>factory({id:'lnurl'}));
  assert.throws(()=>factory({id:'lnurl',url:'https://wallet.example/pay',lightningAddress:'fixture@wallet.example'}));
  for(const lightningAddress of ['Fixture@wallet.example','fixture@localhost','fixture@wallet.example/path','fixture@127.0.0.1','fixture@wallet.example?token=SECRET'])assert.throws(()=>factory({id:'lnurl',lightningAddress}));
  assert.throws(()=>factory({id:'lnurl',url:'https://wallet.example/pay',mode:'test'}),/network/i);
  assert.throws(()=>factory({id:'lnurl',url:'https://wallet.example/pay',network:'testnet'}),/network/i);
});
test('LNURL creates exact mainnet invoices and shares repeated/concurrent calls without disclosing remote details',async()=>{
  const f=fixture(),c=context(),[intent,again]=await Promise.all([f.adapter.create(c),f.adapter.create(c)]);
  assert.equal(f.adapter.mode,'live');assert.deepEqual(f.adapter.methods,['lightning']);assert.deepEqual(again,intent);
  assert.equal(intent.request,`lightning:${f.state.callback.pr}`);assert.equal(intent.network,'mainnet');assert.equal(intent.asset,'BTC');
  assert.equal(intent.cashuWalletHandoff,true);assert.equal(intent.expiresAt,new Date((sec+3600)*1000).toISOString());
  assert.equal(intent.allocationKey,`lightning:mainnet:${hash}`);assert(!JSON.stringify(intent).includes(preimage));
  assert.equal(f.state.calls.filter(c=>new URL(c.url).pathname==='/callback').length,1);
  assert.equal(new URL(f.state.calls[1].url).searchParams.get('amount'),'10000000');
  assert(f.state.calls.every(c=>c.init?.redirect==='error'&&c.init?.method==='GET'));
  assert(!JSON.stringify(intent).includes('Fictional receiving fixture'));assert(!JSON.stringify(intent).includes('username='));
  assert.deepEqual(await f.adapter.recover!(c),intent);
});
test('Lightning Address resolves LUD16 and requires matching metadata identity',async()=>{
  const f=fixture(),adapter=factory({id:'address',lightningAddress:'fixture@wallet.example',fetcher:f.fetcher});
  await adapter.create(context());assert.equal(new URL(f.state.calls[0].url).pathname,'/.well-known/lnurlp/fixture');
  f.state.metadata.metadata=JSON.stringify([['text/plain','Fictional'],['text/identifier','other@wallet.example']]);
  await assert.rejects(factory({id:'other',lightningAddress:'fixture@wallet.example',fetcher:f.fetcher}).create(context()),/metadata/i);
});
test('explicit local HTTP fixture and explicit testnet remain available and separate',async()=>{
  const f=fixture();f.state.metadata.callback='http://127.0.0.1:9000/callback?username=fixture';f.state.callback.verify=`http://127.0.0.1:9000/verify?payment_hash=${hash}`;f.state.callback.pr=invoice({network:network('tb')});
  const adapter=factory({id:'local-test',url:'http://127.0.0.1:9000/pay',allowLoopbackHttp:true,mode:'test',network:'testnet',fetcher:f.fetcher}),c=context({mode:'test'}),intent=await adapter.create(c);
  assert.equal(intent.network,'testnet');assert.equal(intent.cashuWalletHandoff,undefined);f.state.verify.settled=true;f.state.verify.preimage=preimage;assert.equal((await adapter.check(c,intent)).status,'paid');
});
test('LNURL verifies only the exact invoice and its SHA256 preimage, returning stable cross-adapter payment identity',async()=>{
  const f=fixture(),c=context(),intent=await f.adapter.create(c);assert.equal((await f.adapter.check(c,intent)).status,'pending');
  f.state.verify.settled=true;f.state.verify.preimage=preimage;
  const paid=await f.adapter.check(c,intent,{transactionId:'payer-claimed-secret'});
  assert.deepEqual(paid,{status:'paid',paymentId:`lightning:mainnet:${hash}`,amount:c.amount,currency:c.currency,reference:c.requestId});assert.deepEqual(await f.adapter.check(c,intent),paid);
  assert(!JSON.stringify(paid).includes(preimage));assert(!JSON.stringify(paid).includes('payer-claimed'));assert(!JSON.stringify(intent).includes(preimage));
});
for(const [name,change] of [
  ['foreign invoice',{pr:invoice({millisatoshis:'10000001'})}],['wrong preimage',{settled:true,preimage:'cd'.repeat(32)}],
  ['base64 preimage',{settled:true,preimage:Buffer.from(preimage,'hex').toString('base64')}],['short preimage',{settled:true,preimage:'ab'}],
  ['null settled preimage',{settled:true,preimage:null}],['nonboolean settlement',{settled:'true',preimage}],['missing status',{status:undefined}],
  ['provider error',{status:'ERROR',reason:'SECRET_PROVIDER_BODY'}],['unsettled with preimage',{settled:false,preimage}],['missing invoice',{pr:undefined}],
] as const)test(`LNURL ${name} never issues a receipt`,async()=>{
  const f=fixture(),c=context(),intent=await f.adapter.create(c);Object.assign(f.state.verify,change);
  if(name==='missing invoice')f.state.callback.pr=undefined;
  const result=await f.adapter.check(c,intent);assert.equal(result.status,'review');assert(!JSON.stringify(result).includes('SECRET'));assert(!JSON.stringify(result).includes(preimage));
});
test('LNURL missing verification support remains review even with sender evidence',async()=>{
  const f=fixture();delete f.state.callback.verify;const c=context(),intent=await f.adapter.create(c);
  assert.equal(intent.cashuWalletHandoff,undefined);
  assert.equal((await f.adapter.check(c,intent,{transactionId:preimage})).status,'review');assert.equal(f.state.calls.length,2);
});
test('LNURL intent or context tampering fails before any verification request',async()=>{
  const f=fixture(),c=context(),intent=await f.adapter.create(c),count=f.state.calls.length;
  const changed:ReceivingIntent[]=[{...intent,providerId:'other'},{...intent,request:'lightning:'+invoice({millisatoshis:'10001000'})},{...intent,network:'testnet'},{...intent,allocationKey:'other'},{...intent,opaque:{...intent.opaque,verifyUrl:'https://other.example/verify'}}];
  for(const candidate of changed)assert.equal((await f.adapter.check(c,candidate)).status,'review');
  for(const extra of [{requestId:'other'},{idempotencyKey:'other'},{amount:2501},{expectedAtomic:'10001'},{mode:'test'}] as Partial<ReceivingContext>[])assert.equal((await f.adapter.check(context(extra),intent)).status,'review');
  assert.equal(f.state.calls.length,count);
});
test('persisted LNURL proof can be checked after restart while fresh recover cannot allocate another invoice',async()=>{
  const f=fixture(),c=context(),intent=await f.adapter.create(c),adapter=factory(f.config),before=f.state.calls.length;
  await assert.rejects(adapter.recover!(c),error=>(error as any).code==='LNURL_RECOVERY_REQUIRED');assert.equal(f.state.calls.length,before);
  f.state.verify.settled=true;f.state.verify.preimage=preimage;assert.equal((await adapter.check(c,JSON.parse(JSON.stringify(intent)))).status,'paid');
});
test('callback timeout preserves uncertainty and blocks later creation/recovery callbacks',async()=>{
  const f=fixture(),c=context();f.state.fail='/callback';
  await assert.rejects(f.adapter.create(c),error=>(error as any).code==='LNURL_CREATION_UNCERTAIN'&&!String(error).includes('SECRET'));
  f.state.fail='';const count=f.state.calls.length;
  await assert.rejects(f.adapter.create(c),error=>(error as any).code==='LNURL_RECOVERY_REQUIRED');
  await assert.rejects(f.adapter.recover!(c),error=>(error as any).code==='LNURL_RECOVERY_REQUIRED');assert.equal(f.state.calls.length,count);
});
test('metadata failures are redacted and remain safe to retry before callback creation',async()=>{
  const f=fixture(),c=context();f.state.fail='/pay';await assert.rejects(f.adapter.create(c),error=>!(error as any).code&&!String(error).includes('SECRET'));
  f.state.fail='';assert((await f.adapter.create(c)).providerId);
});
test('concurrent altered snapshots conflict without creating a second callback',async()=>{
  const f=fixture(),first=f.adapter.create(context());await assert.rejects(f.adapter.create(context({expectedAtomic:'9999'})),/conflict/i);await first;
  assert.equal(f.state.calls.filter(c=>new URL(c.url).pathname==='/callback').length,1);
});
for(const [name,change] of [
  ['too small',{minSendable:10000001}],['too large',{maxSendable:9999999}],['fractional minimum',{minSendable:0.1}],['string bounds',{maxSendable:'100000000'}],['unsafe bounds',{maxSendable:9007199254740992}],['wrong tag',{tag:'withdrawRequest'}],['invalid metadata',{metadata:'SECRET_PROVIDER_BODY'}],['duplicate text metadata',{metadata:JSON.stringify([['text/plain','a'],['text/plain','b']])}],['payer identity required',{payerData:{name:{mandatory:true}}}],
] as const)test(`LNURL ${name} is rejected before invoice allocation`,async()=>{
  const f=fixture();Object.assign(f.state.metadata,change);await assert.rejects(f.adapter.create(context()),error=>!(error as any).code&&!String(error).includes('SECRET'));
  assert.equal(f.state.calls.length,1);
});
test('LNURL exact integer sats amount validation precedes all remote work',async()=>{
  const f=fixture();for(const expectedAtomic of ['0','-1','01','1.5','1e5','2100000000000001'])await assert.rejects(f.adapter.create(context({expectedAtomic})),/amount/i);
  await assert.rejects(f.adapter.create(context({method:'bitcoin'})),/method/i);await assert.rejects(f.adapter.create(context({mode:'test'})),/mode/i);assert.equal(f.state.calls.length,0);
});
for(const [name,make] of [
  ['wrong amount',()=>invoice({millisatoshis:'10000001'})],['amountless',()=>invoice({millisatoshis:undefined})],['wrong network',()=>invoice({network:network('tb')})],['expired',()=>invoice({timestamp:sec-4000})],['future',()=>invoice({timestamp:sec+60})],['old creation',()=>invoice({timestamp:sec-100})],['wrong metadata hash',()=>invoice({tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:'00'.repeat(32)}]})],['duplicate hashes',()=>invoice({tags:[{tagName:'payment_hash',data:hash},{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:digest(metadata)}]})],['zero expiry',()=>invoice({tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:digest(metadata)},{tagName:'expire_time',data:0}]})],['bad checksum',()=>{const pr=invoice();return pr.slice(0,-1)+(pr.endsWith('q')?'p':'q');}],['invalid signature',()=>{const pr=bech32.decode(invoice(),20000);pr.words.fill(0,pr.words.length-104);return bech32.encode(pr.prefix,pr.words,20000);}],
] as const)test(`LNURL ${name} cannot become a payable intent`,async()=>{
  const f=fixture();f.state.callback.pr=make();await assert.rejects(f.adapter.create(context()),error=>(error as any).code==='LNURL_CREATION_UNCERTAIN'&&!String(error).includes('SECRET'));
});
for(const callback of ['https://other.example/callback','http://127.0.0.1/callback','https://wallet.example/callback?token=SECRET','https://wallet.example:444/callback'])test('LNURL blocks callback origin drift and credential queries',async()=>{
  const f=fixture();f.state.metadata.callback=callback;await assert.rejects(f.adapter.create(context()),error=>!String(error).includes('SECRET'));assert.equal(f.state.calls.length,1);
});
for(const verify of ['https://other.example/verify','http://127.0.0.1/verify','https://wallet.example/verify?key=SECRET','https://wallet.example:444/verify'])test('LNURL blocks verification origin drift and credential queries',async()=>{
  const f=fixture();f.state.callback.verify=verify;await assert.rejects(f.adapter.create(context()),error=>(error as any).code==='LNURL_CREATION_UNCERTAIN'&&!String(error).includes('SECRET'));assert.equal(f.state.calls.length,2);
});
test('LNURL refuses redirects without following Location or exposing it',async()=>{
  const f=fixture();f.state.redirect=true;await assert.rejects(f.adapter.create(context()),error=>!String(error).includes('SECRET'));assert.equal(f.state.calls.length,1);
});
test('LNURL expired requests cannot be created and persisted invoices after expiry require review',async()=>{
  const f=fixture();await assert.rejects(f.adapter.create(context({createdAt:new Date((sec-100)*1000).toISOString(),expiresAt:new Date((sec-1)*1000).toISOString()})),/expir/i);assert.equal(f.state.calls.length,0);
  const c=context({expiresAt:new Date(Date.now()+100).toISOString()}),intent=await f.adapter.create(c);f.state.verify.settled=true;f.state.verify.preimage=preimage;
  await new Promise(resolve=>setTimeout(resolve,120));assert.equal((await f.adapter.check(c,intent)).status,'review');
});
test('LNURL check transport/provider errors require review without secrets',async()=>{
  const f=fixture(),c=context(),intent=await f.adapter.create(c);f.state.fail='/verify';const result=await f.adapter.check(c,intent);assert.equal(result.status,'review');assert(!JSON.stringify(result).includes('SECRET'));
});
test('LNURL snapshots receiving values across asynchronous transport work',async()=>{
  const f=fixture(),c=context(),task=f.adapter.create(c);c.amount=9999;c.expectedAtomic='1';c.requestId='changed-during-request';
  const intent=await task;f.state.verify.settled=true;f.state.verify.preimage=preimage;
  assert.equal((await f.adapter.check(context(),intent)).status,'paid');
});
test('LNURL rejects a noncanonical hash tag with nonzero bech32 padding',async()=>{
  const f=fixture(),decoded=bech32.decode(f.state.callback.pr,20000);
  // BOLT11 hash tags have 52 words: only the high bit of the final word belongs
  // to a 256-bit hash. bolt11.decode currently ignores its four padding bits.
  const finalHashWord=7+3+51;decoded.words[finalHashWord]|=1;
  // Re-sign the changed payload so a bad signature cannot hide the padding gap.
  // Reconstructing through bolt11 would erase this invalid padding, so use the
  // fixture dependency's raw secp256k1 signer and the BOLT11 bit conversion.
  const words=decoded.words.slice(0,-104),toBytes=(values:number[],pad:boolean)=>{
    let acc=0,bits=0;const out:number[]=[];for(const v of values){acc=(acc<<5)|v;bits+=5;while(bits>=8){bits-=8;out.push((acc>>bits)&255);}}if(pad&&bits)out.push((acc<<(8-bits))&255);return Buffer.from(out);
  };
  const secp=createRequire(import.meta.url)('secp256k1') as {ecdsaSign(hash:Buffer,key:Buffer):{signature:Uint8Array;recid:number}};
  const signed=secp.ecdsaSign(Buffer.from(digest(Buffer.concat([Buffer.from(decoded.prefix),toBytes(words,true)])),'hex'),Buffer.from('0'.repeat(63)+'1','hex'));
  const signatureWords=bech32.toWords(Buffer.concat([Buffer.from(signed.signature),Buffer.from([signed.recid])]));
  f.state.callback.pr=bech32.encode(decoded.prefix,words.concat(signatureWords),20000);
  assert.equal(bolt11.decode(f.state.callback.pr).tagsObject.payment_hash,hash,'Fixture specifically exposes permissive padding decode.');
  await assert.rejects(f.adapter.create(context()),error=>(error as any).code==='LNURL_CREATION_UNCERTAIN');
});
test('LNURL native transport exercises loopback fixtures and never follows a private redirect',async()=>{
  let base='',redirect=false;const calls:string[]=[];
  const server=createServer((req,res)=>{
    calls.push(req.url!);res.setHeader('Content-Type','application/json');
    if(redirect){res.writeHead(302,{Location:'http://127.0.0.1:1/SECRET'});res.end();return;}
    if(req.url==='/pay')res.end(JSON.stringify({tag:'payRequest',callback:`${base}/callback`,minSendable:1000,maxSendable:100_000_000,metadata}));
    else if(req.url?.startsWith('/callback?amount='))res.end(JSON.stringify({pr:invoice(),routes:[],verify:`${base}/verify`}));
    else if(req.url==='/verify')res.end(JSON.stringify({status:'OK',pr:invoice(),settled:true,preimage}));
    else{res.writeHead(500);res.end('{}');}
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const port=(server.address() as import('node:net').AddressInfo).port;base=`http://127.0.0.1:${port}`;
  try{
    const adapter=factory({id:'native-local',url:`${base}/pay`,allowLoopbackHttp:true}),c=context(),intent=await adapter.create(c);
    assert.equal((await adapter.check(c,intent)).status,'paid');assert.deepEqual(calls,['/pay','/callback?amount=10000000','/verify']);
    redirect=true;await assert.rejects(adapter.create(context({requestId:'redirect'})),error=>!String(error).includes('SECRET'));assert.equal(calls.length,4);
  }finally{await new Promise<void>((resolve,reject)=>server.close(err=>err?reject(err):resolve()));}
});
