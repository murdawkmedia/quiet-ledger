import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {quoteReceiving} from '../server/receiving-quote.js';
import {assertCase} from '../server/demo-agent-case.js';
import {renderDemoReply} from '../server/demo-agent-replies.js';
import {currencyScale,parseInvoiceAmount,formatInvoiceAmount,currencyAllowsMethod} from '../shared/invoice-options.js';
import {previewInvoiceCsv,CSV_PREVIEW_HEADERS} from '../shared/csv-preview.js';
import {CAD_REFERENCE_VALUATION} from '../shared/currency-report.js';
import type {DemoCase} from '../shared/demo-agents.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import type {Currency,Invoice} from '../shared/contracts.js';
import type {PaymentMethod} from '../shared/payment-methods.js';

// Whole-satoshi SAT coverage only. All data below is fictional; no provider,
// wallet, network or payment is contacted anywhere in this file.
const ownerToken='fictional-sat-invoices-owner-secret';
const satInput={customerName:'Fictional satoshi studio',title:'Whole-satoshi workshop',currency:'SAT',items:[{description:'Fictional recording',quantity:2,unitAmount:10500}],taxBps:0};
const cadInput={customerName:'Fictional fiat studio',title:'Fiat comparison workshop',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:25000}],taxBps:500};
async function owner(app:ReturnType<typeof createApp>){
 const agent=request.agent(app),login=await agent.post('/api/session/owner').send({token:ownerToken});
 return {agent,csrf:login.body.csrfToken,post:(path:string,body:object={},key:string=randomUUID())=>agent.post(path).set('X-CSRF-Token',login.body.csrfToken).set('Idempotency-Key',key).send(body)};
}
const pay=(app:ReturnType<typeof createApp>,token:string,key:string,method:string)=>request(app).post(`/api/checkout/${token}/pay`).set('Idempotency-Key',key).send({method});

test('SAT parses, formats and restricts settlement methods without fiat conversion',()=>{
 assert.equal(currencyScale('SAT'),1);
 assert.equal(parseInvoiceAmount('21000','SAT'),21000);
 for(const bad of ['21000.5','-1','','1e5','21 000','0.1'])assert.throws(()=>parseInvoiceAmount(bad,'SAT'),/whole-satoshi/);
 const formatted=formatInvoiceAmount(21000,'SAT');
 assert.equal(formatted,'21,000 sats');
 assert.equal(formatted.includes('$'),false);
 for(const method of ['bitcoin','lightning','liquid','cashu','ark'] as PaymentMethod[])assert.equal(currencyAllowsMethod('SAT',method),true);
 for(const method of ['card','bank','cash','interac','paypal','usdt','usdc','square','bank_transfer'] as PaymentMethod[])assert.equal(currencyAllowsMethod('SAT',method),false);
 for(const method of ['gift_card','coupon','no_charge'] as PaymentMethod[])assert.equal(currencyAllowsMethod('SAT',method),true);
 for(const currency of ['CAD','USD','KRW','EUR','GBP'] as Currency[])assert.equal(currencyAllowsMethod(currency,'card'),true);
 assert.equal(CAD_REFERENCE_VALUATION.satInvoices,'excluded_no_fiat_conversion');
});

test('SAT receiving quotes bind the exact invoice total with no network request',async()=>{
 const invoice={currency:'SAT',total:123456,amountSats:123456} as Invoice;
 let fetches=0;
 const fetcher=(async()=>{fetches++;throw new Error('SAT quotes must never contact a network source');}) as typeof fetch;
 for(const mode of ['live','test'] as const){
  const quote=await quoteReceiving(invoice,'bitcoin',mode,fetcher);
  assert.equal(quote.expectedAtomic,'123456');
  assert.equal(quote.cadEquivalent,undefined);
  assert.match(quote.source,/no fiat conversion/);
 }
 assert.equal(fetches,0);
 for(const mode of ['live','test'] as const){
  await assert.rejects(quoteReceiving(invoice,'card',mode,fetcher),/Bitcoin-native/);
  await assert.rejects(quoteReceiving(invoice,'usdt',mode,fetcher),/Bitcoin-native/);
 }
 assert.equal(fetches,0);
});

test('SAT invoices issue exact whole-satoshi totals, settle Bitcoin-natively and never fund CAD payouts',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken});
 try{
  const user=await owner(app);
  const invoice=(await user.post('/api/invoices',satInput)).body;
  assert.equal(invoice.currency,'SAT');assert.equal(invoice.total,21000);
  assert.equal(invoice.amountSats,21000);assert.equal(invoice.totalCad,undefined);assert.ok(!('totalCad' in invoice));
  // Schema guards: fractional satoshis and non-Bitcoin-native accepted methods never issue.
  assert.equal((await user.post('/api/invoices',{...satInput,items:[{description:'Fractional',quantity:1,unitAmount:1.5}]})).status,400);
  for(const method of ['card','bank','usdt'])assert.equal((await user.post('/api/invoices',{...satInput,acceptedMethods:[method]})).status,400);
  assert.equal((await user.post('/api/invoices',{...satInput,acceptedMethods:['bitcoin','lightning','gift_card']})).status,201);
  // Email preview states whole sats, never a fiat amount.
  const preview=await user.post(`/api/invoices/${invoice.id}/email`,{action:'preview',to:['client@example.test']});
  assert.equal(preview.status,200);assert.match(preview.body.text,/21,000 sats/);assert.equal(preview.body.text.includes('$'),false);
  // Checkout exposes the exact satoshi amount; fiat settlement is rejected before any effect.
  const checkout=await request(app).get(`/api/checkout/${invoice.token}`).expect(200);
  assert.equal(checkout.body.invoice.currency,'SAT');assert.equal(checkout.body.invoice.amountSats,21000);assert.equal(checkout.body.payment.amountSats,21000);
  const fiat=await pay(app,invoice.token,'sat-pay-fiat','card');
  assert.equal(fiat.status,400);assert.match(fiat.body.error,/Bitcoin-native or owner-reviewed noncash/);
  const paid=await pay(app,invoice.token,'sat-pay-once','bitcoin');
  assert.equal(paid.status,200);
  const receipt=(await request(app).get(`/api/receipts/${paid.body.receiptToken}`).expect(200)).body.receipt;
  assert.equal(receipt.amount,21000);assert.equal(receipt.currency,'SAT');assert.equal(receipt.mode,'simulation');
  // A CAD invoice in the same workspace keeps its reference totals; SAT stays excluded.
  const cad=(await user.post('/api/invoices',cadInput)).body;assert.equal(cad.totalCad,26250);
  const payout=await user.post('/api/payouts/quote',{invoiceId:invoice.id,provider:'bullbitcoin',destinationType:'bill',recipientLabel:'Fictional utility',amount:1000});
  assert.equal(payout.status,409);assert.match(payout.body.error,/no CAD reference value/);
  const dashboard=(await user.agent.get('/api/dashboard')).body;
  assert.equal(dashboard.totals.invoicedCad,26250);assert.equal(dashboard.totals.receivedCad,0);assert.equal(dashboard.totals.availableCad,0);
  assert.equal(dashboard.valuation.satInvoices,'excluded_no_fiat_conversion');
  // The paid SAT invoice reports under simulation; the open one awaits live receiving.
  const satSimulation=dashboard.currencyBalances.find((row:{currency:string;mode:string})=>row.currency==='SAT'&&row.mode==='simulation');
  assert.ok(satSimulation);assert.equal(satSimulation.issued,21000);assert.equal(satSimulation.paid,21000);assert.equal(satSimulation.due,0);
  const satOpen=dashboard.currencyBalances.find((row:{currency:string;mode:string})=>row.currency==='SAT'&&row.mode==='live');
  assert.ok(satOpen);assert.equal(satOpen.issued,21000);assert.equal(satOpen.due,21000);
  const cadRow=dashboard.currencyBalances.find((row:{currency:string})=>row.currency==='CAD');
  assert.equal(cadRow.issued,26250);
  // Export reports whole satoshis, never a fiat-style decimal.
  const csv=(await user.agent.get('/api/invoice-ledger/export.csv').expect(200)).text;
  assert.match(csv,/,"SAT","21000","21000","","0","0","0","0","0","21000","0","0","0","paid","simulation",/);assert.equal(csv.includes('210.00'),false);
  assert.match(csv,/,"CAD","262\.50","262\.50","","12\.50","12\.50","0\.00","0\.00","0\.00","0\.00","0\.00","262\.50","0\.00","unpaid","live",/);
 }finally{app.locals.close();}
});

test('SAT noncash reports settle whole satoshis with owner confirmation and no CAD reference',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken});
 try{
  const user=await owner(app);
  const invoice=(await user.post('/api/invoices',satInput)).body;
  const reported=await pay(app,invoice.token,'sat-report-once','gift_card');
  assert.equal(reported.status,200);assert.equal(reported.body.alreadyPaid,false);
  assert.equal(reported.body.report.method,'gift_card');assert.equal(reported.body.report.amount,21000);assert.equal(reported.body.report.currency,'SAT');
  const fiatReport=await pay(app,invoice.token,'sat-report-fiat','bank');
  assert.equal(fiatReport.status,400);assert.match(fiatReport.body.error,/Bitcoin-native or owner-reviewed noncash/);
  const confirmed=await user.post(`/api/payment-reports/${reported.body.report.id}/confirm`,{});
  assert.equal(confirmed.status,200);assert.equal(confirmed.body.invoice.status,'paid');assert.equal(confirmed.body.invoice.paymentMethod,'gift_card');
  const saved=(await user.agent.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(saved.status,'paid');assert.equal(saved.totalCad,undefined);
  const dashboard=(await user.agent.get('/api/dashboard')).body;
  assert.equal(dashboard.totals.receivedCad,0);assert.equal(dashboard.totals.availableCad,0);
 }finally{app.locals.close();}
});

test('live SAT receiving binds exact sats, rejects fiat rails before provider effects and records no CAD reference',async()=>{
 let creates=0,paid=false;const contexts:any[]=[];
 const adapter:ReceivingAdapter={id:'synthetic-sat-receiver',mode:'live',methods:['bitcoin','card'],
  create:async context=>{creates++;contexts.push(context);return {providerId:context.requestId,request:'lightning:lnbc210u1fixtureonly',network:'mainnet',asset:'BTC',allocationKey:`synthetic:${context.requestId}`};},
  check:async context=>paid?{status:'paid',paymentId:`synthetic-sat-payment:${context.requestId}`,amount:context.amount,currency:context.currency,reference:context.requestId}:{status:'pending'}};
 const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter]} as never);
 try{
  const user=await owner(app),invoice=(await user.post('/api/invoices',satInput)).body;
  // A fiat rail is rejected before the provider creates anything.
  const rejected=await user.post('/api/receiving',{invoiceId:invoice.id,method:'card',adapterId:adapter.id},'sat-receiving-fiat');
  assert.equal(rejected.status,409);assert.match(rejected.body.error,/Bitcoin-native receiving methods only/);assert.equal(creates,0);
  const created=await user.post('/api/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},'sat-receiving-create');
  assert.equal(created.status,201);assert.equal(creates,1);
  const context=contexts[0];
  assert.equal(context.currency,'SAT');assert.equal(context.amount,21000);assert.equal(context.expectedAtomic,'21000');
  const record=created.body.request;
  assert.equal(record.mode,'live');assert.equal(record.status,'awaiting_payment');
  // The saved quote is replayed without another creation or network quote.
  assert.equal((await user.post('/api/receiving',{invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id},'sat-receiving-create')).body.request.id,record.id);
  assert.equal(creates,1);
  assert.equal((await user.post(`/api/receiving/${record.id}/check`)).body.request.status,'awaiting_payment');
  paid=true;
  const verified=(await user.post(`/api/receiving/${record.id}/check`)).body.request;
  assert.equal(verified.status,'paid');assert.equal(verified.receipt.mode,'live');assert.equal(verified.receipt.method,'bitcoin');
  assert.deepEqual((await user.post(`/api/receiving/${record.id}/check`)).body.request.receipt,verified.receipt);
  const saved=(await user.agent.get(`/api/invoices/${invoice.id}`)).body;
  assert.equal(saved.status,'paid');assert.equal(saved.settlementMode,'live');assert.equal(saved.paymentMethod,'bitcoin');
  assert.equal(saved.totalCad,undefined);assert.ok(!('totalCad' in saved));
  assert.equal(saved.nativePayment.verification,'provider');assert.equal(saved.nativePayment.atomicAmount,'21000');
  const dashboard=(await user.agent.get('/api/dashboard')).body;
  assert.equal(dashboard.totals.invoicedCad,0);assert.equal(dashboard.totals.receivedCad,0);assert.equal(dashboard.totals.availableCad,0);
  assert.equal(dashboard.currencyBalances.find((row:{currency:string;mode:string})=>row.currency==='SAT'&&row.mode==='live').paid,21000);
  const payout=await user.post('/api/payouts/quote',{invoiceId:invoice.id,provider:'bullbitcoin',destinationType:'bill',recipientLabel:'Fictional utility',amount:1000});
  assert.equal(payout.status,409);assert.match(payout.body.error,/no CAD reference value/);
  const receipt=(await request(app).get(`/api/receipts/${saved.receiptToken}`).expect(200)).body.receipt;
  assert.equal(receipt.mode,'live');assert.equal(receipt.amount,21000);assert.equal(receipt.currency,'SAT');
 }finally{app.locals.close();}
});

test('recurring SAT templates issue exact whole-satoshi invoices without a CAD reference',async()=>{
 const app=createApp({dbPath:':memory:',ownerToken,now:()=>new Date('2026-11-06T12:00:00Z')});
 try{
  const user=await owner(app);
  const template=(await user.post('/api/invoice-templates',{label:'Fictional SAT retainer',draft:{customerName:'Fictional SAT client',title:'Fictional monthly sats',currency:'SAT',items:[{description:'Fictional monthly service',quantity:1,unitAmount:50000}],paymentTermDays:30}}).expect(201)).body.template;
  const plan=(await user.post('/api/recurring/plans',{templateId:template.id,label:'Fictional SAT retainers',startDate:'2026-09-30',frequency:{type:'monthly'}}).expect(201)).body.plan;
  assert.equal(plan.dueOffsetDays,30);
  const prepared=(await user.post('/api/recurring/prepare',{},'fictional-sat-prepare').expect(200)).body;
  assert.ok(prepared.drafts.length>=1);
  const record=prepared.drafts.find((row:{periodDate:string})=>row.periodDate==='2026-10-30');
  assert.equal(record.draft.currency,'SAT');
  const issued=(await user.post('/api/recurring/drafts/'+record.id+'/issue',{draft:record.draft},'fictional-sat-issue').expect(201)).body;
  assert.equal(issued.invoice.currency,'SAT');assert.equal(issued.invoice.total,50000);
  assert.equal(issued.invoice.amountSats,50000);assert.equal(issued.invoice.totalCad,undefined);assert.ok(!('totalCad' in issued.invoice));
 }finally{app.locals.close();}
});

test('SAT balance CSV preview parses whole satoshis and rejects fractional rows',()=>{
 const header=CSV_PREVIEW_HEADERS.join(',');
 const valid=previewInvoiceCsv([header,'QL-SAT-1,Fictional Studio,Whole-satoshi workshop,SAT,21000,21000,,0,0,0,0,0,21000,0,0,0,paid,simulation,2026-11-05,2026-11-20,'].join('\n'));
 assert.equal(valid.rows[0].classification,'new');
 assert.equal(valid.rows[0].record?.balance.currency,'SAT');assert.equal(valid.rows[0].record?.balance.total,21000);
 const fractional=previewInvoiceCsv([header,'QL-SAT-2,Fictional Studio,Whole-satoshi workshop,SAT,210.5,210.5,,0,0,0,0,0,0,0,0,0,unpaid,simulation,2026-11-05,2026-11-20,'].join('\n'));
 assert.equal(fractional.rows[0].classification,'invalid');
 assert.match(fractional.rows[0].issues.join(';'),/whole satoshi/);
 const unknown=previewInvoiceCsv([header,'QL-SAT-3,Fictional Studio,Whole-satoshi workshop,XBT,21000,21000,,0,0,0,0,0,0,0,21000,0,unpaid,simulation,2026-11-05,2026-11-20,'].join('\n'));
 assert.equal(unknown.rows[0].classification,'invalid');
 assert.match(unknown.rows[0].issues.join(';'),/Currency must be/);
});

test('fictional SAT demo cases verify and render whole-satoshi facts',()=>{
 const context:DemoCase={fictional:true,currency:'SAT',lineAmount:21000,tax:0,total:21000,status:'open',settlementMode:'simulation',receiptRecorded:false,version:1,asOf:'2026-11-06T00:00:00.000Z'};
 assert.doesNotThrow(()=>assertCase(context));
 const reply=renderDemoReply('accountant','check-total',context);
 assert.match(reply,/SAT 21,000/);assert.equal(reply.includes('$'),false);
 const paidContext:DemoCase={...context,status:'paid',receiptRecorded:true,version:2};
 assert.doesNotThrow(()=>assertCase(paidContext));
 assert.match(renderDemoReply('accountant','explain-recorded-status',paidContext),/SAT 21,000/);
});
