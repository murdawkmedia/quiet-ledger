import test from 'node:test';
import assert from 'node:assert/strict';
import type {InvoiceItem} from '../shared/contracts.js';
import {calculateInvoiceAmounts} from '../shared/invoice-options.js';
import {Store,DomainError} from '../server/store.js';
import {createInvoice,publicInvoice} from '../server/domain.js';

const now=new Date('2026-11-06T12:00:00Z');
const labour:InvoiceItem={description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service'};
const flights:InvoiceItem={description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense'};
const draft={customerName:'Fictional line client',title:'Fictional project',currency:'CAD',items:[labour,flights],taxBps:0,discountBps:500};

test('service discount excludes flights while subtotal retains every line',()=>{
 assert.deepEqual(calculateInvoiceAmounts([labour,flights],0,500),{subtotal:280000,discountAmount:10000,premiumAmount:0,tax:0,total:270000});
});

test('explicit eligibility overrides the service or expense default and works without a kind',()=>{
 const cases:[Partial<InvoiceItem>,number][]=[
  [{},50],[{kind:'service'},50],[{kind:'expense'},0],
  [{kind:'service',adjustmentEligible:false},0],[{kind:'expense',adjustmentEligible:true},50],
  [{adjustmentEligible:false},0],[{adjustmentEligible:true},50],
 ];
 for(const [flags,adjustment] of cases){
  const item={description:'Fictional line',quantity:1,unitAmount:100,...flags};
  const result=calculateInvoiceAmounts([item],0,5000,5000);
  assert.equal(result.discountAmount,adjustment,JSON.stringify(flags));
  assert.equal(result.premiumAmount,adjustment,JSON.stringify(flags));
  assert.equal(result.subtotal,100);assert.equal(result.total,100);
 }
});

test('eligible extended line values form one base with independent rounding and global tax',()=>{
 const items:InvoiceItem[]=[
  {description:'Fictional service A',quantity:3,unitAmount:1,kind:'service'},
  {description:'Fictional service B',quantity:1,unitAmount:2,adjustmentEligible:true},
  {description:'Fictional expense',quantity:1,unitAmount:7,kind:'expense'},
 ];
 assert.deepEqual(calculateInvoiceAmounts(items,5000,5000,2500),{subtotal:12,discountAmount:3,premiumAmount:1,tax:5,total:15});
});

test('no eligible lines leave both adjustments zero and preserve existing global tax',()=>{
 assert.deepEqual(calculateInvoiceAmounts([{...flights,quantity:2},{...labour,adjustmentEligible:false}],500,10000,10000),{subtotal:360000,discountAmount:0,premiumAmount:0,tax:18000,total:378000});
});

test('a full service discount retains all excluded expenses',()=>{
 const store=new Store(':memory:');try{
  const invoice=createInvoice(store,'fixture',{...draft,discountBps:10000},now);
  assert.equal(invoice.subtotal,280000);assert.equal(invoice.discountAmount,200000);assert.equal(invoice.total,80000);
 }finally{store.close();}
});

test('legacy item totals and absent flags remain unchanged for every existing currency',()=>{
 const store=new Store(':memory:');try{
  for(const currency of ['CAD','USD','EUR','GBP','KRW']){
   const legacy={description:'Fictional legacy service',quantity:1,unitAmount:10001};
   const invoice=createInvoice(store,'fixture',{...draft,currency,items:[legacy],taxBps:500,discountBps:1000,premiumBps:250},now);
   assert.deepEqual([invoice.subtotal,invoice.discountAmount,invoice.premiumAmount,invoice.tax,invoice.total],[10001,1000,250,463,9714]);
   assert.deepEqual(invoice.items,[legacy]);assert.deepEqual(publicInvoice(invoice).items,[legacy]);
   const explicit=createInvoice(store,'fixture',{...draft,currency,items:[{...legacy,kind:'service',adjustmentEligible:true}],taxBps:500,discountBps:1000,premiumBps:250},now);
   for(const key of ['subtotal','discountAmount','premiumAmount','tax','total','totalCad','amountSats'] as const)assert.equal(explicit[key],invoice[key]);
  }
 }finally{store.close();}
});

test('whole won uses the same integer adjustment rounding without introducing cents',()=>{
 const store=new Store(':memory:');try{
  const invoice=createInvoice(store,'fixture',{...draft,currency:'KRW',items:[{...labour,unitAmount:150001},flights]},now);
  assert.deepEqual([invoice.subtotal,invoice.discountAmount,invoice.total,invoice.totalCad],[230001,7500,222501,22250]);
 }finally{store.close();}
});

test('large valid line products keep exact BigInt arithmetic for the eligible base',()=>{
 const items:InvoiceItem[]=[{...labour,quantity:10000,unitAmount:999999999},{...flights,unitAmount:1000000000}];
 assert.deepEqual(calculateInvoiceAmounts(items,0,3333),{subtotal:10000999990000,discountAmount:3332999996667,premiumAmount:0,tax:0,total:6667999993333});
});

test('item flags use strict enums and booleans and reject invalid input before writing',()=>{
 const store=new Store(':memory:');try{
  const invalid=[{kind:'flight'},{kind:'Service'},{kind:''},{kind:null},{kind:1},{kind:[]},{adjustmentEligible:'false'},{adjustmentEligible:0},{adjustmentEligible:1},{adjustmentEligible:null},{adjustmentEligible:{}},{kind:'service',taxable:false}];
  for(const flags of invalid)assert.throws(()=>createInvoice(store,'fixture',{...draft,items:[{description:'Fictional invalid line',quantity:1,unitAmount:100,...flags}]},now),(error:unknown)=>error instanceof DomainError&&error.status===400,JSON.stringify(flags));
  assert.deepEqual(store.listInvoices('fixture'),[]);assert.deepEqual(store.audits('fixture',true),[]);
  const explicit=createInvoice(store,'fixture',{...draft,items:[{...labour,adjustmentEligible:false},{...flights,adjustmentEligible:true}]},now);
  assert.equal(explicit.discountAmount,4000);assert.equal(explicit.items[0].adjustmentEligible,false);assert.equal(explicit.items[1].adjustmentEligible,true);
 }finally{store.close();}
});
