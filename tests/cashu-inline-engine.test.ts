import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as bolt11 from 'bolt11';
import * as sdk from '@cashu/cashu-ts-browser';
import {prepareCashuMelt,executeCashuMelt,recoverCashuMelt,invoiceCashuAmount} from '../client/cashu-melt-engine.js';
const mint='https://mint.minibits.cash/Bitcoin',time=1794952800000;
const preimage='11'.repeat(32),paymentHash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
test('separate NUT02 metadata authenticates fee-bearing keysets with minimal keys DTOs',async()=>{
 const f=fixture({fee:501});
 const request:sdk.RequestFn=async<T>(args:sdk.RequestOptions)=>{
  const value=await f.request<any>(args);
  return (args.endpoint.includes('/v1/keys/')?{keysets:value.keysets.map((k:any)=>({id:k.id,unit:k.unit,keys:k.keys}))}:value) as T;
 };
 const prepared=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:3,request,now:()=>time});
 assert.equal(prepared.inputFeeSats,2);assert.equal(prepared.maxDebitSats,4);assert.equal(f.calls.filter(x=>x.endsWith('/v1/melt/bolt11')).length,0);
});
function invoice(amount='1000'){return bolt11.sign(bolt11.encode({millisatoshis:amount,timestamp:time/1000,tags:[{tagName:'payment_hash',data:paymentHash},{tagName:'description',data:'Fictional controlled Cashu test'},{tagName:'expire_time',data:600}]}),'0'.repeat(63)+'1').paymentRequest!;}
function fixture(options:{lost?:boolean;badChange?:boolean;fee?:number;pending?:boolean}={}){
 const keyBytes=Uint8Array.from(Buffer.from('0'.repeat(63)+'2','hex')),pub=Buffer.from(sdk.getPubKeyFromPrivKey(keyBytes)).toString('hex');
 const keys=Object.fromEntries([1,2,4,8].map(n=>[String(n),Buffer.from(sdk.getPubKeyFromPrivKey(Uint8Array.from(Buffer.from(n.toString(16).padStart(64,'0'),'hex')))).toString('hex')])),id=sdk.deriveKeysetId(keys,{unit:'sat',input_fee_ppk:options.fee??0});
 const keyset={id,unit:'sat',active:true,input_fee_ppk:options.fee??0,keys};
 const proofs=['fixture-payer-a','fixture-payer-b'].map(secret=>{const Y=sdk.hashToCurve(new TextEncoder().encode(secret)),G=sdk.pointFromHex(Buffer.from(sdk.getPubKeyFromPrivKey(Uint8Array.from(Buffer.from('0'.repeat(63)+'1','hex')))).toString('hex')),B=Y.add(G),d=sdk.createDLEQProof(B,keyBytes);return {id,amount:2,secret,C:Y.multiply(2n).toHex(true),dleq:{e:Buffer.from(d.e).toString('hex'),s:Buffer.from(d.s).toString('hex'),r:'0'.repeat(63)+'1'}};});
 const token=sdk.getEncodedToken({mint,unit:'sat',proofs:sdk.normalizeProofAmounts(proofs)});let paid=false;let outputs:any[]=[];let calls:string[]=[];
 const quote=()=>({quote:'fixture_quote_1',amount:1,fee_reserve:1,expiry:time/1000+500,state:paid?'PAID':'UNPAID',payment_preimage:paid?preimage:null});
 function signatures(){return outputs.slice(0,1).map(o=>{const B=sdk.pointFromHex(o.B_),blind=sdk.createBlindSignature(B,keyBytes,id),d=sdk.createDLEQProof(B,keyBytes);return {id,amount:2,C_:blind.C_.toHex(true),dleq:{e:options.badChange?'ff'.repeat(32):Buffer.from(d.e).toString('hex'),s:Buffer.from(d.s).toString('hex')}};});}
 const request=async(args:any)=>{calls.push(args.method+' '+new URL(args.endpoint).pathname);if(args.endpoint.endsWith('/v1/keysets'))return {keysets:[keyset]};if(args.endpoint.includes('/v1/keys'))return {keysets:[keyset]};if(args.endpoint.endsWith('/v1/melt/quote/bolt11')&&args.method==='POST')return quote();if(args.endpoint.endsWith('/v1/melt/bolt11')){outputs=JSON.parse(JSON.stringify(args.requestBody.outputs));paid=!options.pending;if(options.lost)throw new Error('BEARER_MUST_NOT_LEAK');return {...quote(),state:options.pending?'PENDING':'PAID',change:paid?signatures():[]};}if(args.endpoint.includes('/v1/melt/quote/bolt11/'))return {...quote(),change:paid?signatures():[]};if(args.endpoint.endsWith('/v1/restore'))return {outputs:outputs.slice(0,1),signatures:signatures()};throw new Error('unexpected fixture call');};
 return {token,request:request as sdk.RequestFn,calls,keyset,proofs,outputs:()=>outputs};
}
test('mainnet signed whole-sat invoice and unsupported token refuse before transport',async()=>{
 assert.equal(invoiceCashuAmount(invoice(),()=>time).invoiceSats,1);assert.throws(()=>invoiceCashuAmount(invoice('1001'),()=>time));
 const f=fixture();await assert.rejects(prepareCashuMelt({token:'cashuAbroken',invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time}));assert.equal(f.calls.length,0);
});
test('real crypto prepare does not spend; one melt validates paid/preimage and returned change',async()=>{
 const f=fixture(),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});assert.equal(p.inputSats,4);assert.equal(p.maxDebitSats,2);assert.equal(p.inputTags.length,2);assert.equal(f.calls.filter(x=>x.endsWith('/v1/melt/bolt11')).length,0);assert.deepEqual(JSON.parse(JSON.stringify(p)),p);
 const result=await executeCashuMelt(p,{request:f.request,now:()=>time});assert.equal(result.state,'paid');assert.equal(result.changeSats,2);assert.equal(result.actualDebitSats,2);assert.equal(result.changePending,false);assert.ok(result.changeToken?.startsWith('cashu'));assert.equal(f.calls.filter(x=>x.endsWith('/v1/melt/bolt11')).length,1);
});
test('lost melt response recovers original quote and change without another melt',async()=>{
 const f=fixture({lost:true}),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});assert.equal((await executeCashuMelt(p,{request:f.request,now:()=>time})).state,'unknown');const r=await recoverCashuMelt(JSON.parse(JSON.stringify(p)),{request:f.request,now:()=>time});assert.equal(r.state,'paid');assert.equal(r.changeSats,2);assert.equal(f.calls.filter(x=>x.endsWith('/v1/melt/bolt11')).length,1);
});
test('paid with invalid DLEQ preserves payment and pending change; fee cap refuses pre-effect',async()=>{
 const f=fixture({badChange:true}),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});const r=await executeCashuMelt(p,{request:f.request,now:()=>time});assert.equal(r.state,'paid');assert.equal(r.changePending,true);assert.equal(r.changeToken,undefined);
 const g=fixture();await assert.rejects(prepareCashuMelt({token:g.token,invoice:invoice(),maxFeeSats:0,request:g.request,now:()=>time}));assert.equal(g.calls.filter(x=>x.endsWith('/v1/melt/bolt11')).length,0);
});
test('token mint, unit, duplicate, locks, DLEQ and amount are validated before any melt',async()=>{
 for(const mutate of [(t:any)=>{t.mint='https://mint.attacker.invalid';},(t:any)=>{t.unit='usd';},(t:any)=>{t.proofs[1]=t.proofs[0];},(t:any)=>{t.proofs[0].secret='["P2PK",{}]';},(t:any)=>{t.proofs[0].dleq.e='ff'.repeat(32);},(t:any)=>{t.proofs[0].amount=sdk.Amount.from(3);},(t:any)=>{delete t.proofs[0].dleq;}]){
  const f=fixture(),t={mint,unit:'sat',proofs:sdk.normalizeProofAmounts(f.proofs)};mutate(t);const token=sdk.getEncodedToken(t);await assert.rejects(prepareCashuMelt({token,invoice:invoice(),maxFeeSats:3,request:f.request,now:()=>time}),e=>e instanceof Error&&!e.message.includes('fixture-payer'));assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,0);
 }
});
test('fees include NUT02 proof fees, and capped fee failures never spend',async()=>{
 const f=fixture({fee:501});await assert.rejects(prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:2,request:f.request,now:()=>time}));const p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:3,request:f.request,now:()=>time});assert.equal(p.inputFeeSats,2);assert.equal(p.maxDebitSats,4);assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,0);
});
test('expired execution and mutated prepared amount, hash, output and tags fail before melt',async()=>{
 const f=fixture(),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});for(const mutate of [(p:any)=>p.inputSats++,(p:any)=>p.paymentHash='ff'.repeat(32),(p:any)=>p.private.outputData[0].secret='00',(p:any)=>p.inputTags[0]='ff'.repeat(32),(p:any)=>p.private.quote.amount=2]){const changed=structuredClone(p);mutate(changed);assert.equal((await executeCashuMelt(changed,{request:f.request,now:()=>time})).state,'unknown');}assert.equal((await executeCashuMelt(p,{request:f.request,now:()=>time+900000})).state,'unknown');assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,0);
});
test('paid recovery after invoice expiry uses original outputs, and repeated execute is suppressed',async()=>{
 const f=fixture({lost:true}),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});assert.equal((await executeCashuMelt(p,{request:f.request,now:()=>time})).state,'unknown');assert.equal((await executeCashuMelt(p,{request:f.request,now:()=>time})).state,'unknown');const r=await recoverCashuMelt(structuredClone(p),{request:f.request,now:()=>time+900000});assert.equal(r.state,'paid');assert.equal(r.changeSats,2);assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,1);
});
test('pending status stays pending and recovery never melts; response errors redact bearer details',async()=>{
 const f=fixture({pending:true}),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});assert.equal((await executeCashuMelt(p,{request:f.request,now:()=>time})).state,'pending');assert.equal((await recoverCashuMelt(p,{request:f.request,now:()=>time})).state,'unpaid');assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,1);
 const g=fixture();await assert.rejects(prepareCashuMelt({token:g.token,invoice:invoice(),maxFeeSats:1,request:(async()=>{throw new Error(g.token);}) as sdk.RequestFn,now:()=>time}),e=>e instanceof Error&&!e.message.includes(g.token));
});
test('quote-returned valid change needs no NUT09; missing quote change restores exact saved blanks',async()=>{
 for(const missing of [false,true]){const f=fixture({lost:true});const request=(async(args:any)=>{if(args.endpoint.endsWith('/v1/restore')&&!missing)throw new Error('restore should not be needed');const response:any=await f.request(args);if(missing&&args.endpoint.includes('/v1/melt/quote/bolt11/')&&args.method==='GET')delete response.change;return response;}) as sdk.RequestFn;const p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request,now:()=>time});await executeCashuMelt(p,{request,now:()=>time});const r=await recoverCashuMelt(p,{request,now:()=>time});assert.equal(r.state,'paid');assert.equal(r.changePending,false);assert.equal(r.changeSats,2);assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,1);assert.equal(f.calls.filter(c=>c.endsWith('/v1/restore')).length,missing?1:0);}
});
test('concurrent execute of one prepared operation submits one original melt',async()=>{
 const f=fixture(),p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request:f.request,now:()=>time});const results=await Promise.all([executeCashuMelt(p,{request:f.request,now:()=>time}),executeCashuMelt(p,{request:f.request,now:()=>time})]);assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,1);assert.equal(results.filter(r=>r.state==='paid').length,1);
});
test('quote amount/destination and payment preimage mismatches fail closed',async()=>{
 for(const patch of [{amount:2},{request:invoice('2000')},{unit:'usd'}]){const f=fixture(),request=(async(args:any)=>{const response:any=await f.request(args);return args.endpoint.endsWith('/v1/melt/quote/bolt11')?{...response,...patch}:response;}) as sdk.RequestFn;await assert.rejects(prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request,now:()=>time}));assert.equal(f.calls.filter(c=>c.endsWith('/v1/melt/bolt11')).length,0);}
 const f=fixture(),request=(async(args:any)=>{const response:any=await f.request(args);return args.endpoint.endsWith('/v1/melt/bolt11')?{...response,payment_preimage:'ff'.repeat(32)}:response;}) as sdk.RequestFn;const p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,request,now:()=>time});assert.equal((await executeCashuMelt(p,{request,now:()=>time})).state,'unknown');
});
test('native browser fetch transport omits credentials and forbids redirects without real network',async(t)=>{
 const f=fixture();t.mock.method(globalThis,'fetch',async(input:any,init:any)=>{assert.equal(init.credentials,'omit');assert.equal(init.redirect,'error');assert.equal(init.referrerPolicy,'no-referrer');const response=await f.request({endpoint:String(input),method:init.method,requestBody:init.body?JSON.parse(init.body):undefined});return new Response(JSON.stringify(response),{headers:{'Content-Type':'application/json'}});});const p=await prepareCashuMelt({token:f.token,invoice:invoice(),maxFeeSats:1,now:()=>time});assert.equal((await executeCashuMelt(p,{now:()=>time})).state,'paid');
});

test('committed expiry metadata survives minimal keys DTO and contradictory fees refuse',async()=>{
 const f=fixture(),expiry=2000000000,k={...f.keyset,final_expiry:expiry},id=sdk.deriveKeysetId(k.keys,{unit:'sat',input_fee_ppk:0,expiry});k.id=id;
 const token=sdk.getEncodedToken({mint,unit:'sat',proofs:sdk.normalizeProofAmounts(f.proofs.map(p=>({...p,id})))});
 const request:sdk.RequestFn=async<T>(args:sdk.RequestOptions)=>{
  if(args.endpoint.endsWith('/v1/keysets'))return {keysets:[k]} as T;
  if(args.endpoint.includes('/v1/keys/'))return {keysets:[{id,unit:'sat',keys:k.keys}]} as T;
  return f.request<T>(args);
 };
 const prepared=await prepareCashuMelt({token,invoice:invoice(),maxFeeSats:1,request,now:()=>time});assert.equal(prepared.private.keysets[0].final_expiry,expiry);
 const hostile:sdk.RequestFn=async<T>(args:sdk.RequestOptions)=>{const value=await request<any>(args);return (args.endpoint.includes('/v1/keys/')?{keysets:value.keysets.map((k:any)=>({...k,input_fee_ppk:500}))}:value) as T;};
 await assert.rejects(prepareCashuMelt({token,invoice:invoice(),maxFeeSats:1,request:hostile,now:()=>time}));assert.equal(f.calls.filter(x=>x.endsWith('/v1/melt/bolt11')).length,0);
});
