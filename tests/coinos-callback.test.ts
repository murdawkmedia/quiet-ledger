// Focused Coinos callback compatibility coverage for the Count Zapula receiver.
// Published fixture material only; no network, no real account, no invoice callback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import * as bolt11 from 'bolt11';
import {createLnurlAdapter as factory} from '../integrations/lnurl-receiving.js';
import {coinosCallbackAllowed,isCoinosCallbackRequest} from '../integrations/coinos-callback.js';
import {normalizeConnection,verifyConnection} from '../server/connection-providers.js';
import type {HttpFetch} from '../integrations/http.js';
import type {ReceivingContext} from '../shared/receiving.js';

const user='countzapula',address=`${user}@coinos.io`;
const namesCallback=(host='names.coinos.io',u=user,query='domain=coinos.io')=>`https://${host}/lnurlp/${u}/cb${query?`?${query}`:''}`;
const callback=namesCallback();
const metadata=JSON.stringify([['text/plain','Fictional Coinos-style receiver'],['text/identifier',address]]);
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const sec=Math.floor(Date.now()/1000),preimage='ab'.repeat(32),hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
const network={bech32:'bc',pubKeyHash:0,scriptHash:5,validWitnessVersions:[0,1]};
function invoice(meta:string):string {
  // Published secp256k1 scalar 1 is fixture signing material; no wallet is involved.
  return bolt11.sign(bolt11.encode({network,timestamp:sec,millisatoshis:'10000000',tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:digest(meta)},{tagName:'expire_time',data:3600}]}),'0'.repeat(63)+'1').paymentRequest!;
}
const context=():ReceivingContext=>({requestId:'fixture-request',method:'lightning',amount:2500,currency:'CAD',expectedAtomic:'10000',idempotencyKey:'fixture-idempotency',createdAt:new Date((sec-5)*1000).toISOString(),expiresAt:new Date((sec+3500)*1000).toISOString(),mode:'live'});
const response=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
function coinosFixture(cb=callback,meta=metadata){
  const calls:string[]=[];
  const body={tag:'payRequest',callback:cb,minSendable:1000,maxSendable:500000000,metadata:meta};
  const fetcher:HttpFetch=async url=>{
    calls.push(url);const u=new URL(url);
    if(u.pathname===`/.well-known/lnurlp/${user}`||u.pathname===`/lnurlp/${user}`)return response(body);
    if(u.pathname===`/lnurlp/${user}/cb`)return response({status:'OK',routes:[],pr:invoice(meta)});
    throw new Error('Unexpected fixture endpoint.');
  };
  return {calls,fetcher,body};
}
const options={id:'conn-fictional',publicOrigin:'https://ledger.example.com'};
const saved=normalizeConnection({provider:'lightning-address',mode:'live',fields:{lightningAddress:address}},options);
const direct=normalizeConnection({provider:'lnurl',mode:'live',fields:{url:'https://names.coinos.io/lnurlp/countzapula'}},options);

test('live-shaped Coinos metadata is accepted through the saved Lightning Address path',async()=>{
  const f=coinosFixture(),intent=await factory({id:'coinos-saved',lightningAddress:address,fetcher:f.fetcher}).create(context());
  assert.equal(intent.network,'mainnet');assert.equal(intent.asset,'BTC');assert.equal(intent.providerId,hash);
  assert.equal(f.calls.length,2);
  assert.equal(new URL(f.calls[1]).toString(),'https://names.coinos.io/lnurlp/countzapula/cb?domain=coinos.io&amount=10000000');
  assert.equal(intent.cashuWalletHandoff,undefined,'no LUD-21 verify advertised: settlement stays manual review');
  assert.equal((await factory({id:'coinos-saved',lightningAddress:address,fetcher:f.fetcher}).check(context(),intent)).status,'review');
});
test('direct names.coinos.io LNURL configuration accepts the same callback',async()=>{
  const f=coinosFixture(),intent=await factory({id:'coinos-direct',url:'https://names.coinos.io/lnurlp/countzapula',fetcher:f.fetcher}).create(context());
  assert.equal(intent.providerId,hash);assert.equal(f.calls.length,2);
});
test('connection verification accepts Count-shaped metadata without calling the callback',async()=>{
  const v3=coinosFixture(callback,JSON.stringify([['text/plain','Fictional Coinos-style receiver'],['text/identifier','countzapula@v3.coinos.io']]));
  for(const [connection,endpoint,fixture] of [
    [saved,'https://coinos.io/.well-known/lnurlp/countzapula',coinosFixture()],
    [normalizeConnection({provider:'lightning-address',mode:'live',fields:{lightningAddress:'countzapula@v3.coinos.io'}},options),'https://v3.coinos.io/.well-known/lnurlp/countzapula',v3],
    [direct,'https://names.coinos.io/lnurlp/countzapula',coinosFixture()],
  ] as const){
    const result=await verifyConnection(connection,{...options,fetcher:fixture.fetcher});
    assert.equal(result.status,'connected');
    assert.equal(fixture.calls.length,1);assert.equal(new URL(fixture.calls[0]).toString(),endpoint);
  }
});
const rejections:[string,string][]=[
  ['credentials','https://user:pass@names.coinos.io/lnurlp/countzapula/cb?domain=coinos.io'],
  ['fragment',namesCallback('names.coinos.io',user,'domain=coinos.io#x')],
  ['nondefault port','https://names.coinos.io:8443/lnurlp/countzapula/cb?domain=coinos.io'],
  ['alternate recipient',namesCallback('names.coinos.io','other')],
  ['hostname suffix',namesCallback('names.coinos.io.evil.example')],
  ['host prefix',namesCallback('evil-names.coinos.io')],
  ['arbitrary cross-origin','https://callback.example/lnurlp/countzapula/cb?domain=coinos.io'],
  ['duplicate domain',namesCallback('names.coinos.io',user,'domain=coinos.io&domain=coinos.io')],
  ['extra query',namesCallback('names.coinos.io',user,'domain=coinos.io&tag=payRequest')],
  ['foreign domain value',namesCallback('names.coinos.io',user,'domain=evil.example')],
  ['uppercase key',namesCallback('names.coinos.io',user,'DOMAIN=coinos.io')],
];
test('connection verification rejects every listed callback mutation before callback transport',async()=>{
  for(const [name,cb] of rejections){
    const f=coinosFixture(cb);
    await assert.rejects(()=>verifyConnection(saved,{...options,fetcher:f.fetcher}),/verification unavailable/i,name);
    assert.equal(f.calls.length,1,name);
  }
});
test('non-Coinos discovery keeps the generic same-origin rejection',async()=>{
  const f=coinosFixture();
  await assert.rejects(()=>verifyConnection(normalizeConnection({provider:'lightning-address',mode:'live',fields:{lightningAddress:'merchant@wallet.example'}},options),{...options,fetcher:f.fetcher}),/verification unavailable/i);
  await assert.rejects(factory({id:'generic',lightningAddress:'merchant@wallet.example',fetcher:f.fetcher}).create(context()));
});
test('policy helper is strict about discovery and callback shapes',()=>{
  const discovery=new URL('https://coinos.io/.well-known/lnurlp/countzapula'),cb=new URL(callback);
  assert.equal(coinosCallbackAllowed(discovery,cb),true);
  assert.equal(coinosCallbackAllowed(new URL('https://names.coinos.io/lnurlp/countzapula'),cb),true);
  for(const bad of ['http://coinos.io/.well-known/lnurlp/countzapula','https://coinos.io:8443/.well-known/lnurlp/countzapula','https://coinos.io/lnurlp/countzapula/cb','https://wallet.example/.well-known/lnurlp/countzapula','https://coinos.io/.well-known/lnurlp/other','https://u:p@coinos.io/.well-known/lnurlp/countzapula','https://coinos.io/.well-known/lnurlp/countzapula/x'])
    assert.equal(coinosCallbackAllowed(new URL(bad),cb),false,bad);
  for(const bad of ['https://names.coinos.io/lnurlp/countzapula/cb','https://names.coinos.io/lnurlp/CountZapula/cb?domain=coinos.io',`${callback}&x=1`])
    assert.equal(coinosCallbackAllowed(discovery,new URL(bad)),false,bad);
  assert.equal(isCoinosCallbackRequest(new URL(`${callback}&amount=10000000`)),true);
  assert.equal(isCoinosCallbackRequest(new URL(`${callback}&amount=10000000&x=1`)),false);
  assert.equal(isCoinosCallbackRequest(new URL('https://names.coinos.io/lnurlp/countzapula?domain=coinos.io')),false);
});
