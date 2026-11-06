import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {createCryptoAdapter} from '../integrations/crypto-receiving.js';
import type {ReceivingContext} from '../shared/receiving.js';
import type {HttpFetch} from '../integrations/http.js';

const sec=Math.floor(Date.now()/1000), txid='ab'.repeat(32), hash='cd'.repeat(32);
const address='bc1qfixtureonlynotarealaddress000000000000';
const script='0014'+'12'.repeat(20);
const context=(extra:Partial<ReceivingContext>={}):ReceivingContext=>({requestId:'request-fictional-one',method:'bitcoin',amount:2500,currency:'CAD',expectedAtomic:'10000',idempotencyKey:'fictional-key',createdAt:new Date((sec-10)*1000).toISOString(),expiresAt:new Date((sec+3500)*1000).toISOString(),mode:'live',...extra});
const response=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function coreFixture(){
  let label='',allocated=false;
  const state={calls:[] as {method:string;params:any[]}[],chain:'main',synced:true,confirmations:2,amount:0.0001,received:[] as string[],time:sec,walletconflicts:[] as string[],category:'receive',txAddress:address,fail:'',vout:0};
  const fetcher:HttpFetch=async(_url,init)=>{
    const body=JSON.parse(String(init?.body));state.calls.push(body);
    if(body.method===state.fail)throw new Error('SECRET_TRANSPORT_VALUE');
    let result:any;
    switch(body.method){
      case 'getblockchaininfo':result={chain:state.chain,blocks:100,headers:100,bestblockhash:hash,initialblockdownload:!state.synced,verificationprogress:1};break;
      case 'getwalletinfo':result={scanning:false,lastprocessedblock:{hash,height:100}};break;
      case 'getaddressesbylabel':if(!allocated)return response({id:body.id,result:null,error:{code:-11,message:'SECRET_RPC_VALUE'}},500);result={[address]:{purpose:'receive'}};break;
      case 'getnewaddress':label=body.params[0];allocated=true;result=address;break;
      case 'getaddressinfo':result={address,scriptPubKey:script,ismine:false,iswatchonly:true,labels:[label]};break;
      case 'listreceivedbyaddress':result=[{address,amount:state.received.length?state.amount:0,txids:state.received}];break;
      case 'gettransaction':result={txid,confirmations:state.confirmations,blockhash:hash,blocktime:state.time,time:state.time,timereceived:state.time,walletconflicts:state.walletconflicts,details:[{address:state.txAddress,category:state.category,amount:state.amount,vout:state.vout}]};break;
      default:throw new Error('Unexpected fixture RPC '+body.method);
    }
    return response({id:body.id,result,error:null});
  };
  return {state,fetcher,adapter:createCryptoAdapter({kind:'bitcoin-core',id:'core',rpcUrl:'http://127.0.0.1:8332/wallet/receive',allowLoopbackHttp:true,rpcUsername:'fixture-user',rpcPassword:'SECRET_RPC_PASSWORD',fetcher})};
}

test('Core creates a mainnet receive allocation and recovers its deterministic label on retry',async()=>{
  const {adapter,state}=coreFixture(),c=context();
  const a=await adapter.create(c),b=await adapter.create(c);
  assert.equal(adapter.mode,'live');assert.deepEqual(adapter.methods,['bitcoin']);
  assert.equal(a.request,`bitcoin:${address}?amount=0.00010000`);
  assert.equal(a.network,'mainnet');assert.equal(a.asset,'BTC');assert.equal(a.allocationKey,`bitcoin:mainnet:${script}`);
  assert.equal(a.providerId,b.providerId);assert.equal(state.calls.filter(x=>x.method==='getnewaddress').length,1);
  assert(!JSON.stringify(a).includes('SECRET'));assert(!JSON.stringify(a).includes('127.0.0.1'));
  assert(state.calls.every(x=>!/^send|sign|walletpassphrase|import|dump/.test(x.method)));
});
test('Core concurrent creation shares one allocation',async()=>{
  const {adapter,state}=coreFixture();const intents=await Promise.all([adapter.create(context()),adapter.create(context())]);
  assert.equal(intents[0].allocationKey,intents[1].allocationKey);assert.equal(state.calls.filter(x=>x.method==='getnewaddress').length,1);
});
test('Core concurrent creation rejects a changed request snapshot',async()=>{
  const f=coreFixture(),a=f.adapter.create(context());
  await assert.rejects(f.adapter.create(context({expectedAtomic:'9999'})),/conflict/i);await a;
});
test('Core watch allocation never asks the node for a new address',async()=>{
  const f=coreFixture(),adapter=createCryptoAdapter({kind:'bitcoin-core',id:'watch',rpcUrl:'https://node.example',rpcUsername:'x',rpcPassword:'x',address,fetcher:f.fetcher});
  const c=context(),intent=await adapter.create(c);f.state.received=[txid];assert.equal((await adapter.check(c,intent)).status,'paid');
  assert(!f.state.calls.some(x=>['getnewaddress','getaddressesbylabel','setlabel','importdescriptors'].includes(x.method)));
});
test('Core explicit testnet remains separate from live mainnet',async()=>{
  const f=coreFixture();f.state.chain='test';
  const adapter=createCryptoAdapter({kind:'bitcoin-core',id:'testcore',mode:'test',network:'testnet',rpcUrl:'https://node.example',rpcUsername:'x',rpcPassword:'x',fetcher:f.fetcher});
  const intent=await adapter.create(context({mode:'test'}));assert.equal(intent.network,'testnet');assert.equal(adapter.mode,'test');
  assert.throws(()=>createCryptoAdapter({kind:'bitcoin-core',id:'badtest',mode:'test',rpcUrl:'https://node.example',rpcUsername:'x',rpcPassword:'x'}),/network/i);
});
test('Core verifies exact confirmed output and returns original invoice units with a stable output id',async()=>{
  const {adapter,state}=coreFixture(),c=context(),intent=await adapter.create(c);state.received=[txid];
  const paid=await adapter.check(c,intent,{transactionId:'untrusted-ignored'});
  assert.deepEqual(paid,{status:'paid',paymentId:`bitcoin:mainnet:${txid}:0`,amount:c.amount,currency:c.currency,reference:c.requestId});
  assert.deepEqual(await adapter.check(c,intent),paid);
});
for(const [name,change,status] of [
  ['no payment',{},'pending'],['unconfirmed',{received:[txid],confirmations:0},'pending'],
  ['underpaid',{received:[txid],amount:0.00009},'review'],['overpaid',{received:[txid],amount:0.00011},'review'],
  ['late',{received:[txid],time:sec+3600},'review'],['old',{received:[txid],time:sec-100},'review'],
  ['conflicted',{received:[txid],walletconflicts:[hash]},'review'],['negative confirmations',{received:[txid],confirmations:-1},'review'],
  ['wrong destination',{received:[txid],txAddress:'other'},'review'],['nonreceive',{received:[txid],category:'send'},'review'],
  ['invalid output',{received:[txid],vout:-1},'review'],['malformed amount',{received:[txid],amount:NaN},'review'],
] as const)test(`Core ${name} never credits funds`,async()=>{
  const {adapter,state}=coreFixture(),c=context(),intent=await adapter.create(c);Object.assign(state,change);
  assert.equal((await adapter.check(c,intent)).status,status);
});
test('Core excludes outputs already known at allocation',async()=>{
  const {adapter,state}=coreFixture();state.received=[txid];const c=context(),intent=await adapter.create(c);
  assert.equal((await adapter.check(c,intent)).status,'review');
});
test('Core rejects mixed request/mode/network and unsynced nodes before allocation',async()=>{
  const {adapter,state}=coreFixture();
  await assert.rejects(adapter.create(context({mode:'test'})),/mode/i);
  await assert.rejects(adapter.create(context({method:'liquid'})),/method/i);
  state.chain='test';await assert.rejects(adapter.create(context()),/network/i);
  state.chain='main';state.synced=false;await assert.rejects(adapter.create(context()),/sync/i);
  assert.equal(state.calls.filter(x=>x.method==='getnewaddress').length,0);
});
test('invalid native amount strings never reach a node',async()=>{
  const f=coreFixture();for(const expectedAtomic of ['0','-1','01','1.5','1e5','2100000000000001'])await assert.rejects(f.adapter.create(context({expectedAtomic})),/amount/i);
  assert.equal(f.state.calls.length,0);
});
test('Core cannot replay an intent against a different request or altered native expectation',async()=>{
  const {adapter,state}=coreFixture(),c=context(),intent=await adapter.create(c);state.received=[txid];
  assert.equal((await adapter.check(context({requestId:'other'}),intent)).status,'review');
  assert.equal((await adapter.check(context({expectedAtomic:'9999'}),intent)).status,'review');
});
test('Core handles second-resolution node timestamps when an intent starts during that second',async()=>{
  const {adapter,state}=coreFixture(),c=context({createdAt:new Date(sec*1000+123).toISOString()}),intent=await adapter.create(c);state.received=[txid];
  assert.equal((await adapter.check(c,intent)).status,'paid');
});
test('Core treats an ambiguous expiry-second timestamp as review',async()=>{
  const {adapter,state}=coreFixture(),c=context({expiresAt:new Date((sec+10)*1000+123).toISOString()}),intent=await adapter.create(c);state.received=[txid];state.time=sec+10;
  assert.equal((await adapter.check(c,intent)).status,'review');
});
test('Core malformed or misbound RPC responses fail closed without exposing provider fields',async()=>{
  const f=coreFixture(),c=context();let corrupt=false;
  const fetcher:HttpFetch=async(url,init)=>corrupt?response({id:-1,result:{secret:'SECRET_RESPONSE'}}):f.fetcher(url,init);
  const adapter=createCryptoAdapter({kind:'bitcoin-core',id:'core',rpcUrl:'https://node.example',rpcUsername:'x',rpcPassword:'SECRET',fetcher});
  const intent=await adapter.create(c);corrupt=true;const result=await adapter.check(c,intent);assert.equal(result.status,'review');assert(!JSON.stringify(result).includes('SECRET'));
});
test('Core transport failures are redacted and never paid',async()=>{
  const {adapter,state}=coreFixture(),c=context(),intent=await adapter.create(c);state.fail='gettransaction';state.received=[txid];
  const result=await adapter.check(c,intent);assert.equal(result.status,'review');assert(!JSON.stringify(result).includes('SECRET'));
  state.fail='getblockchaininfo';await assert.rejects(adapter.create(context()),error=>error instanceof Error&&!error.message.includes('SECRET'));
});
test('crypto transports reject insecure external URLs, URL credentials and implicit loopback HTTP',()=>{
  for(const rpcUrl of ['http://node.example/rpc','https://user:pass@node.example/rpc','file:///tmp/rpc','http://127.0.0.1:8332'])assert.throws(()=>createCryptoAdapter({kind:'bitcoin-core',id:'bad',rpcUrl,rpcUsername:'x',rpcPassword:'x'}));
});

function lndFixture(){
  const node='02'+'ef'.repeat(32);let invoice:any=null,decode:any=null;
  const state={calls:[] as {url:string;init?:RequestInit}[],settled:false,paid:'10000000',network:'mainnet',synced:true,settleDate:String(sec+1),failPost:false};
  const fetcher:HttpFetch=async(url,init)=>{
    state.calls.push({url,init});const path=new URL(url).pathname;
    if(path==='/v1/getinfo')return response({identity_pubkey:node,synced_to_chain:state.synced,chains:[{chain:'bitcoin',network:state.network}]});
    if(path.startsWith('/v1/invoice/'))return invoice?response({...invoice,state:state.settled?'SETTLED':'OPEN',settled:state.settled,amt_paid_sat:state.settled?'10000':'0',amt_paid_msat:state.settled?state.paid:'0',settle_date:state.settled?state.settleDate:'0'}):response({code:5,message:'unable to locate invoice'},404);
    if(path==='/v1/invoices'&&init?.method==='POST'){
      const body=JSON.parse(String(init.body)),rhash=createHash('sha256').update(Buffer.from(body.r_preimage,'base64')).digest();
      invoice={memo:body.memo,r_hash:rhash.toString('base64'),value:body.value,value_msat:String(BigInt(body.value)*1000n),creation_date:String(sec),expiry:body.expiry,payment_request:'lnbc100u1fixtureonly',is_amp:false,is_keysend:false};
      decode={destination:node,payment_hash:rhash.toString('hex'),num_satoshis:body.value,num_msat:String(BigInt(body.value)*1000n),timestamp:String(sec),expiry:body.expiry,description:body.memo};
      if(state.failPost){state.failPost=false;throw new Error('SECRET_LND_ERROR');}
      return response({r_hash:invoice.r_hash,payment_request:invoice.payment_request});
    }
    if(path.startsWith('/v1/payreq/'))return response(decode);
    throw new Error('Unexpected LND fixture path');
  };
  return {state,fetcher,adapter:createCryptoAdapter({kind:'lnd',id:'lnd',baseUrl:'https://node.example',macaroonHex:'a1'.repeat(32),invoiceHmacSecret:'fixture-only-secret-for-stable-invoices',fetcher}),invoice:()=>invoice,decode:()=>decode};
}
test('LND creates/reuses exact invoices, validates node and request, and settles only exact millisatoshis',async()=>{
  const {adapter,state}=lndFixture(),c=context({method:'lightning'}),intent=await adapter.create(c);
  assert.equal(intent.network,'mainnet');assert.equal(intent.asset,'BTC');assert.match(intent.request!,/^lightning:lnbc/);
  assert.equal(intent.cashuWalletHandoff,true);
  assert.deepEqual(await adapter.create(c),intent);assert.equal(state.calls.filter(x=>x.init?.method==='POST').length,1);
  assert.equal((await adapter.check(c,intent)).status,'pending');state.settled=true;
  const paid=await adapter.check(c,intent);assert.equal(paid.status,'paid');assert.deepEqual(await adapter.check(c,intent),paid);
  assert(!JSON.stringify(intent).includes('preimage'));assert(!JSON.stringify(intent).includes('fixture-only-secret'));
  state.paid='10000001';assert.equal((await adapter.check(c,intent)).status,'review');
});
test('LND recovers invoice created during a timed-out response without creating another',async()=>{
  const fixture=lndFixture(),c=context({method:'lightning'});fixture.state.failPost=true;
  await assert.rejects(fixture.adapter.create(c),/unavailable/i);
  const adapter=createCryptoAdapter({kind:'lnd',id:'lnd',baseUrl:'https://node.example',macaroonHex:'a1'.repeat(32),invoiceHmacSecret:'fixture-only-secret-for-stable-invoices',fetcher:fixture.fetcher});
  assert((await adapter.create(c)).providerId);assert.equal(fixture.state.calls.filter(x=>x.init?.method==='POST').length,1);
});
test('LND rejects wrong network, unsynced nodes, changed destination, old and late settlements',async()=>{
  const f=lndFixture(),c=context({method:'lightning'});f.state.network='testnet';await assert.rejects(f.adapter.create(c),/network/i);
  f.state.network='mainnet';f.state.synced=false;await assert.rejects(f.adapter.create(c),/sync/i);f.state.synced=true;
  const intent=await f.adapter.create(c);f.state.settled=true;f.decode().destination='02'+'00'.repeat(32);assert.equal((await f.adapter.check(c,intent)).status,'review');f.decode().destination='02'+'ef'.repeat(32);
  f.state.settleDate=String(sec-100);assert.equal((await f.adapter.check(c,intent)).status,'review');
  f.state.settleDate=String(sec+3600);assert.equal((await f.adapter.check(c,intent)).status,'review');
});
for(const [name,mutate] of [
  ['foreign hash',(invoice:any)=>{invoice.r_hash=Buffer.alloc(32).toString('base64');}],
  ['wrong native asset amount',(invoice:any)=>{invoice.value='9999';}],
  ['different request',(invoice:any)=>{invoice.memo='Another request';}],
  ['zero expiry',(invoice:any)=>{invoice.expiry='0';}],
  ['AMP',(invoice:any)=>{invoice.is_amp=true;}],
] as const)test(`LND ${name} requires review`,async()=>{
  const f=lndFixture(),c=context({method:'lightning'}),intent=await f.adapter.create(c);f.state.settled=true;mutate(f.invoice());
  assert.equal((await f.adapter.check(c,intent)).status,'review');
});
test('LND settlement after invoice expiry requires review even inside the outer request window',async()=>{
  const f=lndFixture(),c=context({method:'lightning'}),intent=await f.adapter.create(c);f.state.settled=true;f.invoice().expiry='1';f.decode().expiry='1';f.state.settleDate=String(sec+10);
  assert.equal((await f.adapter.check(c,intent)).status,'review');
});
for(const method of ['usdt','usdc','cashu','ark','lightning','liquid'] as const)test(`${method} manual instructions never turn payer evidence into settlement`,async()=>{
  const adapter=createCryptoAdapter({kind:'manual',id:`manual-${method}`,method,address:method==='usdt'||method==='usdc'?'0x'+'12'.repeat(20):'fixture-receive-destination',network:method==='usdt'||method==='usdc'?'ethereum-mainnet':'mainnet'}),c=context({method});
  const intent=await adapter.create(c);assert(intent.instructions?.length);assert(intent.allocationKey);
  assert.equal(intent.cashuWalletHandoff,undefined);
  assert.equal((await adapter.check(c,intent,{transactionId:txid})).status,'review');
});
test('stablecoin instructions require explicit supported network, EVM destination and 6 decimal atomic amount',async()=>{
  assert.throws(()=>createCryptoAdapter({kind:'manual',id:'usdt',method:'usdt',address:'0x'+'12'.repeat(20)}),/network/i);
  assert.throws(()=>createCryptoAdapter({kind:'manual',id:'usdc',method:'usdc',address:'not-an-address',network:'ethereum-mainnet'}),/destination/i);
  const adapter=createCryptoAdapter({kind:'manual',id:'usdc',method:'usdc',address:'0x'+'12'.repeat(20),network:'ethereum-mainnet'});
  const intent=await adapter.create(context({method:'usdc',expectedAtomic:'1234567'}));assert(intent.instructions?.some(x=>x.value==='1.234567 USDC'));
});
test('manual instructions reject credential URLs and Cashu bearer tokens',()=>{
  for(const address of ['https://user:secret@mint.example','https://mint.example?token=secret','cashuAeyJmaXh0dXJlIjoiYmVhcmVyIn0'])assert.throws(()=>createCryptoAdapter({kind:'manual',id:'cashu',method:'cashu',address}),/destination/i);
});
test('Liquid RPC allocation/readback keeps confidential or unproven asset amounts under review',async()=>{
  const f=coreFixture(),adapter=createCryptoAdapter({kind:'liquid',id:'liquid',rpcUrl:'https://elements.example',rpcUsername:'fixture',rpcPassword:'fixture',fetcher:f.fetcher});f.state.chain='liquidv1';
  const c=context({method:'liquid'}),intent=await adapter.create(c);assert.equal(intent.asset,'L-BTC');assert.equal(intent.network,'liquid');
  f.state.received=[txid];assert.equal((await adapter.check(c,intent)).status,'review');
});
