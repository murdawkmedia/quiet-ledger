import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeConnection,buildConnectionAdapter,CONNECTION_PROVIDERS} from '../server/connection-providers.js';
import type {HttpFetch} from '../integrations/http.js';
const options={id:'conn-fictional',publicOrigin:'https://ledger.example.com'};
const key='02'+'22'.repeat(32),hash='ab'.repeat(32);
const address='ark1pghdlurfzqqpjy9akejayl2vvcse6he97rn40g84xrlvrlnhayuuyefrp9nse2yspqqu22rk7';
const inputs:Record<string,Record<string,string>>={
  'lightning-address':{lightningAddress:'merchant@receiver.example.com'},lnurl:{url:'https://receiver.example.com/pay'},
  'bitcoin-core':{rpcUrl:'https://node.example.com/wallet/receiving',rpcUsername:'fictional',rpcPassword:'fictional-password'},
  'watch-only':{rpcUrl:'https://node.example.com/wallet/watched',rpcUsername:'fictional',rpcPassword:'fictional-password',address:'bc1q'+'q'.repeat(38)},
  liquid:{rpcUrl:'https://elements.example.com/wallet/receiving',rpcUsername:'fictional',rpcPassword:'fictional-password'},
  lnd:{baseUrl:'https://lnd.example.com',macaroonHex:'ab'.repeat(32)},
  bark:{baseUrl:'https://bark.example.com',token:Buffer.concat([Buffer.from([0]),Buffer.alloc(32,7)]).toString('base64url'),expectedServerPubkey:key,addressIndex:'7',expectedAddress:address},
  stripe:{secretKey:'sk_live_fictional',accountId:'acct_fixture',merchantCountry:'CA'},
  paypal:{clientId:'fictional-client',clientSecret:'fictional-secret',merchantId:'MERCHANT123',merchantCountry:'CA'},
  revolut:{secretKey:'fictional-secret',locationId:'12345678-1234-1234-1234-123456789abc',merchantCountry:'GB'},
  square:{accessToken:'fictional-token',locationId:'LOCATION123',merchantId:'MERCHANT123',merchantCountry:'CA',currency:'CAD'},
  'bank-instructions':{method:'interac',recipient:'Fictional Merchant',instructions:'Send to billing@example.com. Use the payment reference.'},
  'static-crypto':{method:'usdc',address:'0x'+'12'.repeat(20),network:'ethereum-mainnet'},
};
function normalized(provider:string){return normalizeConnection({provider,mode:'live',fields:inputs[provider]},options);}

test('saved providers normalize only documented fields and generate private stable Lightning secrets',async()=>{
  const mod=await import('../server/connection-providers.js').catch(()=>({})) as any;
  assert.equal(typeof mod.normalizeConnection,'function','saved connection normalization must exist');
  const options={id:'conn-fictional',publicOrigin:'https://ledger.example.com'};
  const input={provider:'lnd',label:'Fictional node',mode:'live',fields:{baseUrl:'https://lnd.example.com',macaroonHex:'ab'.repeat(32)}};
  const normalized=mod.normalizeConnection(input,options);
  assert.equal(normalized.provider,'lnd');assert.equal(normalized.label,'Fictional node');
  assert.match(normalized.fields.invoiceHmacSecret,/^[a-f0-9]{64}$/);
  assert.throws(()=>mod.normalizeConnection({...input,fetcher:'override'},options));
  assert.throws(()=>mod.normalizeConnection({...input,fields:{...input.fields,invoiceHmacSecret:'chosen'}},options));
  assert.throws(()=>mod.normalizeConnection({...input,fields:{...input.fields,nsec:'forbidden'}},options));
});

test('verification uses only metadata/account reads and never creates a financial object',async()=>{
  const mod=await import('../server/connection-providers.js') as any;assert.equal(typeof mod.verifyConnection,'function','read-only verification must exist');
  for(const provider of Object.keys(inputs)){
    const calls:{url:URL;init:RequestInit;body?:any}[]=[];
    const fetcher:HttpFetch=async(raw,init={})=>{
      const url=new URL(raw),body=init.body?JSON.parse(String(init.body).startsWith('{')?String(init.body):'{}'):undefined;calls.push({url,init,body});
      let data:any;
      if(body?.method==='getblockchaininfo')data={chain:provider==='liquid'?'liquidv1':'main',blocks:900000,headers:900000,bestblockhash:hash,initialblockdownload:false,verificationprogress:1};
      else if(body?.method==='getwalletinfo')data={private_keys_enabled:false,scanning:false,lastprocessedblock:{hash,height:900000}};
      else if(body?.method==='getaddressinfo')data={address:inputs[provider].address,iswatchonly:true,scriptPubKey:'0014'+'12'.repeat(20)};
      else if(url.pathname==='/v1/getinfo')data={chains:[{chain:'bitcoin',network:'mainnet'}],synced_to_chain:true,identity_pubkey:key};
      else if(url.pathname.endsWith('/ark-info'))data={network:'bitcoin',server_pubkey:key};
      else if(url.pathname.endsWith('/addresses/index/7'))data={address};
      else if(provider==='lightning-address'||provider==='lnurl')data={tag:'payRequest',minSendable:1000,maxSendable:100000000,callback:'https://receiver.example.com/callback?tag=payRequest',metadata:JSON.stringify([['text/plain','Fictional receiver'],['text/identifier','merchant@receiver.example.com']])};
      else if(provider==='stripe')data={id:'acct_fixture',country:'CA',charges_enabled:true};
      else if(provider==='paypal')data={access_token:'fictional-access',token_type:'Bearer',expires_in:3600};
      else if(provider==='revolut')data={id:inputs.revolut.locationId,type:'online',details:{domain:'ledger.example.com'}};
      else if(provider==='square')data={location:{id:'LOCATION123',merchant_id:'MERCHANT123',country:'CA',currency:'CAD',status:'ACTIVE',capabilities:['CREDIT_CARD_PROCESSING']}};
      else throw new Error('Unexpected fixture operation');
      return Response.json(body?.method?{id:body.id,result:data,error:null}:data);
    };
    const result=await mod.verifyConnection(normalized(provider),{...options,fetcher});
    assert.equal(result.status,['paypal','bank-instructions','static-crypto'].includes(provider)?'manual':'connected',provider);
    assert.deepEqual(result.methods,buildConnectionAdapter(normalized(provider),{...options,fetcher}).methods);
    for(const call of calls){
      if(call.body?.method)assert.ok(['getblockchaininfo','getwalletinfo','getaddressinfo'].includes(call.body.method));
      else if(provider==='paypal')assert.equal(call.url.pathname,'/v1/oauth2/token');
      else assert.equal(call.init.method??'GET','GET',provider);
    }
    assert.equal(calls.some(call=>/\/invoices|\/orders|\/checkout|\/payments|\/send|\/sign|\/next/.test(call.url.pathname)),false,provider);
  }
});
test('definitions expose only implemented receiving rails and strict mode/provider fields',()=>{
  assert.equal(CONNECTION_PROVIDERS.length,13);assert.equal(new Set(CONNECTION_PROVIDERS.map(row=>row.id)).size,13);
  for(const provider of Object.keys(inputs)){
    const adapter=buildConnectionAdapter(normalized(provider),options);assert.equal(adapter.id,options.id);assert.equal(adapter.mode,'live');assert.ok(adapter.methods.length);
    assert.throws(()=>normalizeConnection({provider,mode:'live',fields:{...inputs[provider],fetcher:'override'}},options));
  }
  assert.throws(()=>normalizeConnection({provider:'lnd',mode:'test',fields:inputs.lnd},options));
  for(const url of ['http://127.0.0.1:8332','https://[::ffff:127.0.0.1]','https://metadata.google.internal','https://node.example.com:8332'])assert.throws(()=>normalizeConnection({provider:'bitcoin-core',mode:'live',fields:{...inputs['bitcoin-core'],rpcUrl:url}},options));
  assert.throws(()=>normalizeConnection({provider:'static-crypto',mode:'live',fields:{...inputs['static-crypto'],network:'ethereum-sepolia'}},options));
});
test('bank instructions are payer-facing and always require independent confirmation',async()=>{
  const adapter=buildConnectionAdapter(normalized('bank-instructions'),options);
  const context={requestId:'fictional-request',idempotencyKey:'fictional-retry',mode:'live' as const,method:'interac' as const,amount:1234,currency:'CAD' as const,expectedAtomic:'1234',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
  const intent=await adapter.create(context);assert.equal(intent.instructions?.find(row=>row.label==='Receiving instructions')?.value,inputs['bank-instructions'].instructions);
  assert.equal((await adapter.check(context,intent)).status,'review');await assert.rejects(()=>adapter.create({...context,currency:'USD'}));
});
test('verification rejects mismatched account, chain, address and LNURL callback without leaking responses',async()=>{
  const {verifyConnection}=await import('../server/connection-providers.js') as any;
  for(const provider of ['stripe','bitcoin-core','lnd','bark','lnurl','lightning-address']){
    const fetcher:HttpFetch=async(_url,init)=>Response.json(init?.body?{id:JSON.parse(String(init.body)).id,result:{chain:'regtest'},error:null}:{id:'wrong',country:'CA',secret:'should-never-echo',tag:'payRequest',minSendable:1,maxSendable:2,callback:'https://127.0.0.1/',metadata:'[["text/plain","x"]]'});
    await assert.rejects(()=>verifyConnection(normalized(provider),{...options,fetcher}),error=>error instanceof Error&&!error.message.includes('should-never-echo')&&!error.message.includes('127.0.0.1'));
  }
});

test('hosted fiat redirects use the server-generated same-origin receiving page',async()=>{
  const seen:URLSearchParams[]=[];
  const fetcher:HttpFetch=async(url,init)=>{
    if(url.endsWith('/account'))return Response.json({id:'acct_fixture',country:'CA'});
    const form=new URLSearchParams(String(init?.body));seen.push(form);
    return Response.json({object:'checkout.session',id:'cs_live_fixture',mode:'payment',livemode:true,client_reference_id:'fictional-request',metadata:{receive_request:'fictional-request',receive_method:'card'},amount_total:1234,currency:'cad',url:'https://checkout.stripe.com/c/pay/cs_live_fixture'});
  };
  const context={requestId:'fictional-request',idempotencyKey:'fictional-retry',mode:'live' as const,method:'card' as const,amount:1234,currency:'CAD' as const,expectedAtomic:'1234',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),returnUrl:'https://ledger.example.com/receive/fictional-receive-token'};
  const adapter=buildConnectionAdapter(normalized('stripe'),{...options,fetcher});
  await adapter.create(context);
  assert.equal(seen[0].get('success_url'),context.returnUrl);
  await assert.rejects(()=>adapter.create({...context,returnUrl:'https://attacker.example.com/receive/fictional-receive-token'}));
  await assert.rejects(()=>adapter.create({...context,returnUrl:'https://ledger.example.com/login'}));
});
test('one overall verification deadline bounds all stages even if an internal transport ignores abort',async()=>{
  const {verifyConnection}=await import('../server/connection-providers.js') as any;
  let calls=0;const signals:AbortSignal[]=[];
  const fetcher:HttpFetch=async(_url,init)=>{
    calls++;signals.push(init!.signal!);const rpc=JSON.parse(String(init?.body));
    await new Promise(resolve=>setTimeout(resolve,20));
    return Response.json({id:rpc.id,error:null,result:rpc.method==='getblockchaininfo'?{chain:'main',blocks:900000,headers:900000,bestblockhash:hash,initialblockdownload:false,verificationprogress:1}:{private_keys_enabled:false,scanning:false,lastprocessedblock:{hash,height:900000}}});
  };
  await assert.rejects(()=>verifyConnection(normalized('watch-only'),{...options,fetcher,verificationTimeoutMs:30}),/verification unavailable/i);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(calls,2,'no address read begins after the total deadline');assert.equal(signals.every(signal=>signal.aborted),true);
  const start=Date.now();await assert.rejects(()=>verifyConnection(normalized('stripe'),{...options,fetcher:async()=>new Promise(()=>{}),verificationTimeoutMs:15}));assert.ok(Date.now()-start<300);
});
test('trusted insecure loopback public origins require an explicit fixture flag without relaxing provider endpoints',()=>{
  const bank={provider:'bank-instructions',mode:'live',fields:inputs['bank-instructions']};
  for(const publicOrigin of ['http://localhost:4333','http://127.0.0.1:4333','http://[::1]:4333']){
    assert.throws(()=>normalizeConnection(bank,{...options,publicOrigin}));
    assert.equal(normalizeConnection(bank,{...options,publicOrigin,allowInsecureLoopback:true} as any).provider,'bank-instructions');
  }
  for(const publicOrigin of ['http://attacker.example.com:4333','http://localhost.attacker.example.com:4333','http://localhost:4333/path','http://localhost:4333?query','http://localhost:4333#fragment','http://u:p@localhost:4333','http://127.1:4333'])assert.throws(()=>normalizeConnection(bank,{...options,publicOrigin,allowInsecureLoopback:true} as any));
  assert.throws(()=>normalizeConnection({provider:'bitcoin-core',mode:'live',fields:{...inputs['bitcoin-core'],rpcUrl:'http://127.0.0.1:8332'}},{...options,publicOrigin:'http://localhost:4333',allowInsecureLoopback:true} as any));
});
test('test Stripe callbacks may use only the explicitly configured loopback fixture origin',async()=>{
  const posts:URLSearchParams[]=[];
  const local={...options,publicOrigin:'http://localhost:4333',allowInsecureLoopback:true};
  const fetcher:HttpFetch=async(url,init)=>{
    if(url.endsWith('/account'))return Response.json({id:'acct_fixture',country:'CA'});
    posts.push(new URLSearchParams(String(init?.body)));
    return Response.json({object:'checkout.session',id:'cs_test_fixture',mode:'payment',livemode:false,client_reference_id:'fictional-request',metadata:{receive_request:'fictional-request',receive_method:'card'},amount_total:1234,currency:'cad',url:'https://checkout.stripe.com/c/pay/cs_test_fixture'});
  };
  const connection=normalizeConnection({provider:'stripe',mode:'test',fields:{...inputs.stripe,secretKey:'sk_test_fictional'}},local as any);
  const adapter=buildConnectionAdapter(connection,{...local,fetcher} as any);
  const context={requestId:'fictional-request',idempotencyKey:'fictional-key',method:'card' as const,amount:1234,currency:'CAD' as const,expectedAtomic:'1234',mode:'test' as const,createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),returnUrl:'http://localhost:4333/receive/fictional-receive-token'};
  await adapter.create(context);assert.equal(posts[0].get('success_url'),context.returnUrl);
  await assert.rejects(()=>adapter.create({...context,returnUrl:'http://127.0.0.1:4333/receive/fictional-receive-token'}));
  await assert.rejects(()=>adapter.create({...context,returnUrl:'http://attacker.example.com/receive/fictional-receive-token'}));
});
