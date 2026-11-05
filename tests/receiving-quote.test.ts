import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteReceiving} from '../server/receiving-quote.js';
import {createInvoice} from '../server/domain.js';
import {Store} from '../server/store.js';
import type {Currency} from '../shared/contracts.js';
function invoice(currency:Currency='CAD'){
  const store=new Store(':memory:');
  try{return createInvoice(store,'owner',{customerName:'Fictional quotation test',title:'Synthetic service',currency,items:[{description:'Synthetic',quantity:1,unitAmount:125}]},new Date());}finally{store.close();}
}
const response=(data:unknown)=>new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
test('live CAD fiat keeps exact invoice units without depending on an external conversion feed',async()=>{
  let reads=0;
  const value=await quoteReceiving(invoice(),'interac','live',async()=>{reads++;throw new Error('synthetic offline feed');});
  assert.equal(value.expectedAtomic,'125');assert.equal(value.cadEquivalent,125);assert.equal(reads,0);
});
test('live native amounts use bound public references and exact rational rounding',async()=>{
  const seen:string[]=[];
  const value=await quoteReceiving(invoice(),'bitcoin','live',async url=>{seen.push(url);return response(url.includes('/prices/')?{base:'BTC',currency:'CAD',amount:'100000.00'}:{currency:'CAD',rates:{CAD:'1'}});});
  assert.equal(value.expectedAtomic,'1250');assert.equal(value.cadEquivalent,125);assert.equal(seen.length,2);
  const stable=await quoteReceiving(invoice('EUR'),'usdc','live',async()=>response({currency:'EUR',rates:{CAD:'1.5',USD:'1.1'}}));
  assert.equal(stable.expectedAtomic,'1375000');assert.equal(stable.cadEquivalent,188);
});
test('live references fail closed on source binding errors and outage; test rates remain explicit',async()=>{
  await assert.rejects(quoteReceiving(invoice('USD'),'card','live',async()=>response({currency:'EUR',rates:{CAD:'1.4'}})),/currency mismatch/);
  await assert.rejects(quoteReceiving(invoice(),'bitcoin','live',async url=>{if(url.includes('/prices/'))throw new Error('synthetic outage');return response({currency:'CAD',rates:{CAD:'1'}});}),/unavailable/);
  const explicit=await quoteReceiving(invoice(),'bitcoin','test',async()=>{throw new Error('no network in test');});assert.match(explicit.source,/test mode only/);
});
test('KRW uses whole-won amounts for CAD, BTC and six-decimal stablecoin quotes',async()=>{const base={...invoice(),currency:'KRW' as const,total:150000,totalCad:15000};const fetcher=async(url:string)=>response(url.includes('/prices/')?{base:'BTC',currency:'KRW',amount:'100000000'}:{currency:'KRW',rates:{CAD:'0.001',USD:'0.0007'}});const bitcoin=await quoteReceiving(base,'bitcoin','live',fetcher);assert.equal(bitcoin.expectedAtomic,'150000');assert.equal(bitcoin.cadEquivalent,15000);const stable=await quoteReceiving(base,'usdc','live',fetcher);assert.equal(stable.expectedAtomic,'105000000');assert.equal(stable.cadEquivalent,15000);});
