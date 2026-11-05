import test from 'node:test';
import assert from 'node:assert/strict';
import type {ReceivingContext} from '../shared/receiving.js';
const context:ReceivingContext={requestId:'fictional-request',method:'card',amount:1234,currency:'CAD',expectedAtomic:'1234',idempotencyKey:'fictional-key',mode:'live',createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString()};
function fixture(changes:{payment?:Record<string,unknown>;order?:Record<string,unknown>;location?:Record<string,unknown>;url?:string}={}){
  const calls:{url:string;init:RequestInit;body?:any}[]=[];let saved:any,orderReads=0;
  const config={id:'conn-square-fictional',mode:'live' as 'live'|'test',accessToken:'fictional-token',locationId:'LOCATION123',merchantId:'MERCHANT123',merchantCountry:'CA',currency:'CAD' as const,publicOrigin:'https://ledger.example.com',fetcher:async(url:string,init:RequestInit={})=>{
    const body=init.body?JSON.parse(String(init.body)):undefined;calls.push({url,init,body});
    if(url.includes('/locations/'))return Response.json({location:{id:'LOCATION123',merchant_id:'MERCHANT123',country:'CA',currency:'CAD',status:'ACTIVE',capabilities:['CREDIT_CARD_PROCESSING'],...changes.location}});
    if(body){saved=body;return Response.json({payment_link:{id:'LINK123',order_id:'ORDER123',url:changes.url??(config.mode==='live'?'https://square.link/u/FICTIONAL':'https://sandbox.square.link/u/FICTIONAL')}});}
    const order={...saved?.order,id:'ORDER123',state:'COMPLETED',total_money:{amount:1234,currency:'CAD'},net_amount_due_money:{amount:0,currency:'CAD'},tenders:[{id:'TENDER123',payment_id:'PAYMENT123',type:'CARD',location_id:'LOCATION123',amount_money:{amount:1234,currency:'CAD'}}],...(orderReads++>0?changes.order:{})};
    if(url.includes('/orders/'))return Response.json({order});
    return Response.json({payment:{id:'PAYMENT123',status:'COMPLETED',order_id:'ORDER123',location_id:'LOCATION123',amount_money:{amount:1234,currency:'CAD'},total_money:{amount:1234,currency:'CAD'},source_type:'CARD',card_details:{status:'CAPTURED'},note:saved.payment_note,refunded_money:{amount:0,currency:'CAD'},...changes.payment}});
  }};
  return {config,calls};
}
test('Square receiving verifies location read-only and creates idempotent hosted links with exact order bindings',async()=>{
  const mod=await import('../integrations/square-receiving.js').catch(()=>({})) as any;
  assert.equal(typeof mod.createSquareReceivingAdapter,'function','Square receiving adapter must exist');
  const f=fixture();await mod.verifySquareReceivingConnection(f.config);assert.equal(f.calls.length,1);assert.equal(f.calls[0].init.method,'GET');
  const adapter=mod.createSquareReceivingAdapter(f.config),intent=await adapter.create(context);
  assert.equal(intent.url,'https://square.link/u/FICTIONAL');assert.equal(intent.providerId,'ORDER123');assert.equal(adapter.mode,'live');
  await mod.createSquareReceivingAdapter(f.config).create(context);
  const posts=f.calls.filter(row=>row.init.method==='POST');assert.equal(posts.length,2);assert.equal(posts[0].body.idempotency_key,posts[1].body.idempotency_key);
  assert.equal(posts[0].body.order.metadata.receive_request,context.requestId);assert.equal(posts[0].body.order.location_id,'LOCATION123');assert.equal(posts[0].body.checkout_options.allow_tipping,false);
  assert.deepEqual(await adapter.check(context,intent),{status:'paid',paymentId:'square:MERCHANT123:PAYMENT123',reference:context.requestId,amount:1234,currency:'CAD'});
  assert.equal(f.calls.some(row=>/complete|capture|refund|cancel/.test(new URL(row.url).pathname)),false);
});
test('Square sandbox receiving uses distinct API/checkout origins and rejects cross-mode intent',async()=>{
  const {createSquareReceivingAdapter}=await import('../integrations/square-receiving.js') as any;
  const f=fixture();f.config.mode='test';const adapter=createSquareReceivingAdapter(f.config),intent=await adapter.create({...context,mode:'test'});
  assert.match(intent.url,/^https:\/\/sandbox.square.link\//);assert.equal(f.calls.every(row=>new URL(row.url).origin==='https://connect.squareupsandbox.com'),true);
  await assert.rejects(()=>adapter.create(context));
});
test('Square exact readback rejects partial, refunded, uncaptured, wrong account and multiple-tender evidence',async()=>{
  const {createSquareReceivingAdapter}=await import('../integrations/square-receiving.js') as any;
  const changes:Parameters<typeof fixture>[0][]=[{payment:{status:'APPROVED'}},{payment:{refunded_money:{amount:1,currency:'CAD'}}},{payment:{refund_ids:['refund']}},{payment:{card_details:{status:'AUTHORIZED'}}},{payment:{total_money:{amount:1300,currency:'CAD'}}},{payment:{location_id:'ANOTHER'}},{payment:{order_id:'ANOTHER'}},{payment:{id:'ANOTHER'}},{payment:{note:'wrong'}},{order:{tenders:[{},{}]}},{order:{returns:[{}]}},{order:{metadata:{receive_request:'different'}}},{order:{net_amount_due_money:{amount:1,currency:'CAD'}}}];
  for(const change of changes){const f=fixture(change),adapter=createSquareReceivingAdapter(f.config),intent=await adapter.create(context);assert.notEqual((await adapter.check(context,intent)).status,'paid',JSON.stringify(change));}
  for(const location of [{merchant_id:'ANOTHER'},{country:'US'},{status:'INACTIVE'},{capabilities:[]}]){const f=fixture({location});await assert.rejects(()=>createSquareReceivingAdapter(f.config).create(context));}
});
test('Square checkout never follows provider-supplied nonofficial URLs',async()=>{
  const {createSquareReceivingAdapter}=await import('../integrations/square-receiving.js') as any;
  for(const url of ['https://attacker.example/u/a','http://square.link/u/a','https://square.link:8443/u/a','https://user:secret@square.link/u/a']){const f=fixture({url});await assert.rejects(()=>createSquareReceivingAdapter(f.config).create(context));}
});
