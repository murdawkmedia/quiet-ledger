import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store,DomainError} from '../server/store.js';
import {ReceivingService} from '../server/receiving-service.js';
import {quoteReceiving} from '../server/receiving-quote.js';
import {HackathonDemo} from '../server/hackathon-demo.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {DemoLivePayments} from '../server/demo-live-payment.js';
import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';
import type {DemoLivePaymentView,DemoLiveRequest} from '../shared/demo-live-payment.js';
import {sanitizeDemoLiveRequest} from '../shared/demo-live-payment.js';

// Explicitly fictional fixtures only: names, receivers, invoices and provider values
// below describe no real account, wallet, key or payment.
const RECEIVER='fictional-receiver@coinos.test';
const SATS=21;

function fixture(){
  const state={creates:0,checks:0,paid:false,failCreation:false,lastContext:null as ReceivingContext|null};
  const adapter:ReceivingAdapter={
    id:'coinos-pos-fixture',mode:'live',methods:['lightning'],
    create:async(context:ReceivingContext):Promise<ReceivingIntent>=>{
      state.creates++;
      if(state.failCreation)throw Object.assign(new Error('synthetic upstream unavailable'),{code:'LNURL_CREATION_UNCERTAIN'});
      return {providerId:`fixture-${context.requestId}`,request:`lightning:lnbc210n1fictional${context.requestId.replaceAll('-','').slice(0,12)}`,network:'mainnet',asset:'BTC',cashuWalletHandoff:true,expiresAt:context.expiresAt,allocationKey:`fixture-allocation-${context.requestId}`,opaque:{terminalSecret:'must-never-be-public'}};
    },
    check:async(context:ReceivingContext):Promise<ReceivingObservation>=>{
      state.checks++;state.lastContext=context;
      return state.paid?{status:'paid',paymentId:'fixture-payment-1',amount:context.amount,currency:context.currency,reference:context.requestId}:{status:'pending'};
    },
  };
  return {adapter,state};
}

function environment(){
  const store=new Store(':memory:');
  const {adapter,state}=fixture();
  const receiving=new ReceivingService(store,[adapter],quoteReceiving,()=>new Date());
  const demo=new HackathonDemo({store});
  const live=new DemoLivePayments({store,receiving,adapterId:adapter.id,receiver:RECEIVER,validVisit:workspace=>demo.hasWorkspace(workspace)});
  return {store,receiving,demo,live,state};
}
const startVisit=(env:ReturnType<typeof environment>)=>env.demo.start('marmot','fictional-test-client');

test('enabled view offers exactly the 21-sat lightning sample with no request before reserving',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    const view=env.live.view(visit.workspace);
    assert.deepEqual(view,{enabled:true,receiver:RECEIVER,amountSats:21,rail:'lightning'});
    assert.equal(view.request,undefined);
  }finally{env.store.close();}
});

test('create requires acknowledgement, a bounded key and a current visit on every method',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    let openWorkspace=visit.workspace;
    const gated=new DemoLivePayments({store:env.store,receiving:env.receiving,adapterId:'coinos-pos-fixture',receiver:RECEIVER,validVisit:workspace=>workspace===openWorkspace});
    await assert.rejects(gated.create(openWorkspace,false,'fictional-key-one'),(error:DomainError)=>error.status===400);
    await assert.rejects(gated.create(openWorkspace,true,'not a valid key'),(error:DomainError)=>error.status===400);
    openWorkspace='';
    assert.throws(()=>gated.view(visit.workspace),(error:DomainError)=>error.status===403);
    await assert.rejects(gated.create(visit.workspace,true,'fictional-key-one'),(error:DomainError)=>error.status===403);
    await assert.rejects(gated.check(visit.workspace),(error:DomainError)=>error.status===403);
    assert.equal(env.state.creates,0);
    assert.equal(JSON.stringify(env.store.db.prepare('SELECT COUNT(*) AS n FROM demo_live_payment_samples').get()!.n),'0');
  }finally{env.store.close();}
});

test('one reserved invoice and request survives different client keys, concurrency and repeated calls',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    const first=await env.live.create(visit.workspace,true,'first-click-key');
    const second=await env.live.create(visit.workspace,true,'another-click-key');
    const concurrent=await Promise.allSettled([env.live.create(visit.workspace,true,'third-key'),env.live.create(visit.workspace,true,'fourth-key')]);
    const ids=[first,second,...concurrent.map(result=>result.status==='fulfilled'?result.value:{request:undefined})].map(view=>view.request?.id);
    assert.ok(ids.every(id=>id&&id===ids[0]));
    assert.equal(env.state.creates,1);
    const liveWorkspace=env.store.db.prepare('SELECT live_workspace AS ws FROM demo_live_payment_samples WHERE demo_workspace=?').get(visit.workspace)!.ws as string;
    assert.notEqual(liveWorkspace,visit.workspace);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests WHERE workspace=?').get(liveWorkspace)!.n,1);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM invoices WHERE workspace=?').get(liveWorkspace)!.n,1);
    const request=first.request!;
    assert.equal(request.amount,21);
    assert.equal(request.currency,'SAT');
    assert.equal(request.method,'lightning');
    assert.equal(request.mode,'live');
    assert.equal(request.expectedAtomic,'21');
    assert.equal(env.receiving.read(request.id,liveWorkspace).status,'awaiting_payment');
  }finally{env.store.close();}
});

test('views expose only the sanitized public request fields',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    const view=await env.live.create(visit.workspace,true,'fictional-sanitize-key');
    const request=view.request as DemoLiveRequest;
    const allowed=['amount','createdAt','creationUncertain','currency','expectedAtomic','expiresAt','id','intent','method','mode','reviewReason','receipt','status'];
    assert.ok(Object.keys(request).every(key=>allowed.includes(key)),`unexpected field ${Object.keys(request).find(key=>!allowed.includes(key))}`);
    assert.deepEqual(Object.keys(request.intent!).sort(),['asset','cashuWalletHandoff','expiresAt','network','request'].sort());
    const serialized=JSON.stringify(view);
    for(const forbidden of ['terminalSecret','fixture-allocation','quote','adapterId','providerId','coinos-pos-fixture','token'])assert.ok(!serialized.includes(forbidden),`leaked ${forbidden}`);
    const again=env.live.view(visit.workspace);
    assert.deepEqual(again.request,request);
  }finally{env.store.close();}
});

test('uncertain creation fails closed after a restart and never recreates automatically',async()=>{
  const env=environment();
  try{
    env.state.failCreation=true;
    const visit=startVisit(env);
    await assert.rejects(env.live.create(visit.workspace,true,'fictional-uncertain-key'),(error:DomainError)=>error.status===502||error.status===409);
    assert.equal(env.state.creates,1);
    const restarted=new DemoLivePayments({store:env.store,receiving:env.receiving,adapterId:'coinos-pos-fixture',receiver:RECEIVER,validVisit:workspace=>env.demo.hasWorkspace(workspace)});
    await assert.rejects(restarted.create(visit.workspace,true,'fictional-uncertain-key'),(error:DomainError)=>error.status===409);
    await assert.rejects(restarted.create(visit.workspace,true,'a-different-key'),(error:DomainError)=>error.status===409);
    assert.equal(env.state.creates,1);
    const view=restarted.view(visit.workspace);
    assert.equal(view.request?.status,'creation_pending');
    assert.equal(view.request?.creationUncertain,true);
  }finally{env.store.close();}
});

test('provider-only check records exactly one live lightning receipt and never touches the simulated case',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    const demoBefore=env.demo.view(visit.workspace);
    const created=await env.live.create(visit.workspace,true,'fictional-paid-key');
    const demoAfter=env.demo.view(visit.workspace);
    assert.equal(demoAfter.invoice.id,demoBefore.invoice.id);
    assert.equal(demoAfter.invoice.currency,'CAD');
    assert.equal(demoAfter.invoice.settlementMode,'simulation');
    env.state.paid=true;
    const checked=await env.live.check(visit.workspace);
    assert.equal(checked.request?.status,'paid');
    assert.deepEqual(checked.request?.receipt,{number:`PAY-${created.request!.id}`,mode:'live',method:'lightning',amount:21,currency:'SAT',verifiedAt:checked.request!.receipt!.verifiedAt});
    assert.equal(env.state.lastContext?.requestId,created.request!.id);
    const again=await env.live.check(visit.workspace);
    assert.deepEqual(again.request?.receipt,checked.request?.receipt);
    const paidInvoice=env.store.getInvoice(env.store.db.prepare('SELECT invoice_id AS id FROM demo_live_payment_samples WHERE demo_workspace=?').get(visit.workspace)!.id as string);
    assert.equal(paidInvoice?.nativePayment?.verification,'provider');
    const simulated=env.demo.simulatePayment(visit.workspace);
    assert.equal(simulated.invoice.status,'paid');
    assert.equal(simulated.invoice.settlementMode,'simulation');
    const liveStill=env.live.view(visit.workspace);
    assert.equal(liveStill.request?.status,'paid');
  }finally{env.store.close();}
});

test('visits are isolated: another visit sees no request and cannot read the first sample',async()=>{
  const env=environment();
  try{
    const first=startVisit(env),second=startVisit(env);
    const created=await env.live.create(first.workspace,true,'fictional-isolation-key');
    const other=env.live.view(second.workspace);
    assert.equal(other.request,undefined);
    assert.throws(()=>env.receiving.read(created.request!.id,second.workspace),(error:DomainError)=>error.status===404);
    const secondSample=await env.live.create(second.workspace,true,'fictional-second-key');
    assert.notEqual(secondSample.request!.id,created.request!.id);
  }finally{env.store.close();}
});

test('demo cleanup cannot cascade into the live workspace; mapping is immutable with a 256 cap',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    await env.live.create(visit.workspace,true,'fictional-retention-key');
    env.demo.start('marmot','fictional-other-client');
    const liveWorkspace=env.store.db.prepare('SELECT live_workspace AS ws FROM demo_live_payment_samples WHERE demo_workspace=?').get(visit.workspace)!.ws as string;
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests WHERE workspace=?').get(liveWorkspace)!.n,1);
    assert.throws(()=>env.store.db.prepare('UPDATE demo_live_payment_samples SET retry_key=?').run('tampered'),/immutable/i);
    assert.throws(()=>env.store.db.prepare('DELETE FROM demo_live_payment_samples').run(),/immutable/i);
    const fill=env.store.encode({kind:'fictional-filler'},'demo_live_payment_samples','filler','filler');
    for(let index=0;index<256;index++){
      env.store.db.prepare('INSERT INTO demo_live_payment_samples(id,demo_workspace,live_workspace,invoice_id,retry_key,created_at,data) VALUES(?,?,?,?,?,?,?)')
        .run(`filler-${index}`,`demo-${index}`,`live-${index}`,`invoice-${index}`,`key-${index}`,'2026-01-01T00:00:00.000Z',fill);
    }
    const fresh=startVisit(env);
    const invoicesBefore=env.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n;
    await assert.rejects(env.live.create(fresh.workspace,true,'fictional-cap-key'),(error:DomainError)=>error.status===503);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM invoices').get()!.n,invoicesBefore);
  }finally{env.store.close();}
});

test('raw encrypted database rows carry no payload plaintext',async()=>{
  const store=new Store(':memory:',{encryptionKey:randomBytes(32)});
  try{
    const {adapter}=fixture();
    const receiving=new ReceivingService(store,[adapter],quoteReceiving,()=>new Date());
    const demo=new HackathonDemo({store});
    const live=new DemoLivePayments({store,receiving,adapterId:adapter.id,receiver:RECEIVER,validVisit:workspace=>demo.hasWorkspace(workspace)});
    const visit=demo.start('marmot','fictional-encrypted-client');
    const view=await live.create(visit.workspace,true,'fictional-encrypted-key');
    const raw=(table:string)=>store.db.prepare(`SELECT data FROM ${table}`).all().map((row:any)=>String(row.data)).join('\n');
    const blob=raw('demo_live_payment_samples')+'\n'+raw('receiving_requests')+'\n'+raw('invoices');
    for(const secret of [RECEIVER,'lnbc',view.request!.id,'fixture-payment-1'])assert.ok(!blob.includes(secret),`plaintext ${secret} found in raw rows`);
    const row=store.db.prepare('SELECT demo_workspace AS d, live_workspace AS l, data FROM demo_live_payment_samples LIMIT 1').get()!;
    const decoded=store.decode<any>(row.data,'demo_live_payment_samples',String(row.d),String(row.l));
    assert.equal(decoded.demoWorkspace,visit.workspace);
    assert.equal(typeof decoded.retryKey,'string');
    assert.equal(typeof decoded.invoiceId,'string');
  }finally{store.close();}
});

test('encrypted file close/reopen preserves the original invoice, retry key and provider effect',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'demo-restart-')),path=join(directory,'ledger.db'),encryptionKey=randomBytes(32);
  const {adapter,state}=fixture();
  let store=new Store(path,{encryptionKey});
  const connect=()=>{
    const receiving=new ReceivingService(store,[adapter],quoteReceiving,()=>new Date());
    const demo=new HackathonDemo({store});
    return {demo,live:new DemoLivePayments({store,receiving,adapterId:adapter.id,receiver:RECEIVER,validVisit:workspace=>demo.hasWorkspace(workspace)})};
  };
  try{
    const first=connect(),visit=first.demo.start('marmot','fictional-restart-client');
    const created=await first.live.create(visit.workspace,true,'first-restart-click');
    const mapping=store.db.prepare('SELECT * FROM demo_live_payment_samples').get()!;
    store.close();store=new Store(path,{encryptionKey});
    const reopened=connect();
    assert.deepEqual(reopened.live.view(visit.workspace).request,created.request);
    assert.deepEqual((await reopened.live.create(visit.workspace,true,'different-restart-click')).request,created.request);
    assert.deepEqual(store.db.prepare('SELECT * FROM demo_live_payment_samples').get(),mapping);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests').get()!.n,1);
    assert.equal(state.creates,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('simultaneous first clicks reserve only one mapping, invoice and provider request',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);
    const views=await Promise.all([env.live.create(visit.workspace,true,'race-one'),env.live.create(visit.workspace,true,'race-two')]);
    assert.equal(views[0].request!.id,views[1].request!.id);
    assert.equal(env.state.creates,1);
    assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM demo_live_payment_samples').get()!.n,1);
  }finally{env.store.close();}
});

test('corrupt or mismatched authenticated mapping fails closed without a replacement or provider effect',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env);await env.live.create(visit.workspace,true,'corruption-first');
    const row=env.store.db.prepare('SELECT * FROM demo_live_payment_samples').get()!;
    const original=JSON.parse(String(row.data));
    env.store.db.exec('DROP TRIGGER demo_live_payment_samples_no_update');
    for(const changed of [{...original,kind:'wrong'}, {...original,invoiceId:randomUUID()}, {...original,retryKey:'different-key'}, {...original,createdAt:'invalid'}, null]){
      env.store.db.prepare('UPDATE demo_live_payment_samples SET data=?').run(JSON.stringify(changed));
      assert.throws(()=>env.live.view(visit.workspace));
      await assert.rejects(env.live.create(visit.workspace,true,'corruption-retry'));
      await assert.rejects(env.live.check(visit.workspace));
      assert.equal(env.state.creates,1);assert.equal(env.state.checks,0);
      assert.equal(env.store.db.prepare('SELECT COUNT(*) AS n FROM demo_live_payment_samples').get()!.n,1);
    }
  }finally{env.store.close();}
});

test('public shape rejects changed economics, invalid intent and invalid paid receipts',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env),view=await env.live.create(visit.workspace,true,'invalid-shapes');
    const source=view.request!;
    for(const changed of [{amount:22},{currency:'USD'},{mode:'test'},{method:'cashu'},{expectedAtomic:'22'},{expiresAt:'invalid'},
      {status:'paid'},{receipt:{number:'fake',mode:'live',method:'lightning',amount:21,currency:'SAT',verifiedAt:source.createdAt}},
      {intent:{...source.intent,network:'testnet'}},{intent:{...source.intent,request:'javascript:alert(1)'}},
      {status:'paid',receipt:{number:'unbound-receipt',mode:'live',method:'lightning',amount:21,currency:'SAT',verifiedAt:source.createdAt}},
      {status:'paid',receipt:{number:'fake',mode:'live',method:'lightning',amount:22,currency:'SAT',verifiedAt:source.createdAt}}]){
      assert.throws(()=>sanitizeDemoLiveRequest({...source,...changed} as any),JSON.stringify(changed));
    }
  }finally{env.store.close();}
});

test('uncertain encrypted creation survives a genuine service and file restart without another provider call',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'demo-uncertain-')),path=join(directory,'ledger.db'),encryptionKey=randomBytes(32);
  const {adapter,state}=fixture();state.failCreation=true;
  let store=new Store(path,{encryptionKey});
  const connect=()=>{
    const receiving=new ReceivingService(store,[adapter],quoteReceiving,()=>new Date()),demo=new HackathonDemo({store});
    return {demo,live:new DemoLivePayments({store,receiving,adapterId:adapter.id,receiver:RECEIVER,validVisit:workspace=>demo.hasWorkspace(workspace)})};
  };
  try{
    const first=connect(),visit=first.demo.start('marmot','fictional-uncertain-restart');
    await assert.rejects(first.live.create(visit.workspace,true,'uncertain-original'));
    const original=first.live.view(visit.workspace).request!;
    store.close();store=new Store(path,{encryptionKey});
    const next=connect();assert.deepEqual(next.live.view(visit.workspace).request,original);
    await assert.rejects(next.live.create(visit.workspace,true,'uncertain-new-click'),(error:DomainError)=>error.status===409);
    assert.equal(next.live.view(visit.workspace).request!.id,original.id);assert.equal(state.creates,1);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM demo_live_payment_samples').get()!.n,1);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('encrypted ciphertext swaps and authenticated column mismatches fail closed',async()=>{
  const store=new Store(':memory:',{encryptionKey:randomBytes(32)}),{adapter,state}=fixture();
  try{
    const receiving=new ReceivingService(store,[adapter],quoteReceiving,()=>new Date()),demo=new HackathonDemo({store});
    const live=new DemoLivePayments({store,receiving,adapterId:adapter.id,receiver:RECEIVER,validVisit:workspace=>demo.hasWorkspace(workspace)});
    const a=demo.start('marmot','fictional-a'),b=demo.start('marmot','fictional-b');
    await live.create(a.workspace,true,'encrypted-a');await live.create(b.workspace,true,'encrypted-b');
    const row=store.db.prepare('SELECT * FROM demo_live_payment_samples WHERE demo_workspace=?').get(a.workspace)!;
    const foreign=store.db.prepare('SELECT data FROM demo_live_payment_samples WHERE demo_workspace=?').get(b.workspace)!;
    store.db.exec('DROP TRIGGER demo_live_payment_samples_no_update');
    store.db.prepare('UPDATE demo_live_payment_samples SET data=? WHERE demo_workspace=?').run(foreign.data,a.workspace);
    assert.throws(()=>live.view(a.workspace),(error:DomainError)=>error.status===409);
    await assert.rejects(live.create(a.workspace,true,'swapped-retry'));
    store.db.prepare('UPDATE demo_live_payment_samples SET data=?,retry_key=? WHERE demo_workspace=?').run(row.data,'changed-column',a.workspace);
    assert.throws(()=>live.view(a.workspace),(error:DomainError)=>error.status===409);
    await assert.rejects(live.check(a.workspace));assert.equal(state.creates,2);assert.equal(state.checks,0);
  }finally{store.close();}
});

test('actual 30-day demo cleanup preserves real invoice, receipt, request and immutable mapping',async()=>{
  const store=new Store(':memory:',{encryptionKey:randomBytes(32)}),{adapter,state}=fixture();
  let clock=new Date('2026-11-17T12:00:00.000Z');
  try{
    const receiving=new ReceivingService(store,[adapter],quoteReceiving,()=>clock),demo=new HackathonDemo({store,now:()=>clock});
    const live=new DemoLivePayments({store,receiving,adapterId:adapter.id,receiver:RECEIVER,validVisit:workspace=>demo.hasWorkspace(workspace),now:()=>clock});
    const visit=demo.start('marmot','fictional-cleanup');await live.create(visit.workspace,true,'retained-original');state.paid=true;await live.check(visit.workspace);
    const row=store.db.prepare('SELECT * FROM demo_live_payment_samples').get()!;
    clock=new Date(clock.getTime()+31*86400000);demo.start('marmot','fictional-after-retention');
    assert.equal(store.listInvoices(visit.workspace).length,0);assert.throws(()=>live.view(visit.workspace),(error:DomainError)=>error.status===403);
    const invoice=store.getInvoice(String(row.invoice_id),String(row.live_workspace))!;
    assert.equal(invoice.status,'paid');
    assert.equal(new InvoiceLedger(store).getReceipt(invoice.receiptToken!)!.receipt.nativePayment!.verification,'provider');
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM receiving_requests WHERE workspace=?').get(row.live_workspace)!.n,1);
    assert.deepEqual(store.db.prepare('SELECT * FROM demo_live_payment_samples').get(),row);
    assert.equal(state.creates,1);
  }finally{store.close();}
});

test('manual live confirmation cannot masquerade as the provider-verified sample',async()=>{
  const env=environment();
  try{
    const visit=startVisit(env),created=await env.live.create(visit.workspace,true,'manual-denied');
    const row=env.store.db.prepare('SELECT live_workspace FROM demo_live_payment_samples').get()!;
    env.receiving.confirm(created.request!.id,String(row.live_workspace),'Fictional manual review','fictional-manual-reference');
    assert.throws(()=>env.live.view(visit.workspace),(error:DomainError)=>error.status===409);
    await assert.rejects(env.live.check(visit.workspace),(error:DomainError)=>error.status===409);
    assert.equal(env.state.checks,0);
  }finally{env.store.close();}
});
