// Isolated browser test harness only. This file is never imported by production.
// All provider responses below are fictional; there is no network transport.
import express from 'express';
import {randomUUID} from 'node:crypto';
import {createServer as createHttpServer} from 'node:http';
import {mkdirSync,chmodSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createServer} from 'vite';
import {createApp} from '../server/app.js';
import type {Currency} from '../shared/contracts.js';

const root=resolve(import.meta.dirname,'..');
const runtime=resolve(root,'.runtime/hardening-browser');
mkdirSync(runtime,{recursive:true,mode:0o700});chmodSync(runtime,0o700);
const requests:{url:string;body:unknown}[]=[];
const orders=new Map<string,{id:string;amount:number;currency:Currency;locationId:string}>();
const providerKeys=new Map<string,string>();
let creationFailures=1,readbackFailures=0,paymentStatus='pending';
const fetcher=async(url:string,init?:RequestInit)=>{
  if(new URL(url).origin!=='https://connect.squareupsandbox.com')throw new Error('Fictional harness refuses any other transport');
  const body=init?.body?JSON.parse(String(init.body)):undefined;requests.push({url,body});
  if(url.endsWith('/locations'))return Response.json({locations:[{id:'FICTIONAL-CAD-LOCATION',currency:'CAD',status:'ACTIVE'}]});
  if(url.endsWith('/payment-links')){
    let orderId=providerKeys.get(body.idempotency_key);
    if(!orderId){orderId='FICTIONAL-ORDER-'+randomUUID();providerKeys.set(body.idempotency_key,orderId);orders.set(orderId,{id:orderId,amount:body.quick_pay.price_money.amount,currency:body.quick_pay.price_money.currency,locationId:body.quick_pay.location_id});}
    if(creationFailures-->0)throw new Error('Fictional response loss after provider accepted the request');
    return Response.json({payment_link:{id:'FICTIONAL-LINK-'+orderId,order_id:orderId,url:'https://sandbox.square.link/u/'+orderId}});
  }
  const orderId=url.split('/orders/')[1];
  if(orderId){
    if(readbackFailures-->0)throw new Error('Fictional temporary readback outage');
    const order=orders.get(orderId);if(!order)return Response.json({}, {status:404});
    return Response.json({order:{id:order.id,location_id:order.locationId,total_money:{amount:order.amount,currency:order.currency},tenders:paymentStatus==='pending'?[]:[{id:'FICTIONAL-PAYMENT-'+order.id,payment_id:'FICTIONAL-PAYMENT-'+order.id}]}});
  }
  const paymentId=url.split('/payments/')[1];
  if(paymentId){
    const order=orders.get(paymentId.replace('FICTIONAL-PAYMENT-',''));if(!order)return Response.json({}, {status:404});
    return Response.json({payment:{id:paymentId,order_id:order.id,location_id:order.locationId,status:'COMPLETED',amount_money:{amount:order.amount+(paymentStatus==='mismatch'?1:0),currency:order.currency},refunded_money:{amount:0,currency:order.currency}}});
  }
  throw new Error('Unexpected fictional provider request');
};
const listeners:ReturnType<ReturnType<typeof express>['listen']>[]=[];
const apps:ReturnType<typeof createApp>[]=[];
const vites:Awaited<ReturnType<typeof createServer>>[]=[];
for(const configured of [false,true]){
  const directory=join(runtime,configured?'square':'unconfigured');mkdirSync(directory,{recursive:true,mode:0o700});
  const app=createApp({dbPath:join(directory,'ledger.sqlite'),ownerToken:'hardening-fictional-owner-only',privateScenarioPath:join(root,'tests/fixtures/owner-scenario.json'),simulationOnly:true,fxFetcher:async()=>({source:'Fictional browser fixture',rate:1.35,date:'2026-11-04',base:'USD',quote:'CAD',referenceOnly:true}),...(configured?{squareSandbox:{token:'FICTIONAL-NOT-A-SQUARE-TOKEN',fetcher}}:{})});
  apps.push(app);
  if(configured){
    app.get('/__fixture/state',(_req,res)=>res.json({requests,paymentStatus,creationFailures,readbackFailures}));
    app.post('/__fixture/provider',express.json(),(req,res)=>{
      if(typeof req.body.creationFailures==='number')creationFailures=req.body.creationFailures;
      if(typeof req.body.readbackFailures==='number')readbackFailures=req.body.readbackFailures;
      if(['pending','mismatch','completed'].includes(req.body.paymentStatus))paymentStatus=req.body.paymentStatus;
      res.json({fixture:true});
    });
  }
  const httpServer=createHttpServer(app);
  const vite=await createServer({root:join(root,'client'),configFile:join(root,'vite.config.ts'),server:{middlewareMode:true,ws:{server:httpServer}},appType:'spa'});vites.push(vite);app.use(vite.middlewares);
  const port=configured?4331:4330;
  listeners.push(httpServer.listen(port,'127.0.0.1',()=>console.log(`Fictional browser harness ${configured?'with':'without'} Square transport on ${port}`)));
}
let closing=false;
async function close(){if(closing)return;closing=true;await Promise.all(listeners.map(server=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))));await Promise.all(vites.map(vite=>vite.close()));apps.forEach(app=>app.locals.close());}
process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
