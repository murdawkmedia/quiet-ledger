import {createHash} from 'node:crypto';
import type {HttpFetch} from './http.js';
import {minorAmount} from './http.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent} from '../shared/receiving.js';

export type ArkNetwork='mainnet'|'signet'|'regtest';
export interface ArkConnectionConfig {
  baseUrl:string;
  /** barkd tokens grant full wallet authority. Keep this outside application source. */
  token?:string;
  expectedServerPubkey:string;
  network?:ArkNetwork;
  mode?:'live'|'test';
  fetcher?:HttpFetch;
  now?:()=>Date;
}
export interface ArkAdapterConfig extends ArkConnectionConfig {
  id?:string;
  /** Previously generated, dedicated receiving index; this adapter never allocates a new key. */
  addressIndex:number;
  expectedAddress:string;
}
export interface ArkSnapshot {
  network:ArkNetwork;observedAt:string;serverPubkey:string;tipHeight:number;
  kind:'virtual-vtxo-balance';spendableSats:number;
  categories:Record<string,number>;
  freshness:'unverified';onchainCollateral:false;
}
const MAX_SATS=2_100_000_000_000_000;
const BALANCE_FIELDS=['spendable_sat','needs_refresh_sat','pending_lightning_send_sat','claimable_lightning_receive_sat','pending_in_round_sat','pending_board_sat','pending_arkoor_send_sat','pending_offboard_sat','pending_exit_sat'] as const;
const pubkey=(v:unknown):v is string=>typeof v==='string'&&/^(02|03)[0-9a-f]{64}$/.test(v);
const integer=(v:unknown,max=MAX_SATS):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<=max;
const object=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');

function connection(config:ArkConnectionConfig){
  let url:URL;try{url=new URL(config.baseUrl);}catch{throw new Error('Invalid Bark endpoint.');}
  const loopback=['127.0.0.1','localhost','[::1]'].includes(url.hostname);
  if(!['https:','http:'].includes(url.protocol)||(!loopback&&url.protocol!=='https:')||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('Bark requires an HTTPS origin or loopback HTTP origin.');
  const network=config.network??'mainnet',mode=config.mode??'live';
  if(!['mainnet','signet','regtest'].includes(network)||!['live','test'].includes(mode)||(network==='mainnet')!==(mode==='live'))throw new Error('Bark network and live/test mode must match explicitly.');
  if(!pubkey(config.expectedServerPubkey))throw new Error('A pinned Bark server public key is required.');
  const token=config.token;
  if(token!==undefined&&(!/^[A-Za-z0-9_-]{44}$/.test(token)||Buffer.from(token,'base64url').length!==33||Buffer.from(token,'base64url')[0]!==0))throw new Error('Invalid Bark bearer token.');
  if(!loopback&&!token)throw new Error('Remote Bark connections require a bearer token.');
  const headers:Record<string,string>={Accept:'application/json'};
  if(token)headers.Authorization=`Bearer ${token}`;
  return {origin:url.origin,network,mode,expectedServerPubkey:config.expectedServerPubkey,headers,fetcher:config.fetcher??fetch,now:config.now??(()=>new Date())};
}

// The transport is private: callers cannot supply a path or HTTP verb.
async function read(config:ReturnType<typeof connection>,path:string):Promise<unknown>{
  if(!['/api/v1/wallet/ark-info','/api/v1/wallet/balance','/api/v1/wallet/vtxos','/api/v1/bitcoin/tip'].includes(path)&&!/^\/api\/v1\/wallet\/addresses\/index\/\d+$/.test(path))throw new Error('Bark operation is not allowed.');
  try{
    const response=await config.fetcher(config.origin+path,{method:'GET',headers:config.headers,redirect:'error',signal:AbortSignal.timeout(10_000)});
    if(!response.ok)throw new Error();
    const reader=response.body?.getReader();if(!reader)throw new Error();
    const chunks:Uint8Array[]=[];let length=0;
    try{while(true){const part=await reader.read();if(part.done)break;length+=part.value.length;if(length>524288)throw new Error();chunks.push(part.value);}}
    catch(error){await reader.cancel().catch(()=>{});throw error;}
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  }catch{throw new Error('Bark read unavailable or invalid; no receipt was verified.');}
}
async function server(config:ReturnType<typeof connection>){
  const value=await read(config,'/api/v1/wallet/ark-info');
  const expectedNetwork=config.network==='mainnet'?'bitcoin':config.network;
  if(!object(value)||value.network!==expectedNetwork||value.server_pubkey!==config.expectedServerPubkey)throw new Error('Bark network or pinned server identity did not match.');
  return config.expectedServerPubkey;
}
function observedAt(config:ReturnType<typeof connection>){
  const date=config.now();if(!(date instanceof Date)||!Number.isFinite(date.getTime()))throw new Error('Invalid observation time.');return date.toISOString();
}

/** An observation of barkd local state, never an on-chain collateral proof. */
export async function inspectArk(config:ArkConnectionConfig):Promise<ArkSnapshot>{
  const conn=connection(config),serverPubkey=await server(conn);
  const balance=await read(conn,'/api/v1/wallet/balance'),tip=await read(conn,'/api/v1/bitcoin/tip');
  if(!object(balance)||!object(tip)||!integer(tip.tip_height,0xffffffff))throw new Error('Invalid Bark balance or chain height.');
  const categories:Record<string,number>={};let total=0;
  for(const field of BALANCE_FIELDS){const value=balance[field];if(!integer(value))throw new Error('Invalid Bark satoshi balance.');categories[field]=value;total+=value;}
  if(!integer(total))throw new Error('Invalid Bark balance total.');
  return {network:conn.network,observedAt:observedAt(conn),serverPubkey,tipHeight:tip.tip_height,kind:'virtual-vtxo-balance',spendableSats:categories.spendable_sat,categories,freshness:'unverified',onchainCollateral:false};
}

function validateAddress(address:string,network:ArkNetwork,serverPubkey:string){
  if(typeof address!=='string'||address.length<40||address.length>2048||address!==address.toLowerCase())throw new Error('Invalid pinned Bark address.');
  const prefix=network==='mainnet'?'ark':'tark',separator=address.lastIndexOf('1');
  if(address.slice(0,separator)!==prefix)throw new Error('Bark address does not match the selected network.');
  const alphabet='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const data=[...address.slice(separator+1)].map(c=>alphabet.indexOf(c));
  if(data.length<7||data.some(v=>v<0)||data[0]!==1)throw new Error('Only a valid Bark version 1 address is supported.');
  const hrp=[...[...prefix].map(c=>c.charCodeAt(0)>>5),0,...[...prefix].map(c=>c.charCodeAt(0)&31)];
  let chk=1;const generators=[0x3b6a57b2,0x26508e6d,0x1ea119fa,0x3d4233dd,0x2a1462b3];
  for(const value of [...hrp,...data]){const high=chk>>>25;chk=((chk&0x1ffffff)<<5)^value;for(let i=0;i<5;i++)if((high>>>i)&1)chk^=generators[i];}
  if((chk>>>0)!==0x2bc830a3)throw new Error('Invalid Bark address checksum.');
  const payload:number[]=[];let bits=0,carry=0;
  for(const value of data.slice(1,-6)){carry=(carry<<5)|value;bits+=5;if(bits>=8){bits-=8;payload.push((carry>>>bits)&255);}}
  if(bits>=5||((carry<<(8-bits))&255)!==0||payload.length<6)throw new Error('Invalid Bark address payload.');
  const encodedServer=Buffer.from(payload.slice(0,4)).toString('hex');
  if(encodedServer!==createHash('sha256').update(Buffer.from(serverPubkey,'hex')).digest('hex').slice(0,8))throw new Error('Bark address does not match the pinned Ark server.');
}
function contextBinding(context:ReceivingContext,conn:ReturnType<typeof connection>){
  minorAmount(context.amount);
  const atomic=context.expectedAtomic;
  const created=Date.parse(context.createdAt),expires=Date.parse(context.expiresAt),now=conn.now().getTime();
  if(context.method!=='ark'||context.mode!==conn.mode||!['CAD','USD','EUR','GBP','KRW','SAT'].includes(context.currency)||typeof context.requestId!=='string'||!/^[A-Za-z0-9_-]{1,192}$/.test(context.requestId)||typeof context.idempotencyKey!=='string'||context.idempotencyKey.length<1||context.idempotencyKey.length>192||typeof atomic!=='string'||!/^[1-9]\d{0,15}$/.test(atomic)||BigInt(atomic)>BigInt(MAX_SATS)||!Number.isFinite(created)||!Number.isFinite(expires)||!Number.isFinite(now)||created>now+60_000||expires<=created||now>=expires)throw new Error('Invalid, expired or mismatched Bark receive context.');
  return digest(JSON.stringify([context.requestId,context.method,context.amount,context.currency,atomic,context.idempotencyKey,context.createdAt,context.expiresAt,context.mode]));
}
function validateVtxos(value:unknown,expectedServer:string){
  if(!Array.isArray(value)||value.length>1000)throw new Error('Invalid or excessive Bark VTXO observation.');
  const ids=new Set<string>();
  for(const vtxo of value){
    if(!object(vtxo)||typeof vtxo.id!=='string'||!/^[0-9a-f]{64}:\d{1,10}$/.test(vtxo.id)||ids.has(vtxo.id)||!integer(vtxo.amount_sat)||!integer(vtxo.expiry_height,0xffffffff)||vtxo.server_pubkey!==expectedServer||!pubkey(vtxo.user_pubkey)||!object(vtxo.state)||!['spendable','spent','exited','locked'].includes(String(vtxo.state.type)))throw new Error('Invalid Bark VTXO observation.');
    ids.add(vtxo.id);
  }
}

export function createArkAdapter(config:ArkAdapterConfig):ReceivingAdapter{
  const conn=connection(config),index=config.addressIndex,address=config.expectedAddress,id=config.id??'bark';
  if(!integer(index,0x7fffffff)||!/^[A-Za-z0-9_-]{1,96}$/.test(id))throw new Error('Invalid Bark adapter identifier or derivation index.');
  validateAddress(address,conn.network,conn.expectedServerPubkey);
  // Based on the destination alone so aliases and daemon URLs cannot defeat parent uniqueness.
  const allocationKey=`ark:${conn.network}:${digest(address)}`;
  const providerId=(binding:string)=>`ark:${digest(address+':'+binding)}`;
  const addressRead=async()=>{await server(conn);const value=await read(conn,`/api/v1/wallet/addresses/index/${index}`);if(!object(value)||value.address!==address)throw new Error('Bark indexed address did not match its pinned allocation.');};
  return {
    id,methods:['ark'],mode:conn.mode,creationRetrySafe:true,
    async create(context){
      const binding=contextBinding(context,conn);await addressRead();
      return {providerId:providerId(binding),request:address,network:conn.network,asset:'BTC',allocationKey,instructions:[{label:'Amount in satoshis',value:context.expectedAtomic},{label:'Verification',value:'Owner review required; VTXO balance is not an invoice receipt.'}],opaque:{contextBinding:binding,addressIndex:index}};
    },
    async check(context,intent){
      const binding=contextBinding(context,conn);
      if(intent.providerId!==providerId(binding)||intent.request!==address||intent.network!==conn.network||intent.asset!=='BTC'||intent.allocationKey!==allocationKey||intent.opaque?.contextBinding!==binding||intent.opaque?.addressIndex!==index)throw new Error('Bark intent does not match the saved receiving request.');
      await addressRead();validateVtxos(await read(conn,'/api/v1/wallet/vtxos'),conn.expectedServerPubkey);
      // The allowlisted VTXO schema has no invoice/address/time binding. A matching
      // amount, pubkey, new VTXO, balance delta or payer hint cannot prove this invoice.
      return {status:'review',reason:'Bark VTXO observations do not establish invoice attribution. Owner review is required; no receipt was issued.'};
    },
  };
}
