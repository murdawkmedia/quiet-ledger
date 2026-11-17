import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import type {ReceivingAdapter} from '../shared/receiving.js';

const origin='https://demo-live.example',proxy='fictional-demo-live-proxy-only-at-least32';
function fixture(enabled=true){
  const state={creates:0,paid:false};
  const adapter:ReceivingAdapter={id:'fictional-demo-live-adapter',methods:['lightning'],mode:'live',supportedCurrencies:['SAT'],
    create:async context=>{state.creates++;return {providerId:'fictional:'+context.requestId,request:'lightning:lnbc210n1fictional',network:'mainnet',asset:'BTC',allocationKey:'fictional-demo-live:'+context.requestId,opaque:{secret:'fictional-never-public-terminal-key'}};},
    check:async context=>state.paid?{status:'paid',paymentId:'fictional-payment:'+context.requestId,reference:context.requestId,amount:21,currency:'SAT'}:{status:'pending'}};
  const app=createApp({dbPath:':memory:',encryptionKey:Buffer.alloc(32,57),hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true},...(enabled?{demoLiveAdapter:adapter}:{})} as Parameters<typeof createApp>[0]);
  function call(method:'get'|'post',path:string,cookie?:string,csrf?:string,body?:object){
    const req=request(app)[method](path).set('x-quiet-ledger-proxy',proxy).set('Origin',origin);
    if(cookie)req.set('Cookie',cookie);if(csrf)req.set('X-CSRF-Token',csrf);
    if(method==='post')req.set('Idempotency-Key',randomUUID()).send(body??{});return req;
  }
  async function actor(){
    const login=await call('post','/api/session/hackathon-demo',undefined,undefined,{password:'marmot'}).expect(200);
    const cookie=(login.headers['set-cookie'] as unknown as string[]).map(value=>value.split(';')[0]).join('; ');
    return {get:(path:string)=>call('get',path,cookie),post:(path:string,body:object={})=>call('post',path,cookie,login.body.csrfToken,body),cookie,csrf:login.body.csrfToken};
  }
  return {app,state,actor,call,close:()=>app.locals.closeAsync()};
}

test('real sample is disabled honestly when no dedicated receiver is configured',async()=>{
  const f=fixture(false);try{const a=await f.actor();const view=await a.get('/api/hackathon-demo/live-payment').expect(200);
    assert.equal(view.body.enabled,false);assert.equal(view.body.receiver,'countzapula@coinos.io');
    await a.post('/api/hackathon-demo/live-payment',{acknowledgeRealFunds:true}).expect(503);
    assert.equal(f.state.creates,0);
  }finally{await f.close();}
});

test('new demo routes enforce session, CSRF, strict consent and unchanged generic financial denial',async()=>{
  const f=fixture();try{
    await f.call('get','/api/hackathon-demo/live-payment').expect(401);
    const a=await f.actor();await a.get('/api/hackathon-demo/live-payment').expect(200);
    await f.call('post','/api/hackathon-demo/live-payment',a.cookie,'wrong',{acknowledgeRealFunds:true}).expect(403);
    for(const body of [{},{acknowledgeRealFunds:false},{acknowledgeRealFunds:true,amount:1},{acknowledgeRealFunds:true,receiver:'attacker@example.invalid'}])await a.post('/api/hackathon-demo/live-payment',body).expect(400);
    await a.post('/api/hackathon-demo/live-payment/check',{paymentId:'fabricated'}).expect(400);
    await a.post('/api/receiving',{}).expect(403);await a.get('/api/account/connections').expect(403);
    assert.equal(f.state.creates,0);
  }finally{await f.close();}
});

test('current demo gets one real sample, isolated from other visits and its simulated invoice',async()=>{
  const f=fixture();try{
    const a=await f.actor(),b=await f.actor(),before=(await a.get('/api/hackathon-demo').expect(200)).body;
    const first=await a.post('/api/hackathon-demo/live-payment',{acknowledgeRealFunds:true}).expect(201);
    assert.equal(first.body.request.amount,21);assert.equal(first.body.request.currency,'SAT');assert.equal(first.body.request.mode,'live');
    assert.equal((await b.get('/api/hackathon-demo/live-payment').expect(200)).body.request,undefined);
    assert.equal((await a.post('/api/hackathon-demo/live-payment',{acknowledgeRealFunds:true}).expect(201)).body.request.id,first.body.request.id);
    assert.equal(f.state.creates,1);
    assert.equal((await a.post('/api/hackathon-demo/live-payment/check').expect(200)).body.request.status,'awaiting_payment');
    f.state.paid=true;const paid=await a.post('/api/hackathon-demo/live-payment/check').expect(200);
    assert.equal(paid.body.request.status,'paid');assert.equal(paid.body.request.receipt.mode,'live');assert.equal(paid.body.request.receipt.method,'lightning');
    assert.equal((await a.get('/api/hackathon-demo').expect(200)).body.invoice.status,before.invoice.status);
    assert.ok(!JSON.stringify(paid.body).includes('fictional-never-public-terminal-key'));
    for(const field of ['token','invoiceId','adapterId','quote','opaque'])assert.equal(field in paid.body.request,false);
  }finally{await f.close();}
});
