// Controlled NIP-47 service; published scalars are test constants, not wallets.
import {randomBytes,createHash} from 'node:crypto';
import {finalizeEvent,getPublicKey,nip04,nip44,verifyEvent,type Event} from 'nostr-tools';
import * as bolt11 from 'bolt11';
import type {NwcTransport} from '../../server/nwc-transport.js';

export function fictionalNwcWallet(){
 const walletKey=Uint8Array.from(Buffer.from('0'.repeat(63)+'2','hex'));
 const clientSecret='0'.repeat(63)+'3',walletPubkey=getPublicKey(walletKey);
 const uri=`nostr+walletconnect://${walletPubkey}?relay=${encodeURIComponent('wss://relay.example.com')}&secret=${clientSecret}`;
 const calls:string[]=[],records=new Map<string,{invoice:string;payment_hash:string;amount:number;created_at:number;expires_at:number;preimage:string}>();
 let paid=false,offline=false,loseCreate=false;
 const transport:NwcTransport=async(_relay,event,peers)=>{
  if(offline)throw new Error('FICTIONAL_PRIVATE_PROVIDER_ERROR');
  if(!verifyEvent(event)||peers.walletPubkey!==walletPubkey||peers.clientPubkey!==event.pubkey)throw new Error('fixture peer binding');
  const mode=event.tags.find(t=>t[0]==='encryption')?.[1]??'nip04';
  const conversation=nip44.v2.utils.getConversationKey(walletKey,event.pubkey);
  const plain=mode==='nip44_v2'?nip44.v2.decrypt(event.content,conversation):await nip04.decrypt(walletKey,event.pubkey,event.content);
  const request=JSON.parse(plain);calls.push(request.method);
  let result:Record<string,unknown>;
  if(request.method==='get_info')result={alias:'Fictional wallet',pubkey:'0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798',network:'mainnet',methods:['get_info','make_invoice','lookup_invoice']};
  else if(request.method==='make_invoice'){
   const preimage=randomBytes(32).toString('hex'),payment_hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
   const created_at=Math.floor(Date.now()/1000),expiry=request.params.expiry??900;
   const invoice=bolt11.sign(bolt11.encode({network:{bech32:'bc',pubKeyHash:0,scriptHash:5,validWitnessVersions:[0,1]},timestamp:created_at,millisatoshis:String(request.params.amount),tags:[{tagName:'payment_hash',data:payment_hash},{tagName:'description',data:request.params.description??''},{tagName:'expire_time',data:expiry}]}),'0'.repeat(63)+'1').paymentRequest!;
   const record={invoice,payment_hash,amount:request.params.amount,created_at,expires_at:created_at+expiry,preimage};records.set(payment_hash,record);
   if(loseCreate)throw new Error('FICTIONAL_LOST_REPLY_AFTER_CREATION');
   const {preimage:_preimage,...unpaid}=record;result={...unpaid,type:'incoming',state:'pending'};
  }else if(request.method==='lookup_invoice'){
   const record=records.get(request.params.payment_hash);if(!record)throw new Error('fixture unknown original invoice');
   const {preimage,...unpaid}=record;result={...unpaid,type:'incoming',state:paid?'settled':'pending',...(paid?{preimage,settled_at:Math.floor(Date.now()/1000)}:{})};
  }else throw new Error('fixture forbids spending, signing, history and balance');
  const answer=JSON.stringify({result_type:request.method,result,error:null});
  return finalizeEvent({kind:23195,created_at:event.created_at,tags:[['p',event.pubkey],['e',event.id],['encryption',mode]],content:mode==='nip44_v2'?nip44.v2.encrypt(answer,conversation):await nip04.encrypt(walletKey,event.pubkey,answer)},walletKey);
 };
 transport.info=async()=>{
  if(offline)throw new Error('FICTIONAL_PRIVATE_PROVIDER_ERROR');
  return finalizeEvent({kind:13194,created_at:Math.floor(Date.now()/1000),tags:[['encryption','nip44_v2 nip04']],content:'get_info make_invoice lookup_invoice'},walletKey);
 };
 return {uri,clientSecret,walletPubkey,transport,calls,records,setPaid:(value:boolean)=>{paid=value;},setOffline:(value:boolean)=>{offline=value;},setLoseCreate:(value:boolean)=>{loseCreate=value;}};
}
