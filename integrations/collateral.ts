import type {HttpFetch} from './http.js';
import {inspectArk,type ArkConnectionConfig,type ArkSnapshot} from './ark-receiving.js';

export interface CollateralOutpoint {txid:string;vout:number;scriptPubKey:string;expectedSats?:number}
export interface CollateralConfig {
  rpcUrl:string;username?:string;password?:string;
  /** An already loaded watch wallet. No wallet import, load or seed access occurs. */
  wallet:string;outpoints:CollateralOutpoint[];
  minConfirmations?:number;maxTipAgeSeconds?:number;
  fetcher?:HttpFetch;now?:()=>Date;
  ark?:ArkConnectionConfig;
}
export interface CollateralSnapshot {
  asset:'BTC';network:'mainnet';observedAt:string;height:number;blockHash:string;totalSats:number;
  utxos:{txid:string;vout:number;valueSats:number;confirmations:number}[];
  control:'unverified';unencumbered:'unknown';lenderAcceptance:'unknown';
  ark?:ArkSnapshot;
}
const MAX_SATS=2_100_000_000_000_000;
const hex64=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v);
const integer=(v:unknown,max=MAX_SATS):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
function scriptHex(v:unknown):v is string{return typeof v==='string'&&/^(?:[0-9a-f]{2}){1,10000}$/.test(v);}
function sats(value:unknown){
  if(typeof value!=='number'||!Number.isFinite(value)||value<=0||value>21_000_000)throw new Error('Invalid collateral output value.');
  const decimal=value.toFixed(8);if(Number(decimal)!==value)throw new Error('Collateral value has fractional satoshis.');
  const amount=Number(decimal.replace('.',''));if(!integer(amount)||amount===0)throw new Error('Invalid collateral satoshi value.');return amount;
}
function settings(config:CollateralConfig){
  let endpoint:URL;try{endpoint=new URL(config.rpcUrl);}catch{throw new Error('Invalid collateral node endpoint.');}
  if(!['https:','http:'].includes(endpoint.protocol)||(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)&&endpoint.protocol!=='https:')||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/')throw new Error('Collateral node requires an HTTPS origin or loopback HTTP origin.');
  if(typeof config.wallet!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(config.wallet))throw new Error('A configured watch wallet is required.');
  const minConfirmations=config.minConfirmations??1,maxTipAge=config.maxTipAgeSeconds??7200;
  if(!integer(minConfirmations,100000)||minConfirmations<1||!integer(maxTipAge,86400)||maxTipAge<60)throw new Error('Invalid collateral confirmation or freshness policy.');
  if(!Array.isArray(config.outpoints)||config.outpoints.length<1||config.outpoints.length>100)throw new Error('Configure between one and 100 existing collateral outpoints.');
  const seen=new Set<string>(),outpoints:CollateralOutpoint[]=[];
  for(const row of config.outpoints){
    if(!object(row)||!hex64(row.txid)||!integer(row.vout,0xffffffff)||!scriptHex(row.scriptPubKey)||(row.expectedSats!==undefined&&(!integer(row.expectedSats)||row.expectedSats===0)))throw new Error('Invalid configured collateral outpoint.');
    const key=`${row.txid}:${row.vout}`;if(seen.has(key))throw new Error('Duplicate configured collateral outpoint.');seen.add(key);
    outpoints.push({txid:row.txid,vout:row.vout,scriptPubKey:row.scriptPubKey,expectedSats:row.expectedSats});
  }
  const headers:Record<string,string>={'Content-Type':'application/json',Accept:'application/json'};
  if((config.username===undefined)!==(config.password===undefined))throw new Error('Both collateral RPC authentication fields are required.');
  if(config.username!==undefined){
    if(typeof config.username!=='string'||typeof config.password!=='string'||config.username.length<1||config.username.length>256||config.password.length<1||config.password.length>1024||/[\r\n:]/.test(config.username)||/[\r\n]/.test(config.password))throw new Error('Invalid collateral RPC authentication.');
    headers.Authorization=`Basic ${Buffer.from(config.username+':'+config.password).toString('base64')}`;
  }else if(!['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname))throw new Error('Remote collateral nodes require RPC authentication.');
  const now=(config.now??(()=>new Date()))();if(!(now instanceof Date)||!Number.isFinite(now.getTime()))throw new Error('Invalid collateral observation time.');
  return {origin:endpoint.origin,wallet:config.wallet,outpoints,minConfirmations,maxTipAge,headers,fetcher:config.fetcher??fetch,now};
}
type ChainState={height:number;hash:string};
function chain(value:unknown,config:ReturnType<typeof settings>):ChainState{
  if(!object(value)||value.chain!=='main'||!integer(value.blocks,0xffffffff)||value.blocks<1||value.headers!==value.blocks||!hex64(value.bestblockhash)||value.initialblockdownload!==false||typeof value.verificationprogress!=='number'||!Number.isFinite(value.verificationprogress)||value.verificationprogress<0.999||value.verificationprogress>1||!integer(value.time)||value.time<config.now.getTime()/1000-config.maxTipAge||value.time>config.now.getTime()/1000+300||!(value.warnings===''||(Array.isArray(value.warnings)&&value.warnings.length===0)))throw new Error('Collateral source must be healthy, synced and recent on Bitcoin mainnet.');
  return {height:value.blocks,hash:value.bestblockhash};
}

/** Chain observation only. It establishes neither control nor absence of encumbrances. */
export async function inspectCollateral(config:CollateralConfig):Promise<CollateralSnapshot>{
  const conf=settings(config);let sequence=0;
  async function rpc(method:'getblockchaininfo'|'listunspent'|'gettxout',params:unknown[]=[]):Promise<unknown>{
    // No external caller can choose a method or an arbitrary URL.
    if(!['getblockchaininfo','listunspent','gettxout'].includes(method))throw new Error('Collateral RPC operation is not allowed.');
    const id=`collateral-${++sequence}`;
    try{
      const path=method==='listunspent'?`/wallet/${encodeURIComponent(conf.wallet)}`:'/';
      const response=await conf.fetcher(conf.origin+path,{method:'POST',headers:conf.headers,body:JSON.stringify({jsonrpc:'2.0',id,method,params}),redirect:'error',signal:AbortSignal.timeout(10_000)});
      if(!response.ok)throw new Error();
      const reader=response.body?.getReader();if(!reader)throw new Error();
      const chunks:Uint8Array[]=[];let length=0;
      try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>1_048_576)throw new Error();chunks.push(part.value);}}
      catch(error){await reader.cancel().catch(()=>{});throw error;}
      const envelope:unknown=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!object(envelope)||envelope.jsonrpc!=='2.0'||envelope.id!==id||envelope.error!=null||!Object.hasOwn(envelope,'result'))throw new Error();
      return envelope.result;
    }catch{throw new Error('Collateral node read unavailable or invalid; no collateral was verified.');}
  }
  const before=chain(await rpc('getblockchaininfo'),conf);
  const list=await rpc('listunspent',[conf.minConfirmations,9999999,[],false]);
  if(!Array.isArray(list)||list.length>10000)throw new Error('Invalid or excessive watch-wallet UTXO response.');
  const listed=new Map<string,Record<string,unknown>>();
  for(const row of list){
    if(!object(row)||!hex64(row.txid)||!integer(row.vout,0xffffffff))throw new Error('Invalid watch-wallet outpoint.');
    const key=`${row.txid}:${row.vout}`;if(listed.has(key))throw new Error('Duplicate watch-wallet outpoint.');listed.set(key,row);
  }
  const utxos:CollateralSnapshot['utxos']=[];let totalSats=0;
  for(const expected of conf.outpoints){
    const row=listed.get(`${expected.txid}:${expected.vout}`);
    if(!row||row.scriptPubKey!==expected.scriptPubKey||row.safe!==true||!integer(row.confirmations,0xffffffff)||row.confirmations<conf.minConfirmations||row.confirmations>before.height+1)throw new Error('Configured collateral is missing, unsafe or does not match its watch-wallet binding.');
    const valueSats=sats(row.amount);
    if(expected.expectedSats!==undefined&&valueSats!==expected.expectedSats)throw new Error('Collateral output value did not match its configured binding.');
    const current=await rpc('gettxout',[expected.txid,expected.vout,true]);
    if(!object(current)||current.bestblock!==before.hash||!integer(current.confirmations,0xffffffff)||current.confirmations!==row.confirmations||current.confirmations<conf.minConfirmations||!object(current.scriptPubKey)||current.scriptPubKey.hex!==expected.scriptPubKey||sats(current.value)!==valueSats||typeof current.coinbase!=='boolean'||(current.coinbase&&current.confirmations<101))throw new Error('Collateral outpoint is spent, immature or inconsistent with the observed chain.');
    totalSats+=valueSats;if(!integer(totalSats))throw new Error('Collateral total exceeds the Bitcoin supply.');
    utxos.push({txid:expected.txid,vout:expected.vout,valueSats,confirmations:current.confirmations});
  }
  const after=chain(await rpc('getblockchaininfo'),conf);
  if(before.height!==after.height||before.hash!==after.hash)throw new Error('Collateral chain tip changed during inspection; retry the read.');
  const snapshot:CollateralSnapshot={asset:'BTC',network:'mainnet',observedAt:conf.now.toISOString(),height:after.height,blockHash:after.hash,totalSats,utxos,control:'unverified',unencumbered:'unknown',lenderAcceptance:'unknown'};
  if(config.ark)snapshot.ark=await inspectArk(config.ark);
  return snapshot;
}
