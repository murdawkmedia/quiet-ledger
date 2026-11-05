import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {ReceivingService} from '../server/receiving-service.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingObservation} from '../shared/receiving.js';

const input={customerName:'Fictional review customer',title:'Synthetic lifecycle review',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:125}]};
const quote=async()=>({expectedAtomic:'1000',cadEquivalent:125,source:'synthetic-review-only',observedAt:'2026-11-04T00:00:00.000Z'});
const intent=(context:ReceivingContext)=>({providerId:context.requestId,network:'mainnet',asset:'BTC',request:'bitcoin:synthetic-review-only'});
const paid=(context:ReceivingContext):ReceivingObservation=>({status:'paid',paymentId:'synthetic-review-payment',amount:context.amount,currency:context.currency,reference:context.requestId});

test('independent review: a late expired readback cannot erase another instance verified receipt',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-review-race-'));
  const first=new Store(join(directory,'synthetic.sqlite')),second=new Store(join(directory,'synthetic.sqlite'));
  let clock=new Date('2026-11-04T00:00:00Z');
  let release!:(value:ReceivingObservation)=>void,started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  let firstContext!:ReceivingContext;
  const adapterA:ReceivingAdapter={id:'synthetic-review',mode:'live',methods:['bitcoin'],create:async c=>intent(c),check:async c=>{firstContext=c;started();return new Promise(resolve=>{release=resolve;});}};
  const adapterB:ReceivingAdapter={...adapterA,check:async c=>paid(c)};
  try{
    const invoice=createInvoice(first,'owner',input,clock);
    const serviceA=new ReceivingService(first,[adapterA],quote,()=>clock);
    const serviceB=new ReceivingService(second,[adapterB],quote,()=>clock);
    const created=await serviceA.create('owner',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapterA.id},'synthetic-race-key');
    const late=serviceA.check(created.id);await entered;
    const verified=await serviceB.check(created.id);assert.equal(verified.status,'paid');
    clock=new Date(clock.getTime()+3600000);release(paid(firstContext));await late;
    const saved=serviceA.read(created.id);
    assert.equal(saved.status,'paid','late readback must preserve durable paid status');
    assert.deepEqual(saved.receipt,verified.receipt,'late readback must preserve durable receipt');
  }finally{first.close();second.close();rmSync(directory,{recursive:true,force:true});}
});

test('independent review: interrupted non-idempotent creation cannot create a second provider invoice after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-review-crash-'));
  const path=join(directory,'synthetic.sqlite');let first:Store|undefined=new Store(path),second:Store|undefined;
  const clock=new Date('2026-11-04T00:00:00Z');
  let creates=0,started!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve;});
  const adapterA:ReceivingAdapter={id:'synthetic-non-idempotent',mode:'live',methods:['lightning'],create:async()=>{creates++;started();return new Promise(()=>{});},check:async()=>({status:'pending'})};
  try{
    const invoice=createInvoice(first,'owner',input,clock);
    const serviceA=new ReceivingService(first,[adapterA],quote,()=>clock);
    const body={invoiceId:invoice.id,method:'lightning' as const,adapterId:adapterA.id};
    // An upstream callback may already have created an invoice when the process
    // stops. A never-returning synthetic transport models that interruption.
    void serviceA.create('owner',body,'synthetic-crash-key');await entered;
    first.close();first=undefined;
    second=new Store(path);
    const adapterB:ReceivingAdapter={...adapterA,create:async c=>{creates++;return intent(c);},recover:async()=>{throw new Error('Synthetic provider has no recovery protocol.');}};
    const serviceB=new ReceivingService(second,[adapterB],quote,()=>clock);
    await serviceB.create('owner',body,'synthetic-crash-key').catch(()=>{});
    assert.equal(creates,1,'restarted uncertain creation must recover or stop, never repeat the external create');
  }finally{first?.close();second?.close();rmSync(directory,{recursive:true,force:true});}
});
