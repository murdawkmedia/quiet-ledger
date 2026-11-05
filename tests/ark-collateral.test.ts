import test from 'node:test';
import assert from 'node:assert/strict';
import {createArkAdapter, inspectArk, type ArkAdapterConfig} from '../integrations/ark-receiving.js';
import {inspectCollateral, type CollateralConfig} from '../integrations/collateral.js';
import type {ReceivingContext} from '../shared/receiving.js';

// BOAT-001 example policy with a fictional server hash, not an owned wallet.
const address='ark1pghdlurfzqqpjy9akejayl2vvcse6he97rn40g84xrlvrlnhayuuyefrp9nse2yspqqu22rk7';
const testAddress='tark1pghdlurfzqqpjy9akejayl2vvcse6he97rn40g84xrlvrlnhayuuyefrp9nse2yspqqcw5wkh';
const serverKey='02'+'22'.repeat(32);
const now=new Date('2026-11-04T12:00:00Z');
const context:ReceivingContext={requestId:'fixture-request',method:'ark',amount:123,currency:'CAD',expectedAtomic:'123456',idempotencyKey:'fixture-retry',createdAt:'2026-11-04T11:55:00Z',expiresAt:'2026-11-04T13:00:00Z',mode:'live'};
const txid='11'.repeat(32),blockHash='aa'.repeat(32),script='0014'+'33'.repeat(20);
const info=()=>({chain:'main',blocks:870001,headers:870001,bestblockhash:blockHash,time:Math.floor(now.getTime()/1000)-300,verificationprogress:0.99999999,initialblockdownload:false,warnings:[]});
const row=()=>({txid,vout:1,scriptPubKey:script,amount:0.00123456,confirmations:6,spendable:false,solvable:true,safe:true});
const output=()=>({bestblock:blockHash,confirmations:6,value:0.00123456,scriptPubKey:{hex:script},coinbase:false});
function coreFixture(overrides:Record<string,unknown>={}){
  const calls:{url:string;init:RequestInit;body:any}[]=[];
  const config:CollateralConfig={rpcUrl:'http://127.0.0.1:8332',wallet:'fixture-watch-wallet',outpoints:[{txid,vout:1,scriptPubKey:script,expectedSats:123456}],now:()=>now,fetcher:async(url,init)=>{
    const body=JSON.parse(String(init?.body));calls.push({url,init:init!,body});
    const value=Object.hasOwn(overrides,body.method)?overrides[body.method]:body.method==='getblockchaininfo'?info():body.method==='listunspent'?[row()]:output();
    return Response.json({jsonrpc:'2.0',id:body.id,result:typeof value==='function'?value(calls):value,error:null});
  }};
  return {config,calls};
}
function arkFixture(overrides:Record<string,unknown>={}){
  const calls:{url:string;init:RequestInit}[]=[];
  const config:ArkAdapterConfig={baseUrl:'http://127.0.0.1:3535',expectedServerPubkey:serverKey,addressIndex:7,expectedAddress:address,now:()=>now,fetcher:async(url,init)=>{
    calls.push({url,init:init!}); const path=new URL(url).pathname;
    return Response.json(Object.hasOwn(overrides,path)?overrides[path]:path.endsWith('/ark-info')?{network:'bitcoin',server_pubkey:serverKey}:path.includes('/addresses/')?{address}:path.endsWith('/tip')?{tip_height:870001}:path.endsWith('/balance')?{spendable_sat:100,needs_refresh_sat:0,pending_lightning_send_sat:0,claimable_lightning_receive_sat:0,pending_in_round_sat:0,pending_board_sat:0,pending_arkoor_send_sat:0,pending_offboard_sat:0,pending_exit_sat:0}:[]);
  }};
  return {config,calls};
}

test('Ark indexed receiving is mainnet by default and durable across adapter restarts',async()=>{
  const {config,calls}=arkFixture();
  const first=await createArkAdapter(config).create(context);
  const retry=await createArkAdapter(config).create(context);
  assert.deepEqual(retry,first);assert.equal(first.request,address);assert.equal(first.asset,'BTC');assert.equal(first.network,'mainnet');
  const other=await createArkAdapter({...config,id:'another-adapter'}).create({...context,requestId:'other'});
  assert.equal(first.allocationKey,other.allocationKey,'same address must collide globally across adapters/invoices');
  assert.notEqual(first.providerId,other.providerId);
  assert.equal(calls.every(c=>c.init.method==='GET'&&c.init.redirect==='error'),true);
  assert.equal(calls.some(c=>/next|send|sync|mnemonic|sign|refresh|offboard/.test(c.url)),false);
});
test('Ark VTXO/balance evidence and payer transaction hints never become an attributed receipt',async()=>{
  const {config,calls}=arkFixture({'/api/v1/wallet/vtxos':[{id:txid+':1',amount_sat:123456,policy_type:'pubkey',user_pubkey:serverKey,server_pubkey:serverKey,expiry_height:870100,exit_delta:10,chain_anchor:txid+':0',state:{type:'spendable'}}]});
  const adapter=createArkAdapter(config),intent=await adapter.create(context);
  const seen=await adapter.check(context,intent,{transactionId:txid+':1'});
  assert.equal(seen.status,'review');assert.match(seen.reason!,/attribut|invoice|review/i);
  assert.equal(calls.every(c=>!c.url.includes(txid)),true,'payer hint is never interpolated into RPC');
});
test('Ark rejects wrong networks, changed pinned address, malformed responses and insecure endpoints',async()=>{
  for(const override of [{'/api/v1/wallet/ark-info':{network:'signet',server_pubkey:serverKey}},{'/api/v1/wallet/ark-info':{}},{'/api/v1/wallet/addresses/index/7':{address:address+'x'}}]){
    await assert.rejects(()=>createArkAdapter(arkFixture(override).config).create(context));
  }
  const base=arkFixture().config;
  for(const baseUrl of ['http://wallet.example','https://user:password@wallet.example','https://wallet.example/private?token=bad','ftp://wallet.example'])assert.throws(()=>createArkAdapter({...base,baseUrl}));
  assert.throws(()=>createArkAdapter({...base,expectedAddress:address.slice(0,-1)+'q'}));
  assert.throws(()=>createArkAdapter({...base,addressIndex:-1}));
});
test('Ark explicit test mode cannot be used with live context, expired requests or altered intent bindings',async()=>{
  const {config}=arkFixture();
  const adapter=createArkAdapter(config),intent=await adapter.create(context);
  for(const changed of [{...context,mode:'test' as const},{...context,expiresAt:'2026-11-04T11:00:00Z'},{...context,expectedAtomic:'1'}])await assert.rejects(()=>adapter.check(changed,intent));
  await assert.rejects(()=>adapter.check(context,{...intent,request:'ark1different'}));
  assert.throws(()=>createArkAdapter({...config,network:'signet'}),'test network must explicitly request test mode and matching address');
});
test('Ark rejects a valid address whose encoded server identifier differs from the pinned server',()=>{
  const {config}=arkFixture();
  assert.throws(()=>createArkAdapter({...config,expectedServerPubkey:'03'+'44'.repeat(32)}));
});
test('Ark signet receiving requires explicit test mode and a test network address',async()=>{
  const {config}=arkFixture({'/api/v1/wallet/ark-info':{network:'signet',server_pubkey:serverKey},'/api/v1/wallet/addresses/index/7':{address:testAddress}});
  const adapter=createArkAdapter({...config,network:'signet',mode:'test',expectedAddress:testAddress});
  const intent=await adapter.create({...context,mode:'test'});
  assert.equal(adapter.mode,'test');assert.equal(intent.network,'signet');assert.equal(intent.request,testAddress);
});
test('Ark upstream errors are bounded and sanitized',async()=>{
  const fixture=arkFixture();fixture.config.fetcher=async()=>{throw new Error('fixture-secret account data');};
  await assert.rejects(()=>createArkAdapter(fixture.config).create(context),(e:Error)=>!e.message.includes('fixture-secret'));
});
test('Ark rejects malformed VTXO observations without accepting spent or expired virtual sats as payment',async()=>{
  for(const value of [{},[{id:'bad'}],[{id:txid+':0',amount_sat:-1}]]){
    const {config}=arkFixture({'/api/v1/wallet/vtxos':value});const adapter=createArkAdapter(config);
    const intent=await adapter.create(context);await assert.rejects(()=>adapter.check(context,intent));
  }
});
test('Ark status preserves only bounded satoshi categories and pins network/server identity',async()=>{
  const {config}=arkFixture();const snapshot=await inspectArk(config);
  assert.equal(snapshot.network,'mainnet');assert.equal(snapshot.spendableSats,100);assert.equal(snapshot.onchainCollateral,false);assert.equal(snapshot.freshness,'unverified');
  for(const override of [{'/api/v1/wallet/ark-info':{network:'bitcoin',server_pubkey:'03'+'22'.repeat(32)}},{'/api/v1/wallet/balance':{spendable_sat:1}},{'/api/v1/bitcoin/tip':{height:100}}])await assert.rejects(()=>inspectArk(arkFixture(override).config));
});
test('Ark and collateral reject excessive upstream response bodies and redact upstream errors',async()=>{
  const ark=arkFixture();ark.config.fetcher=async()=>new Response('fixture-secret'.repeat(100000));
  await assert.rejects(()=>inspectArk(ark.config),(e:Error)=>!e.message.includes('fixture-secret'));
  const core=coreFixture();core.config.fetcher=async()=>new Response('fixture-secret'.repeat(100000));
  await assert.rejects(()=>inspectCollateral(core.config),(e:Error)=>!e.message.includes('fixture-secret'));
});
test('TLS authenticated transports keep credentials in headers and out of snapshots',async()=>{
  const ark=arkFixture();const token=Buffer.from([0,...Array(32).fill(42)]).toString('base64url');
  const arkResult=await inspectArk({...ark.config,baseUrl:'https://bark.example',token});
  assert.equal(new Headers(ark.calls[0].init.headers).get('Authorization'),'Bearer '+token);
  assert.equal(JSON.stringify(arkResult).includes(token),false);
  const core=coreFixture();const coreResult=await inspectCollateral({...core.config,rpcUrl:'https://node.example',username:'fixture-user',password:'fixture-password'});
  assert.equal(new Headers(core.calls[0].init.headers).get('Authorization'),'Basic '+Buffer.from('fixture-user:fixture-password').toString('base64'));
  assert.equal(JSON.stringify(coreResult).includes('fixture-password'),false);
});

test('collateral binds selected UTXOs to stable healthy mainnet chain state using only three read RPCs',async()=>{
  const {config,calls}=coreFixture();const result=await inspectCollateral(config);
  assert.equal(result.asset,'BTC');assert.equal(result.network,'mainnet');assert.equal(result.totalSats,123456);
  assert.equal(result.height,870001);assert.equal(result.blockHash,blockHash);assert.equal(result.observedAt,now.toISOString());
  assert.equal(result.control,'unverified');assert.equal(result.unencumbered,'unknown');assert.equal(result.lenderAcceptance,'unknown');
  assert.deepEqual(result.utxos,[{txid,vout:1,valueSats:123456,confirmations:6}]);
  assert.deepEqual([...new Set(calls.map(c=>c.body.method))].sort(),['getblockchaininfo','gettxout','listunspent']);
  assert.deepEqual(calls.find(c=>c.body.method==='gettxout')!.body.params,[txid,1,true]);
  assert.match(calls.find(c=>c.body.method==='listunspent')!.url,/\/wallet\/fixture-watch-wallet$/);
  assert.equal(calls.every(c=>c.init.method==='POST'&&c.init.redirect==='error'),true);
  assert.equal(JSON.stringify(result).includes('fixture-watch-wallet'),false);
});
test('collateral rejects duplicate/malformed configuration before making requests',async()=>{
  const {config,calls}=coreFixture();
  for(const outpoints of [[],[config.outpoints[0],config.outpoints[0]],[{...config.outpoints[0],txid:'not-a-txid'}],[{...config.outpoints[0],scriptPubKey:'zz'}],[{...config.outpoints[0],vout:-1}]])await assert.rejects(()=>inspectCollateral({...config,outpoints}));
  await assert.rejects(()=>inspectCollateral({...config,rpcUrl:'http://node.example:8332'}));
  assert.equal(calls.length,0);
});
test('collateral rejects unsynced, stale, wrong-network and unhealthy nodes before querying wallet',async()=>{
  for(const change of [{chain:'signet'},{initialblockdownload:true},{headers:870002},{verificationprogress:0.5},{time:Math.floor(now.getTime()/1000)-86400},{time:Math.floor(now.getTime()/1000)+7200},{warnings:['fork detected']},{bestblockhash:'bad'}]){
    const {config,calls}=coreFixture({getblockchaininfo:{...info(),...change}});
    await assert.rejects(()=>inspectCollateral(config));assert.equal(calls.length,1);
  }
});
test('collateral rejects spent outputs, duplicates, wrong scripts, values and confirmations',async()=>{
  const changes=[{gettxout:null},{listunspent:[row(),row()]},{listunspent:[{...row(),scriptPubKey:'0014'+'44'.repeat(20)}]},{listunspent:[{...row(),amount:0.00123457}]},{gettxout:{...output(),value:0.00123455}},{gettxout:{...output(),scriptPubKey:{hex:'0014'+'55'.repeat(20)}}},{gettxout:{...output(),confirmations:0}},{gettxout:{...output(),coinbase:true}},{gettxout:{...output(),bestblock:'bb'.repeat(32)}},{listunspent:[{...row(),safe:false}]},{listunspent:[{...row(),amount:0.000000001}]}];
  for(const change of changes)await assert.rejects(()=>inspectCollateral(coreFixture(change).config));
});
test('collateral rejects tip movement during inspection and RPC envelope confusion',async()=>{
  let reads=0;
  const moved=coreFixture({getblockchaininfo:()=>++reads===1?info():{...info(),blocks:870002,headers:870002,bestblockhash:'bb'.repeat(32)}});
  await assert.rejects(()=>inspectCollateral(moved.config));
  for(const envelope of [{id:'wrong',result:info(),error:null},{id:'collateral-1',result:info(),error:{code:-1,message:'fixture-secret'}},{}]){
    const {config}=coreFixture();config.fetcher=async()=>Response.json(envelope);
    await assert.rejects(()=>inspectCollateral(config),(e:Error)=>!e.message.includes('fixture-secret'));
  }
});
test('collateral rejects a response that changes JSON-RPC version',async()=>{
  const core=coreFixture(),fetcher=core.config.fetcher!;
  core.config.fetcher=async(url,init)=>{const result=await (await fetcher(url,init)).json();return Response.json({...result,jsonrpc:'1.0'});};
  await assert.rejects(()=>inspectCollateral(core.config));assert.equal(core.calls.length,1);
});
test('collateral rejects impossible confirmation counts',async()=>{
  await assert.rejects(()=>inspectCollateral(coreFixture({listunspent:[{...row(),confirmations:870003}],gettxout:{...output(),confirmations:870003}}).config));
});
test('collateral keeps optional Bark virtual sats separate from confirmed chain collateral',async()=>{
  const core=coreFixture(),ark=arkFixture();
  const result=await inspectCollateral({...core.config,ark:ark.config});
  assert.equal(result.totalSats,123456);assert.equal(result.ark?.kind,'virtual-vtxo-balance');assert.equal(result.ark?.spendableSats,100);
  assert.equal(result.ark?.onchainCollateral,false);assert.equal(result.ark?.freshness,'unverified');
  assert.equal(ark.calls.every(c=>c.init.method==='GET'),true);
});
