import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createSquareSandboxClient, verifySquareSignature, assertSquarePayment } from '../integrations/square.js';
import { createWiseSandboxClient } from '../integrations/wise.js';
import { fetchReferenceRate, clearReferenceCache } from '../integrations/reference.js';
import { listIntegrations } from '../integrations/catalog.js';

test('Square sends exact CAD cents, pinned version and durable idempotency to sandbox only', async () => {
  let captured: {url:string;init:RequestInit}|undefined;
  const client=createSquareSandboxClient({token:'fixture-token',locationId:'fixture-location',fetcher:async (url,init)=>{
    captured={url:String(url),init:init!};
    return Response.json({payment_link:{id:'link-1',url:'https://sandbox.square.link/u/fixture',order_id:'order-1'}});
  }});
  const result=await client.createPaymentLink({amount:12345,currency:'CAD',title:'Design service',idempotencyKey:'stable-fixture-key'});
  assert.equal(result.orderId,'order-1');
  assert.equal(captured!.url,'https://connect.squareupsandbox.com/v2/online-checkout/payment-links');
  const body=JSON.parse(String(captured!.init.body));
  assert.equal(body.idempotency_key,'stable-fixture-key');
  assert.deepEqual(body.quick_pay.price_money,{amount:12345,currency:'CAD'});
  assert.equal(new Headers(captured!.init.headers).get('Square-Version'),'2026-09-16');
  await assert.rejects(()=>client.createPaymentLink({amount:0,currency:'CAD',title:'Bad',idempotencyKey:'k'}));
  await assert.rejects(()=>client.createPaymentLink({amount:100,currency:'USD',title:'Mismatch',idempotencyKey:'k'}));
});

test('Square validates signed raw body and requires matching settled payment bindings', () => {
  const raw='{"event_id":"fixture-event"}',url='https://merchant.example/webhooks/square',key='fixture-signature-key';
  const signature=createHmac('sha256',key).update(url+raw).digest('base64');
  assert.equal(verifySquareSignature({rawBody:raw,notificationUrl:url,signatureKey:key,signature}),true);
  assert.equal(verifySquareSignature({rawBody:raw+' ',notificationUrl:url,signatureKey:key,signature}),false);
  assert.equal(verifySquareSignature({rawBody:raw,notificationUrl:url,signatureKey:key,signature:'bad'}),false);
  const expected={orderId:'order-1',locationId:'loc-1',amount:500,currency:'CAD' as const};
  const payment={status:'COMPLETED',order_id:'order-1',location_id:'loc-1',amount_money:{amount:500,currency:'CAD'}};
  assert.doesNotThrow(()=>assertSquarePayment(payment,expected));
  for(const wrong of [{...payment,status:'PENDING'},{...payment,order_id:'another'},{...payment,amount_money:{amount:501,currency:'CAD'}}]){
    assert.throws(()=>assertSquarePayment(wrong,expected));
  }
});

test('provider errors are sanitized and never expose a token or upstream payload', async()=>{
  const client=createSquareSandboxClient({token:'fixture-super-secret',locationId:'loc',fetcher:async()=>new Response('fixture-super-secret upstream account',{status:401})});
  await assert.rejects(()=>client.createPaymentLink({amount:50,currency:'CAD',title:'x',idempotencyKey:'k'}),(error:any)=>{
    assert.equal(error.message.includes('fixture-super-secret'),false);
    assert.equal(error.message.includes('upstream account'),false);
    return true;
  });
});

test('Wise uses sandbox business transfer API with stable UUID and no automatic funding',async()=>{
  const requests:{url:string;body:any}[]=[];
  const client=createWiseSandboxClient({token:'fixture-token',profileId:42,fetcher:async(url,init)=>{
    requests.push({url:String(url),body:JSON.parse(String(init!.body))});
    if(String(url).includes('/quotes'))return Response.json({id:'quote-fixture',sourceAmount:100,targetAmount:100,sourceCurrency:'CAD',targetCurrency:'CAD'});
    return Response.json({id:123,status:'incoming_payment_waiting',business:42,targetAccount:12,quoteUuid:'quote-fixture',customerTransactionId:'702d3526-1ce8-4afb-84d1-6c0a5c370955',details:{reference:'INV-DEMO'}});
  }});
  const quote=await client.createQuote({amountMinor:10000,sourceCurrency:'CAD',targetCurrency:'CAD',fundingOrigin:'ordinary_fiat'});
  assert.equal(quote.id,'quote-fixture');
  const id='702d3526-1ce8-4afb-84d1-6c0a5c370955';
  const result=await client.createTransfer({recipientId:12,quoteId:quote.id,customerTransactionId:id,reference:'INV-DEMO',fundingOrigin:'ordinary_fiat'});
  assert.equal(result.id,123);
  assert.equal(requests[0].url,'https://api.wise-sandbox.com/2026Q4/profiles/42/quotes');
  assert.equal(requests[0].body.sourceAmount,100);
  assert.equal(requests[1].url,'https://api.wise-sandbox.com/2026Q4/transfers');
  assert.equal(requests[1].body.customerTransactionId,id);
  assert.equal(requests.some(x=>x.url.endsWith('/payments')),false);
  await assert.rejects(()=>client.createQuote({amountMinor:100,sourceCurrency:'CAD',targetCurrency:'CAD',fundingOrigin:'crypto'}));
  await assert.rejects(()=>client.createTransfer({recipientId:12,quoteId:'q',customerTransactionId:'not-uuid',reference:'r',fundingOrigin:'ordinary_fiat'}));
});

test('live reference FX preserves observation date, caches and labels stale data honestly',async()=>{
  clearReferenceCache();let count=0;
  const fetcher=async()=>{count++;return Response.json({observations:[{d:'2026-11-04',FXUSDCAD:{v:'1.3961'}}]});};
  const a=await fetchReferenceRate({fetcher,now:new Date('2026-11-05T01:00:00Z')});
  assert.equal(a.rate,1.3961);assert.equal(a.asOf,'2026-11-04');assert.equal(a.kind,'reference');
  await fetchReferenceRate({fetcher,now:new Date('2026-11-05T01:01:00Z')});assert.equal(count,1);
  const stale=await fetchReferenceRate({fetcher:async()=>{throw new Error('offline');},now:new Date('2026-11-08T01:00:00Z')});
  assert.equal(stale.stale,true);assert.equal(stale.rate,1.3961);
  clearReferenceCache();
  const unavailable=await fetchReferenceRate({fetcher:async()=>Response.json({observations:[]})});
  assert.equal(unavailable.rate,null);assert.equal(unavailable.kind,'unavailable');
});

test('integration catalog distinguishes sandbox code, assisted rails and live reference data',()=>{
  const rows=listIntegrations();
  assert.equal(rows.find(x=>x.id==='square')?.status,'sandbox_ready');
  assert.equal(rows.find(x=>x.id==='wise')?.status,'sandbox_ready');
  assert.equal(rows.find(x=>x.id==='tangerine')?.status,'manual');
  assert.equal(rows.find(x=>x.id==='robosats')?.status,'research');
  assert.equal(rows.some(x=>x.status==='connected'),false);
});
