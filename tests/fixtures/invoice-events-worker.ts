// Fictional controlled SQLite contender for invoice events, with no provider or network access.
// Permission scope: this bounded test worker opens one fictional encrypted file database
// supplied by the spawning test, performs one receiving check or event page read, and exits.
import {Store} from '../../server/store.js';
import {InvoiceEvents} from '../../server/invoice-events.js';
import {ReceivingService} from '../../server/receiving-service.js';
import type {ReceivingAdapter} from '../../shared/receiving.js';
import type {ReceivingQuote} from '../../server/receiving-service.js';
import type {Invoice} from '../../shared/contracts.js';

const store=new Store(process.argv[2],{encryptionKey:Buffer.alloc(32,77)});
const paid=new Set<string>();
const adapter:ReceivingAdapter={id:'fictional-live',mode:'live',methods:['lightning'],
  create:async context=>({providerId:'fictional-provider-'+context.requestId,asset:'BTC',network:'mainnet'}),
  check:async context=>paid.has(context.requestId)?{status:'paid',paymentId:'fictional-payment-'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'}};
const quote=(invoice:Invoice):Promise<ReceivingQuote>=>Promise.resolve({expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.total,source:'fictional exact quote',observedAt:'2026-11-08T12:00:00.000Z'});
const receiving=new ReceivingService(store,[adapter],quote,()=>new Date('2026-11-08T12:00:00Z'));
const events=new InvoiceEvents(store);
process.on('message',(message:unknown)=>{
  const job=message as {kind:'check'|'page';requestId?:string;workspace:string;limit?:number;cursor?:string};
  const done=(payload:unknown)=>{process.send?.(payload);store.close();process.disconnect?.();};
  const failed=(error:unknown)=>done({error:{message:error instanceof Error?error.message:String(error),...(error&&typeof error==='object'&&'status' in error&&typeof (error as {status:unknown}).status==='number'?{status:(error as {status:number}).status}:{})}});
  if(job.kind==='check'){
    paid.add(job.requestId!);
    receiving.check(job.requestId!,job.workspace).then(view=>done({result:{status:view.status}}),failed);
    return;
  }
  try{done({result:events.page(job.workspace,job.limit??25,job.cursor)});}catch(error){failed(error);}
});
process.send?.({ready:true});
