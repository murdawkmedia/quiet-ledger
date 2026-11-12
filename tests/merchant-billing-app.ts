import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

/**
 * Dedicated real-app fixture for the merchant-billing browser journey. The real
 * `createApp` (real sessions, CSRF, idempotency, ledger, checkout) serves the built
 * client from `dist/client` on the dedicated loopback port 4362. The only controlled
 * provider is a synthetic bank adapter whose observations always require the owner's
 * explicit manual review; no provider transport, wallet, real account, seed or funded
 * transaction is used, and the database is a temporary file outside the repository.
 */
export const merchantBillingOwnerToken='fictional-merchant-billing-owner';
export const merchantBillingPort=4362;

export async function startMerchantBillingFixture(){
  const dir=mkdtempSync(join(tmpdir(),'ql-merchant-billing-'));
  const adapter:ReceivingAdapter={
    id:'fictional-merchant-bank',mode:'live',methods:['bank'],walletOptionIds:['manual-fiat'],
    create:async context=>({providerId:context.requestId,asset:context.currency,network:'fiat',
      instructions:[{label:'Synthetic bank instructions',value:'Fixture only: the merchant independently verifies the exact received transfer before confirming.'}]}),
    check:async()=>({status:'review',reason:'Synthetic bank receipt needs independent owner verification.'})
  };
  const app=createApp({dbPath:join(dir,'fictional.sqlite'),ownerToken:merchantBillingOwnerToken,receivingAdapters:[adapter],
    receivingQuote:async invoice=>({expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'Synthetic browser quote; no market source contacted',observedAt:new Date().toISOString()})});
  const root=resolve(import.meta.dirname,'..');
  const outer=express();
  outer.use(app);
  outer.use(express.static(resolve(root,'dist/client')));
  outer.get('/{*path}',(_req,res)=>res.sendFile(resolve(root,'dist/client/index.html')));
  const listener=outer.listen(merchantBillingPort,'127.0.0.1');
  try{await new Promise<void>((ready,failed)=>{listener.once('listening',ready);listener.once('error',failed);});}
  catch(error){await app.locals.closeAsync();rmSync(dir,{recursive:true,force:true});throw error;}
  return {
    origin:`http://127.0.0.1:${merchantBillingPort}`,
    close:async()=>{listener.closeAllConnections();await new Promise<void>((ready,failed)=>listener.close(error=>error?failed(error):ready()));app.locals.close();rmSync(dir,{recursive:true,force:true});}
  };
}
