// Focused Coinos POS receiving-adapter coverage for the Count Zapula demo slice.
// Fictional fixture material only: published secp256k1 scalar 1, fictional token
// and address. No network, no real account, no credential, no invoice callback.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import * as bolt11 from 'bolt11';
import {createCoinosPosAdapter as factory} from '../integrations/coinos-pos.js';
import type {HttpFetch} from '../integrations/http.js';
import type {ReceivingContext,ReceivingIntent} from '../shared/receiving.js';

const token='ab'.repeat(32);
const user='fixture-zap',address=`${user}@coinos.io`;
const metadata=JSON.stringify([['text/plain','Paying '+address],['text/identifier',address]]);
const digest=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex');
const preimage='cd'.repeat(32),hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
const sec=Math.floor(Date.now()/1000),created=sec*1000,sats=21;
const network={bech32:'bc',pubKeyHash:0,scriptHash:5,validWitnessVersions:[0,1]};
const testnet={bech32:'tb',pubKeyHash:111,scriptHash:196,validWitnessVersions:[0,1]};
function invoice(opts:{msat?:string;meta?:string;net?:typeof network;time?:number;expiry?:number}={}):string {
  const meta=opts.meta??metadata;
  return bolt11.sign(bolt11.encode({
    network:opts.net??network,timestamp:opts.time??sec,millisatoshis:opts.msat??String(sats*1000),
    tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:digest(meta)},{tagName:'expire_time',data:opts.expiry??3600}],
  // Published secp256k1 scalar 1 is fixture signing material; no wallet is involved.
  }),'0'.repeat(63)+'1').paymentRequest!;
}
const pr=invoice();
const context=(extra:Partial<ReceivingContext>={}):ReceivingContext=>({
  requestId:'fixture-request',method:'lightning',amount:sats,currency:'SAT',expectedAtomic:String(sats),
  idempotencyKey:'fixture-idempotency',createdAt:new Date((sec-5)*1000).toISOString(),
  expiresAt:new Date((sec+3700)*1000).toISOString(),mode:'live',...extra});
const status=(extra:Record<string,unknown>={}):Record<string,unknown>=>({id:hash,amount:sats,tip:0,received:0,paid:null,created,...extra});
const response=(body:unknown,status=200)=>new Response(typeof body==='string'?body:JSON.stringify(body),{status});

interface Call{url:string;method:string;headers:Headers;body:string|null}
function fixture(opts:{me?:unknown;invoice?:unknown;postStatus?:number;meStatus?:number;statusBody?:unknown;failCheck?:boolean;oversize?:boolean}={}){
  const calls:Call[]=[];
  const fetcher:HttpFetch=async(url,init={})=>{
    calls.push({url,method:(init.method??'GET').toUpperCase(),headers:new Headers(init.headers),body:typeof init.body==='string'?init.body:null});
    const u=new URL(url);
    if(u.pathname==='/pos/me')return response(opts.me??{address,username:user},opts.meStatus??200);
    if(u.pathname==='/pos/invoice'){
      if(opts.postStatus)return response({error:'fixture rejection'},opts.postStatus);
      if(opts.oversize)return response('x'.repeat(300*1024));
      return response(opts.invoice??{id:hash,hash:pr,amount:sats,fiat:null,currency:'SAT',rate:1,created});
    }
    if(u.pathname===`/pos/invoice/${hash}`){
      if(opts.failCheck)throw new Error('fixture transport failure');
      return response(opts.statusBody!==undefined?opts.statusBody:status());
    }
    throw new Error('Unexpected fixture endpoint.');
  };
  return {calls,fetcher};
}
const make=(fetcher:HttpFetch)=>factory({id:'pos-fixture',token,expectedAddress:address,fetcher,now:()=>(sec+5)*1000});
const postCount=(calls:Call[])=>calls.filter(c=>c.method==='POST').length;

test('normal provider creation delay clamps its 900-second invoice to the original window',async()=>{
  const f=fixture({invoice:{id:hash,hash:invoice({time:sec+1,expiry:900}),amount:sats,created:(sec+1)*1000}});
  const input=context({expiresAt:new Date((sec+895)*1000).toISOString()});
  const intent=await make(f.fetcher).create(input);
  assert.equal(intent.expiresAt,input.expiresAt);assert.equal(postCount(f.calls),1);
});
test('concurrent creates share one provider operation and returned objects cannot corrupt its cache',async()=>{
  const f=fixture(),adapter=make(f.fetcher),input=context();
  const [one,two]=await Promise.all([adapter.create(input),adapter.create(input)]);
  assert.equal(postCount(f.calls),1);assert.deepEqual(one,two);
  one.request='lightning:changed';if(one.opaque)one.opaque.created=0;
  assert.equal((await adapter.recover!(input)).request,'lightning:'+pr);
});
test('creation snapshots the caller before the first asynchronous operation',async()=>{
  const f=fixture(),adapter=make(f.fetcher),input=context(),pending=adapter.create(input);
  input.amount=22;input.expectedAtomic='22';
  const intent=await pending;
  assert.equal(f.calls.find(call=>call.method==='POST')?.body,'{"amount":21}');
  assert.equal(intent.request,'lightning:'+pr);
});
test('untrusted saved-intent mutations are rejected before any provider access',async()=>{
  for(const mutate of [
    (value:ReceivingIntent)=>{value.request='lightning:not-an-invoice';},
    (value:ReceivingIntent)=>{value.network='testnet';},
    (value:ReceivingIntent)=>{value.asset='CAD';},
    (value:ReceivingIntent)=>{value.allocationKey='foreign';},
    (value:ReceivingIntent)=>{value.expiresAt=new Date((sec+9999)*1000).toISOString();},
    (value:ReceivingIntent)=>{value.providerId='../../pos/payments';value.opaque!.hash=value.providerId;},
  ]){
    const f=fixture({statusBody:status({paid:created+1000,received:sats})}),adapter=make(f.fetcher);
    const intent=await adapter.create(context()),count=f.calls.length;mutate(intent);
    assert.equal((await adapter.check(context(),intent)).status,'review');assert.equal(f.calls.length,count);
  }
});
test('duplicate invoice expiry tags are refused',async()=>{
  const repeated=bolt11.sign(bolt11.encode({network,timestamp:sec,millisatoshis:'21000',tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:digest(metadata)},{tagName:'expire_time',data:3600},{tagName:'expire_time',data:3600}]}),'0'.repeat(63)+'1').paymentRequest!;
  const f=fixture({invoice:{id:hash,hash:repeated,amount:sats,created}});
  await assert.rejects(()=>make(f.fetcher).create(context()));
});
test('pending status requires explicit null paid, zero received and zero tip',async()=>{
  for(const malformed of [status({paid:undefined}),status({tip:10})]){
    const f=fixture({statusBody:malformed}),adapter=make(f.fetcher),intent=await adapter.create(context());
    assert.equal((await adapter.check(context(),intent)).status,'review');
  }
});
const assertAllowedRoutes=(calls:Call[])=>{
  for(const call of calls){
    const u=new URL(call.url);
    assert.equal(u.origin,'https://names.coinos.io');
    assert.ok(['/pos/me','/pos/invoice',`/pos/invoice/${hash}`].includes(u.pathname),`unexpected route ${u.pathname}`);
  }
};

test('create verifies the receiver, posts once and returns a verified lightning intent',async()=>{
  const f=fixture(),intent=await make(f.fetcher).create(context());
  assertAllowedRoutes(f.calls);assert.equal(postCount(f.calls),1);
  assert.deepEqual(f.calls[0].headers.get('authorization'),`Bearer ${token}`);
  assert.equal(f.calls[0].headers.get('user-agent'),'Quiet-Ledger-receiving/0.1');
  assert.equal(f.calls[1].body,'{"amount":21}');
  assert.equal(intent.providerId,hash);
  assert.equal(intent.network,'mainnet');assert.equal(intent.asset,'BTC');
  assert.equal(intent.request,`lightning:${pr}`);
  assert.equal(intent.cashuWalletHandoff,true);
  assert.equal(intent.allocationKey,`lightning:mainnet:${hash}`);
  assert.ok(intent.expiresAt);
  const opaque=intent.opaque as Record<string,unknown>;
  assert.equal(opaque.hash,hash);assert.equal(opaque.receiver,address);
  assert.ok(!JSON.stringify(intent).includes(token),'provider token must never enter the intent');
});
test('identical create retries reuse the cached intent with no second POST',async()=>{
  const f=fixture(),adapter=make(f.fetcher);
  const first=await adapter.create(context());
  const second=await adapter.create(context());
  assert.deepEqual(second,first);assert.equal(postCount(f.calls),1);
});
test('altered request snapshots are refused without touching the provider',async()=>{
  const f=fixture(),adapter=make(f.fetcher);
  await adapter.create(context());
  const calls=postCount(f.calls);
  await assert.rejects(adapter.create(context({amount:22,expectedAtomic:'22'})),/no longer matches its saved/);
  await assert.rejects(adapter.create(context({idempotencyKey:'other-key'})),/no longer matches its saved/);
  assert.equal(postCount(f.calls),calls);
});
test('recover returns only the saved in-memory original success',async()=>{
  const f=fixture(),adapter=make(f.fetcher);
  await assert.rejects(adapter.recover!(context()),/may already have been attempted/);
  const intent=await adapter.create(context());
  const recovered=await adapter.recover!(context());
  assert.deepEqual(recovered,intent);
  assert.deepEqual(recovered,await adapter.create(context()));
});
test('a possible-effect uncertainty never POSTs again and fails closed',async()=>{
  const f=fixture({postStatus:500}),adapter=make(f.fetcher);
  await assert.rejects(adapter.create(context()),/unavailable or returned an invalid response/);
  assert.equal(postCount(f.calls),1);
  await assert.rejects(adapter.create(context()),/may already have been attempted/);
  assert.equal(postCount(f.calls),1,'no second creation POST after uncertainty');
  await assert.rejects(adapter.recover!(context()),/may already have been attempted/);
});
test('tampered response amount is rejected and redacted',async()=>{
  const f=fixture({invoice:{id:hash,hash:pr,amount:42,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(f.fetcher).create(context()),/could not be verified/);
  for(const call of f.calls)assert.ok(!JSON.stringify(call).includes(token));
});
test('invoice msat mismatch is rejected',async()=>{
  const f=fixture({invoice:{id:hash,hash:invoice({msat:String(sats*1000+1)}),amount:sats,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(f.fetcher).create(context()),/could not be verified/);
});
test('payee metadata tampering is rejected',async()=>{
  const other=JSON.stringify([['text/plain','Paying someone-else@coinos.io'],['text/identifier','someone-else@coinos.io']]);
  const f=fixture({invoice:{id:hash,hash:invoice({meta:other}),amount:sats,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(f.fetcher).create(context()),/could not be verified/);
});
test('expired and future-dated invoices are rejected',async()=>{
  const expired=fixture({invoice:{id:hash,hash:invoice({expiry:1,time:sec-60}),amount:sats,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(expired.fetcher).create(context()),/could not be verified/);
  const future=fixture({invoice:{id:hash,hash:invoice({time:sec+3600}),amount:sats,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(future.fetcher).create(context()),/could not be verified/);
});
test('testnet and malformed invoices are rejected',async()=>{
  const tb=fixture({invoice:{id:hash,hash:invoice({net:testnet as unknown as typeof network}),amount:sats,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(tb.fetcher).create(context()),/could not be verified/);
  const broken=fixture({invoice:{id:hash,hash:pr.slice(0,-4)+'qqqq',amount:sats,fiat:null,currency:'SAT',rate:1,created}});
  await assert.rejects(make(broken.fetcher).create(context()),/could not be verified/);
});
test('receiver identity mismatch blocks creation before any POST',async()=>{
  const f=fixture({me:{address:'someone-else@coinos.io',username:'someone-else'}});
  await assert.rejects(make(f.fetcher).create(context()),/receiver verification failed/);
  assert.equal(postCount(f.calls),0);
  const bad=fixture({me:{unexpected:true}});
  await assert.rejects(make(bad.fetcher).create(context()),/unavailable or returned an invalid response/);
  assert.equal(postCount(bad.calls),0);
});
test('provider errors, redirects and oversize bodies fail closed with fixed errors',async()=>{
  await assert.rejects(make(fixture({postStatus:500}).fetcher).create(context()),/unavailable or returned an invalid response/);
  const redirect:HttpFetch=async()=>new Response(null,{status:302,headers:{Location:'https://evil.example/'}});
  await assert.rejects(make(redirect).create(context()),/unavailable or returned an invalid response/);
  const big=fixture({oversize:true});
  await assert.rejects(make(big.fetcher).create(context()),/unavailable or returned an invalid response/);
});
test('configuration and context validation reject before any provider call',async()=>{
  assert.throws(()=>factory({id:'pos-fixture',token:'zz'.repeat(32),expectedAddress:address}),/token/);
  assert.throws(()=>factory({id:'pos-fixture',token,expectedAddress:'bad format'}),/address/);
  const f=fixture();
  await assert.rejects(make(f.fetcher).create(context({currency:'CAD',expectedAtomic:'2500',amount:2500})),/currency/);
  await assert.rejects(make(f.fetcher).create(context({method:'interac'})),/method/);
  await assert.rejects(make(f.fetcher).create(context({mode:'test'})),/mode/);
  await assert.rejects(make(f.fetcher).create(context({expectedAtomic:'22'})),/native amount/);
  assert.equal(f.calls.length,0);
});
test('check reports pending for an unpaid invoice',async()=>{
  const f=fixture(),adapter=make(f.fetcher);
  const intent=await adapter.create(context());
  assert.deepEqual(await adapter.check(context(),intent),{status:'pending'});
  assertAllowedRoutes(f.calls);
});
test('check binds paid state to the exact original invoice context',async()=>{
  const f=fixture({statusBody:status({paid:created+1000,received:sats})}),adapter=make(f.fetcher);
  const intent=await adapter.create(context());
  const paid=await adapter.check(context(),intent);
  assert.deepEqual(paid,{status:'paid',paymentId:hash,amount:sats,currency:'SAT',reference:'fixture-request'});
  const f2=fixture({statusBody:status({paid:created+1000,received:sats})});
  await make(f2.fetcher).create(context({requestId:'other-request',idempotencyKey:'other-key'}));
});
test('overpay, tips and identity mismatches go to review, never credit',async()=>{
  const adapterFor=(body:Record<string,unknown>)=>{
    const f=fixture({statusBody:status({paid:created+1000,...body})});
    return {f,promise:(async()=>{
      const intent=await make(f.fetcher).create(context());
      return make(f.fetcher).check(context(),intent);
    })()};
  };
  for(const body of [{received:sats+1},{tip:1},{received:sats-1},{received:0},{paid:null,received:sats}]){
    const {f,promise}=adapterFor(body);
    const result=await promise;
    assert.equal(result.status,'review',JSON.stringify(body));
    assert.ok(!JSON.stringify(result).includes(token));
    assertAllowedRoutes(f.calls);
  }
});
test('paid timestamps outside the valid window are review',async()=>{
  for(const paid of [created-1,created+3601*1000,Date.now()+60000,'not-a-number' as unknown as number]){
    const f=fixture({statusBody:status({paid,received:sats})});
    const intent=await make(f.fetcher).create(context());
    const result=await make(f.fetcher).check(context(),intent);
    assert.equal(result.status,'review');
  }
});
test('malformed or identity-mismatched status responses are review',async()=>{
  for(const body of [{},status({id:'ff'.repeat(32)}),status({created:created+1}),status({amount:22}),status({received:-1}),status({paid:created+1000,received:sats,tip:'x'}),null] as unknown[]){
    const f=fixture({statusBody:body});
    const intent=await make(f.fetcher).create(context());
    const result=await make(f.fetcher).check(context(),intent);
    assert.equal(result.status,'review');
  }
});
test('check with a mismatched context or intent goes to review',async()=>{
  const f=fixture(),adapter=make(f.fetcher);
  const intent=await adapter.create(context());
  assert.equal((await adapter.check(context({requestId:'altered'}),intent)).status,'review');
  assert.equal((await adapter.check(context(),{...intent,providerId:'ee'.repeat(32)})).status,'review');
  assert.equal((await adapter.check(context(),{providerId:hash})).status,'review');
});
test('check transport failures surface fixed redacted errors',async()=>{
  const f=fixture({failCheck:true});
  const intent=await make(f.fetcher).create(context());
  await assert.rejects(make(f.fetcher).check(context(),intent),/unavailable or returned an invalid response/);
});
test('receiver must still verify before every authoritative check',async()=>{
  const f=fixture({me:{address:'someone-else@coinos.io',username:'someone-else'}});
  const intent=await make(fixture().fetcher).create(context());
  await assert.rejects(make(f.fetcher).check(context(),intent),/receiver verification failed/);
});
