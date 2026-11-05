import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createSquareSandboxClient,listSquareSandboxLocations} from '../integrations/square.js';
import {createWiseSandboxClient} from '../integrations/wise.js';
import type {HttpFetch} from '../integrations/http.js';
import {Store} from '../server/store.js';
import {createInvoice} from '../server/domain.js';
import {SquareSandbox} from '../server/square-sandbox.js';

const now=()=>new Date('2026-11-05T01:00:00.000Z');
const invoiceInput={customerName:'Fictional fixture customer',title:'Fictional service',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:125}]};
const link={id:'fixture-link',order_id:'fixture-order',url:'https://sandbox.square.link/u/fixture'};
const order={id:'fixture-order',location_id:'loc-A',total_money:{amount:125,currency:'CAD'},tenders:[{id:'fixture-payment',payment_id:'fixture-payment'}]};
const payment={id:'fixture-payment',order_id:'fixture-order',location_id:'loc-A',status:'COMPLETED',amount_money:{amount:125,currency:'CAD'},refunded_money:{amount:0,currency:'CAD'}};
function provider(onCreate?:(body:any)=>Promise<Response>,paymentValue:unknown=payment):HttpFetch{
  return async(url,init)=>{
    if(url.endsWith('/locations'))return Response.json({locations:[{id:'loc-A',status:'ACTIVE',currency:'CAD'},{id:'loc-B',status:'ACTIVE',currency:'CAD'}]});
    if(url.endsWith('/payment-links'))return onCreate?onCreate(JSON.parse(String(init?.body))):Response.json({payment_link:link});
    if(url.endsWith('/orders/fixture-order'))return Response.json({order});
    if(url.endsWith('/payments/fixture-payment'))return Response.json({payment:paymentValue});
    throw new Error('Unexpected synthetic provider request');
  };
}

test('Square location discovery rejects blank and oversized active location identifiers',async(t)=>{
  for(const id of ['', ' ', 'x'.repeat(201)])await t.test(`invalid location length ${id.length}`,async()=>{
    await assert.rejects(()=>listSquareSandboxLocations('synthetic-provider-token',async()=>Response.json({locations:[{id,status:'ACTIVE',currency:'CAD'}]})));
  });
});

test('a malformed Square location cannot poison a durable intent before configuration recovery',async()=>{
  const store=new Store(':memory:');let malformed=true;let creationCalls=0;
  const fetcher:HttpFetch=async(url)=>{
    if(url.endsWith('/locations'))return Response.json({locations:[{id:malformed?'':'loc-A',status:'ACTIVE',currency:'CAD'}]});
    creationCalls++;return Response.json({payment_link:link});
  };
  const service=new SquareSandbox(store,{token:'synthetic-provider-token',fetcher},now);
  try{
    const invoice=createInvoice(store,'owner',invoiceInput,now());
    await assert.rejects(()=>service.create(invoice.id,randomUUID()));
    assert.equal(service.status().checkouts.length,0,'invalid location must be rejected before saving an unusable permanent invoice binding');
    assert.equal(creationCalls,0);
    malformed=false;
    const recovered=await service.create(invoice.id,randomUUID());
    assert.equal(recovered.status,'awaiting_payment');
  }finally{store.close();}
});

test('a late Square creation response cannot erase a receipt verified by an overlapping app instance',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'quiet-rails-overlap-'));const path=join(dir,'fictional.sqlite');
  const firstStore=new Store(path),secondStore=new Store(path);
  let releaseFirst!:(response:Response)=>void;let firstStarted!:()=>void;
  const started=new Promise<void>(resolve=>{firstStarted=resolve;});
  const delayedResponse=new Promise<Response>(resolve=>{releaseFirst=resolve;});
  const providerKeys:string[]=[];
  const first=new SquareSandbox(firstStore,{token:'synthetic-token-A',locationId:'loc-A',fetcher:provider(async(body)=>{providerKeys.push(body.idempotency_key);firstStarted();return delayedResponse;})},now);
  const second=new SquareSandbox(secondStore,{token:'synthetic-token-A',locationId:'loc-A',fetcher:provider(async(body)=>{providerKeys.push(body.idempotency_key);return Response.json({payment_link:link});})},now);
  let pending:Promise<any>|undefined;
  try{
    const invoice=createInvoice(firstStore,'owner',invoiceInput,now());
    pending=first.create(invoice.id,randomUUID());await started;
    const checkout=await second.create(invoice.id,randomUUID());
    const verified=await second.reconcile(checkout.id);assert.equal(verified.status,'paid');assert.ok(verified.receipt);
    releaseFirst(Response.json({payment_link:link}));await pending;
    assert.equal(new Set(providerKeys).size,1,'overlapping requests must retain one logical provider key');
    const final=first.publicView(checkout.token);
    assert.equal(final.status,'paid','late stale save must not regress a paid record to awaiting_payment');
    assert.deepEqual(final.receipt,verified.receipt);
    const persisted=firstStore.db.prepare('SELECT payment_id FROM square_test_checkouts WHERE id=?').get(checkout.id);
    assert.equal(persisted?.payment_id,'fixture-payment');
  }finally{
    releaseFirst(Response.json({payment_link:link}));await pending?.catch(()=>{});
    firstStore.close();secondStore.close();rmSync(dir,{recursive:true,force:true});
  }
});

test('Square failure recovery preserves the original key and location across a restart and configuration change',async(t)=>{
  const failures=[
    ['network timeout',()=>{throw new Error('synthetic-provider-secret');}],
    ['upstream rejection',()=>new Response('synthetic-provider-secret',{status:503})],
    ['invalid JSON',()=>new Response('{malformed')],
    ['partial success',()=>Response.json({payment_link:{id:'fixture-link'}})],
  ] as const;
  for(const [label,failure] of failures)await t.test(label,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'quiet-rails-recovery-'));const path=join(dir,'fictional.sqlite');
    const calls:any[]=[];let fail=true;let store=new Store(path);
    const fetcher=provider(async(body)=>{calls.push(body);if(fail){fail=false;return failure();}return Response.json({payment_link:link});});
    let service=new SquareSandbox(store,{token:'synthetic-token-A',locationId:'loc-A',fetcher},now);
    try{
      const invoice=createInvoice(store,'owner',invoiceInput,now());const retryKey=randomUUID();
      await assert.rejects(()=>service.create(invoice.id,retryKey),(error:any)=>error.status===502&&!error.message.includes('synthetic-provider-secret'));
      assert.equal(service.status().checkouts[0].status,'creation_pending');
      store.close();store=new Store(path);
      service=new SquareSandbox(store,{token:'synthetic-token-B',locationId:'loc-B',fetcher},now);
      assert.equal((await service.create(invoice.id,retryKey)).status,'awaiting_payment');
      assert.equal(calls.length,2);assert.equal(calls[0].idempotency_key,calls[1].idempotency_key);
      assert.equal(calls[1].quick_pay.location_id,'loc-A');assert.deepEqual(calls[1].quick_pay.price_money,{amount:125,currency:'CAD'});
      assert.equal(store.getInvoice(invoice.id,'owner')?.status,'open');assert.equal(store.listPayouts('owner').length,0);
    }finally{store.close();rmSync(dir,{recursive:true,force:true});}
  });
});

test('Square refuses malformed refund evidence instead of interpreting it as an unrefunded payment',async(t)=>{
  for(const refunded_money of [false,{},'unknown',{amount:null,currency:'CAD'},{amount:0,currency:'USD'}])await t.test(JSON.stringify(refunded_money),async()=>{
    const store=new Store(':memory:');const service=new SquareSandbox(store,{token:'synthetic-token-A',locationId:'loc-A',fetcher:provider(undefined,{...payment,refunded_money})},now);
    try{
      const invoice=createInvoice(store,'owner',invoiceInput,now());const checkout=await service.create(invoice.id,randomUUID());
      await assert.rejects(()=>service.reconcile(checkout.id));
      assert.equal(service.publicView(checkout.token).receipt,undefined);
    }finally{store.close();}
  });
});

test('Square HTTP clients always attach a bounded abort signal and reject redirects and provider error bodies',async(t)=>{
  for(const [label,response] of [['rejection',()=>new Response('synthetic-sensitive-body',{status:429})],['non JSON',()=>new Response('<html>synthetic-sensitive-body</html>')]] as const)await t.test(label,async()=>{
    const client=createSquareSandboxClient({token:'synthetic-token',locationId:'loc-A',fetcher:async(_url,init)=>{
      assert.equal(init?.redirect,'error');assert.ok(init?.signal instanceof AbortSignal);assert.equal(init.signal.aborted,false);
      return response();
    }});
    await assert.rejects(()=>client.createPaymentLink({amount:125,currency:'CAD',title:'Fictional',idempotencyKey:'fictional-key'}),(error:Error)=>!error.message.includes('synthetic-sensitive-body'));
  });
});

const wiseInput={recipientId:12,quoteId:'11144c35-9fe8-4c32-b7fd-d05c2a7734bf',customerTransactionId:'702d3526-1ce8-4afb-84d1-6c0a5c370955',reference:'FICTIONAL-001',fundingOrigin:'ordinary_fiat' as const};
const wiseTransfer={id:123,status:'incoming_payment_waiting',targetAccount:wiseInput.recipientId,quoteUuid:wiseInput.quoteId,customerTransactionId:wiseInput.customerTransactionId,details:{reference:wiseInput.reference},business:42,sourceCurrency:'CAD',targetCurrency:'CAD',sourceValue:1.25,targetValue:1.25};
function wise(value:unknown){return createWiseSandboxClient({token:'synthetic-provider-token',profileId:42,fetcher:async()=>Response.json(value)});}

test('Wise healthy quote and readback retain exact bindings without asserting delivery',async()=>{
  const quote={id:wiseInput.quoteId,sourceCurrency:'CAD',targetCurrency:'USD',sourceAmount:1.25,targetAmount:1};
  assert.deepEqual(await wise(quote).createQuote({amountMinor:125,sourceCurrency:'CAD',targetCurrency:'USD',fundingOrigin:'ordinary_fiat'}),quote);
  assert.deepEqual(await wise(wiseTransfer).getTransfer(123),wiseTransfer);
  assert.equal(wiseTransfer.status,'incoming_payment_waiting');
});

test('Wise rejects empty or mismatching successful quote responses',async(t)=>{
  const valid={id:wiseInput.quoteId,sourceCurrency:'CAD',targetCurrency:'USD',sourceAmount:1.25,targetAmount:1};
  for(const patch of [{id:''},{sourceCurrency:'USD'},{targetCurrency:'CAD'},{sourceAmount:100},{sourceAmount:null}])await t.test(JSON.stringify(patch),async()=>{
    await assert.rejects(()=>wise({...valid,...patch}).createQuote({amountMinor:125,sourceCurrency:'CAD',targetCurrency:'USD',fundingOrigin:'ordinary_fiat'}));
  });
});

test('Wise transfer creation validates returned identity, reference and binding instead of accepting a thin success',async(t)=>{
  for(const patch of [{id:0},{id:-1},{status:''},{targetAccount:13},{quoteUuid:'24df0d48-9b0c-4be9-9281-48c2cb31fc57'},{customerTransactionId:'276bf4fa-522c-4e24-a25a-197512175ef3'},{details:{reference:'OTHER'}},{business:43}])await t.test(JSON.stringify(patch),async()=>{
    await assert.rejects(()=>wise({...wiseTransfer,...patch}).createTransfer(wiseInput));
  });
  await t.test('partial response',async()=>{await assert.rejects(()=>wise({id:123,status:'incoming_payment_waiting'}).createTransfer(wiseInput));});
});

test('Wise transfer readback rejects a wrong transfer or a partial/error response',async(t)=>{
  for(const value of [{...wiseTransfer,id:124},{id:123},{errors:[{message:'synthetic-sensitive-body'}]},null])await t.test(JSON.stringify(value),async()=>{
    await assert.rejects(()=>wise(value).getTransfer(123));
  });
});

test('Wise retries reuse the supplied UUID, remain sandbox-only and never fund a prepared transfer',async()=>{
  const requests:{url:string;body:any}[]=[];let fail=true;
  const client=createWiseSandboxClient({token:'synthetic-provider-token',profileId:42,fetcher:async(url,init)=>{
    assert.equal(init?.redirect,'error');assert.ok(init?.signal instanceof AbortSignal);
    requests.push({url,body:JSON.parse(String(init?.body))});
    if(fail){fail=false;throw new Error('synthetic-sensitive-body');}return Response.json(wiseTransfer);
  }});
  await assert.rejects(()=>client.createTransfer(wiseInput),(error:Error)=>!error.message.includes('synthetic-sensitive-body'));
  const prepared=await client.createTransfer(wiseInput);assert.equal(prepared.status,'incoming_payment_waiting');
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  assert.equal(requests[1].url,'https://api.wise-sandbox.com/2026Q4/transfers');
  assert.equal(requests[1].body.customerTransactionId,wiseInput.customerTransactionId);
  assert.equal(requests.some(x=>x.url.endsWith('/payments')),false);
});
