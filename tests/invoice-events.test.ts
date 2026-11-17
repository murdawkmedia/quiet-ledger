import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../server/store.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {createInvoice,settleInvoice} from '../server/domain.js';
import {ReceivingService} from '../server/receiving-service.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import type {ReceivingQuote} from '../server/receiving-service.js';
import type {Invoice,Receipt} from '../shared/contracts.js';
import type {InvoiceLedgerEntry} from '../shared/invoice-ledger.js';

const implementation=await import('../server/invoice-events.js').catch(()=>undefined);
assert(implementation,'Invoice events are not implemented.');
const {InvoiceEvents}=implementation;

const KEY=Buffer.alloc(32,77),T0=new Date('2026-11-08T12:00:00Z');
const WS='fictional-events-owner',OTHER='fictional-events-other',RACE='fictional-events-race';
const input={customerName:'Fictional Studio',customerEmail:'private@fictional.example',note:'Fictional private note',title:'Fictional events project',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:1000}]};
const EVENT_KEYS=['currency','effectiveTotal','id','invoiceId','mode','occurredAt','payment','seq','total','type'];
const clock=()=>{let tick=0;return ()=>new Date(Date.parse('2026-11-08T12:00:00Z')+tick++*60000);};
const quoteFor=(invoice:Invoice):Promise<ReceivingQuote>=>Promise.resolve({expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.total,source:'fictional exact quote',observedAt:'2026-11-08T12:00:00.000Z'});
const paidAdapter=(paid:Set<string>):ReceivingAdapter=>({id:'fictional-live',mode:'live',methods:['lightning'],
  create:async context=>({providerId:'fictional-provider-'+context.requestId,asset:'BTC',network:'mainnet'}),
  check:async context=>paid.has(context.requestId)?{status:'paid',paymentId:'fictional-payment-'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'}});

function service(store:Store){
  const paid=new Set<string>(),now=clock();
  const receiving=new ReceivingService(store,[paidAdapter(paid)],quoteFor,now);
  return {store,receiving,events:new InvoiceEvents(store),ledger:new InvoiceLedger(store),paid,now,close:()=>store.close()};
}
const fixture=(path=':memory:')=>service(new Store(path,{encryptionKey:KEY}));
const issue=(store:Store,workspace:string,changes:object={})=>createInvoice(store,workspace,{...input,...changes},T0);
async function receive(f:ReturnType<typeof service>,workspace:string,inv:Invoice,amount:number,agreementId?:string){
  const view=await f.receiving.create(workspace,{invoiceId:inv.id,method:'lightning',adapterId:'fictional-live',amount,...(agreementId?{agreementId}:{})},randomUUID());
  f.paid.add(view.id);await f.receiving.check(view.id,workspace);return view;
}
const rows=(store:Store,workspace:string)=>store.db.prepare('SELECT id,workspace,sequence,data FROM invoice_events WHERE workspace=? ORDER BY sequence').all(workspace);
const head=(store:Store,workspace:string)=>Number(store.db.prepare('SELECT last_sequence AS n FROM invoice_event_heads WHERE workspace=?').get(workspace)?.n??0);
const expectedId=(workspace:string,type:string,sourceId:string)=>'evt_'+createHash('sha256').update('invoice-event-v1\0'+workspace+'\0'+type+'\0'+sourceId).digest('hex').slice(0,32);
function buildPayment(f:ReturnType<typeof service>,workspace:string,inv:Invoice,amount:number,mode:'live'|'simulation'='live'){
  const createdAt=f.now().toISOString(),id=randomUUID();
  const entry:InvoiceLedgerEntry={id,kind:'payment',amount,currency:inv.currency,createdAt,method:'lightning',verification:'provider'};
  const receipt:Receipt={number:'PAY-'+id,issuedAt:createdAt,mode,method:'lightning',amount,currency:inv.currency,invoiceNumber:inv.number,title:inv.title,customerName:inv.customerName};
  return {entry,receipt};
}
function directPayment(f:ReturnType<typeof service>,workspace:string,inv:Invoice,amount:number,mode:'live'|'simulation'='live'){
  const {entry,receipt}=buildPayment(f,workspace,inv,amount,mode);
  f.ledger.payment(workspace,inv,'fictional-receiving-'+entry.id,entry,receipt);
  return {entry,receipt};
}
const forge=(text:string)=>Buffer.from(text,'utf8').toString('base64url');

test('live ledger payments append encrypted whitelist events with stable ids and per-workspace sequences',async()=>{
  const f=fixture();try{
  const inv=issue(f.store,WS);
  const empty=f.events.page(WS,25);
  assert.deepEqual(Object.keys(empty).sort(),['events','hasMore','nextCursor']);
  assert.deepEqual([empty.events.length,empty.hasMore],[0,false]);
  assert.match(Buffer.from(empty.nextCursor,'base64url').toString(),/^v1\.0\.[0-9a-f]{64}$/);
  const first=await receive(f,WS,inv,300);
  const partial=f.events.page(WS,25);
  assert.equal(partial.events.length,1);
  const [event]=partial.events,entry=f.ledger.read(WS,inv.id).entries.find(row=>row.kind==='payment')!;
  assert.equal(event.id,expectedId(WS,'payment.received',entry.id));
  assert.deepEqual(Object.keys(event).sort(),EVENT_KEYS);
  assert.deepEqual(event.payment,{amount:300,method:'lightning',verification:'provider'});
  assert.deepEqual([event.seq,event.type,event.occurredAt,event.invoiceId,event.total,event.effectiveTotal,event.currency,event.mode],[1,'payment.received',entry.createdAt,inv.id,1000,1000,'CAD','live']);
  await receive(f,WS,inv,700);
  const full=f.events.page(WS,25),entries=f.ledger.read(WS,inv.id).entries;
  assert.deepEqual(full.events.map(row=>[row.seq,row.type]),[[1,'payment.received'],[2,'payment.received'],[3,'invoice.paid']]);
  const paid=full.events[2];
  assert.equal(paid.payment,undefined);
  assert.equal(paid.id,expectedId(WS,'invoice.paid',entries[1].id+':'+inv.id));
  const text=JSON.stringify(full);
  for(const secret of [inv.customerName,inv.customerEmail!,inv.note!,inv.token,inv.number,'fictional-payment-'+first.id,'fictional-provider-'])assert(!text.includes(secret));
  for(const row of rows(f.store,WS)){assert(String(row.data).startsWith('qlr:v1:'));assert(!String(row.data).includes(inv.customerName));assert.deepEqual([row.workspace,row.sequence],[WS,row.sequence]);}
  assert.equal(head(f.store,WS),3);
  assert.throws(()=>f.store.db.prepare('UPDATE invoice_events SET data=? WHERE id=?').run('x',String(rows(f.store,WS)[0].id)),/append-only/);
  assert.throws(()=>f.store.db.prepare('DELETE FROM invoice_events WHERE id=?').run(String(rows(f.store,WS)[0].id)),/append-only/);
  await f.receiving.check(first.id,WS);
  assert.equal(f.events.page(WS,25).events.length,3);
  }finally{f.close();}
});

test('a failure after the event write rolls back entry, events and head, and payment() commits atomically on its own',async()=>{
  const f=fixture();try{
  const inv=issue(f.store,WS),{entry,receipt}=buildPayment(f,WS,inv,300);
  assert.throws(()=>f.store.transaction(()=>{f.ledger.payment(WS,inv,'fictional-receiving-'+entry.id,entry,receipt);throw new Error('fictional rollback');}),/fictional rollback/);
  assert.equal(rows(f.store,WS).length,0);assert.equal(head(f.store,WS),0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE workspace=?').get(WS)!.n,0);
  assert.equal(f.ledger.balance(inv,WS).state,'unpaid');
  f.ledger.payment(WS,inv,'fictional-receiving-'+entry.id,entry,receipt);
  assert.deepEqual(f.events.page(WS,25).events.map(row=>[row.seq,row.type]),[[1,'payment.received']]);
  assert.equal(f.ledger.balance(inv,WS).state,'partially_paid');
  assert.throws(()=>f.ledger.payment(WS,inv,'fictional-receiving-'+entry.id,entry,receipt),/UNIQUE/);
  assert.equal(f.events.page(WS,25).events.length,1);
  }finally{f.close();}
});

test('an agreed effective price fires invoice.paid at the agreed total while the issued total stays unchanged',async()=>{
  const f=fixture();try{
  const inv=issue(f.store,WS,{methodPricing:[{method:'lightning',discountBps:500}]});
  const offer=f.ledger.agreements.offers(WS,inv,method=>method==='lightning').find(row=>row.method==='lightning')!;
  f.ledger.agreements.confirm({checkoutToken:inv.token,method:'lightning',offerHash:offer.offerHash},'fictional-agreement-key',method=>method==='lightning');
  const agreement=f.ledger.agreements.forInvoice(WS,inv.id)!;
  assert.equal(agreement.effectiveTotal,950);
  await receive(f,WS,inv,400,agreement.id);
  await receive(f,WS,inv,550,agreement.id);
  const page=f.events.page(WS,25);
  assert.deepEqual(page.events.map(row=>[row.seq,row.type,row.effectiveTotal,row.total]),[[1,'payment.received',950,1000],[2,'payment.received',950,1000],[3,'invoice.paid',950,1000]]);
  assert.equal(f.ledger.balance(inv,WS).state,'paid');
  }finally{f.close();}
});

test('overpayment keeps invoice.paid a one-time threshold transition',async()=>{
  const f=fixture();try{
  const inv=issue(f.store,WS);
  const requests=[];for(let i=0;i<2;i++)requests.push(await f.receiving.create(WS,{invoiceId:inv.id,method:'lightning',adapterId:'fictional-live',amount:700},randomUUID()));
  for(const view of requests){f.paid.add(view.id);await f.receiving.check(view.id,WS);}
  const balance=f.ledger.balance(inv,WS);
  assert.deepEqual([balance.paid,balance.overpaid,balance.state],[1400,400,'paid']);
  assert.deepEqual(f.events.page(WS,25).events.map(row=>[row.seq,row.type]),[[1,'payment.received'],[2,'payment.received'],[3,'invoice.paid']]);
  }finally{f.close();}
});

test('simulation, credits, voids and legacy records never emit events',async()=>{
  const f=fixture();try{
  const simulated=issue(f.store,WS);
  settleInvoice(f.store,WS,simulated,'card',T0);
  const credited=issue(f.store,WS);
  f.ledger.credit(WS,credited.id,250,'Fictional scope correction',T0);
  const voided=issue(f.store,WS);
  f.ledger.void(WS,voided.id,'Fictional cancellation',T0);
  const compatible=issue(f.store,WS);
  const {entry,receipt}=directPayment(f,WS,compatible,300,'simulation');
  assert.equal(f.ledger.read(WS,compatible.id).entries.length,1);
  assert.throws(()=>f.ledger.payment(WS,compatible,'fictional-receiving-x',{...entry,amount:301},receipt),{status:400});
  assert.equal(f.ledger.read(WS,compatible.id).entries.length,1);
  const legacy=issue(f.store,WS);
  f.store.saveInvoice({...legacy,status:'paid',paidAt:T0.toISOString()});
  directPayment(f,WS,legacy,100);
  const page=f.events.page(WS,25);
  assert.deepEqual(page.events.map(row=>[row.type,row.invoiceId]),[['payment.received',legacy.id]]);
  }finally{f.close();}
});

test('a file database reopens with identical event ids, sequences and cursors',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'invoice-events-restart-')),path=join(dir,'fixture.sqlite');
  let f=fixture(path);
  try{
    const inv=issue(f.store,WS);
    await receive(f,WS,inv,300);
    const midCursor=f.events.page(WS,25).nextCursor;
    await receive(f,WS,inv,700);
    const expected=f.events.page(WS,25,midCursor).events;
    assert.deepEqual(expected.map(row=>row.seq),[2,3]);
    f.close();
    f=fixture(path);
    assert.deepEqual(f.events.page(WS,25,midCursor).events,expected);
    const second=issue(f.store,WS);
    await receive(f,WS,second,100);
    assert.deepEqual(f.events.page(WS,25).events.map(row=>row.seq),[1,2,3,4]);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('two service instances on one database credit a verified payment once with contiguous sequences',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'invoice-events-multi-')),path=join(dir,'fixture.sqlite');
  const first=fixture(path),second=fixture(path);
  try{
    const inv=issue(first.store,WS);
    const view=await first.receiving.create(WS,{invoiceId:inv.id,method:'lightning',adapterId:'fictional-live',amount:300},randomUUID());
    first.paid.add(view.id);second.paid.add(view.id);
    const checked=await Promise.all([first.receiving.check(view.id,WS),second.receiving.check(view.id,WS)]);
    assert.ok(checked.every(row=>row.status==='paid'));
    assert.equal(first.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE workspace=?').get(WS)!.n,1);
    assert.equal(rows(first.store,WS).length,1);
    const other=issue(second.store,WS);
    const next=await second.receiving.create(WS,{invoiceId:other.id,method:'lightning',adapterId:'fictional-live',amount:500},randomUUID());
    second.paid.add(next.id);first.paid.add(next.id);await first.receiving.check(next.id,WS);
    assert.deepEqual(first.events.page(WS,100).events.map(row=>[row.seq,row.type]),[[1,'payment.received'],[2,'payment.received']]);
    assert.equal(head(second.store,WS),2);
  }finally{first.close();second.close();rmSync(dir,{recursive:true,force:true});}
});

test('independent processes commit one event per verified payment and keep sequences unique',{timeout:60000},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'invoice-events-race-')),path=join(dir,'fixture.sqlite');
  const f=fixture(path);
  const spawn=()=>fork(new URL('./fixtures/invoice-events-worker.ts',import.meta.url),[path],{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc']});
  const ready=(child:ReturnType<typeof spawn>)=>new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('message',message=>{(message as {ready?:boolean}).ready?resolve():reject(new Error('Fixture worker not ready.'));});child.once('exit',code=>{if(code)reject(new Error('Fixture worker exited '+code));});});
  const ask=(child:ReturnType<typeof spawn>,job:object)=>new Promise<{status?:string}>((resolve,reject)=>{child.once('message',message=>{const outcome=message as {result?:{status?:string};error?:{message:string}};outcome.error?reject(new Error(outcome.error.message)):resolve(outcome.result!);});child.once('error',reject);child.send(job);});
  try{
    const inv=issue(f.store,RACE),requests:{id:string}[]=[];
    for(const amount of [300,700])requests.push(await f.receiving.create(RACE,{invoiceId:inv.id,method:'lightning',adapterId:'fictional-live',amount},randomUUID()));
    let children=[spawn(),spawn()];
    try{
      await Promise.all(children.map(ready));
      const outcomes=await Promise.all(children.map((child,index)=>ask(child,{kind:'check',requestId:requests[index].id,workspace:RACE})));
      assert.deepEqual(outcomes.map(row=>row.status).sort(),['paid','paid']);
    }finally{for(const child of children)if(child.connected)child.kill();}
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE workspace=?').get(RACE)!.n,2);
    assert.deepEqual(f.events.page(RACE,100).events.map(row=>[row.seq,row.type]),[[1,'payment.received'],[2,'payment.received'],[3,'invoice.paid']]);
    const second=issue(f.store,RACE);
    const race=await f.receiving.create(RACE,{invoiceId:second.id,method:'lightning',adapterId:'fictional-live',amount:250},randomUUID());
    children=[spawn(),spawn()];
    try{
      await Promise.all(children.map(ready));
      const outcomes=await Promise.all(children.map(child=>ask(child,{kind:'check',requestId:race.id,workspace:RACE})));
      assert.deepEqual(outcomes.map(row=>row.status),['paid','paid']);
    }finally{for(const child of children)if(child.connected)child.kill();}
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE workspace=? AND invoice_id=?').get(RACE,second.id)!.n,1);
    assert.deepEqual(f.events.page(RACE,100).events.map(row=>[row.seq,row.type]),[[1,'payment.received'],[2,'payment.received'],[3,'invoice.paid'],[4,'payment.received']]);
  }finally{f.close();rmSync(dir,{recursive:true,force:true});}
});

test('pages stay tenant scoped and cursors are authenticated per installation in encrypted and local mode',async()=>{
  const f=fixture();try{
  const a=issue(f.store,WS),b=issue(f.store,OTHER);
  await receive(f,WS,a,300);await receive(f,OTHER,b,500);
  assert.deepEqual(f.events.page(WS,25).events.map(row=>[row.seq,row.invoiceId]),[[1,a.id]]);
  assert.deepEqual(f.events.page(OTHER,25).events.map(row=>[row.seq,row.invoiceId]),[[1,b.id]]);
  const cursor=f.events.page(WS,25).nextCursor;
  assert.throws(()=>f.events.page(OTHER,25,cursor),{status:400});
  const mac=Buffer.from(cursor,'base64url').toString().split('.')[2];
  for(const bad of [forge('v1.0.'+'0'.repeat(64)),forge('v1.5.'+mac),forge('v2.1.'+mac),forge('v1.01.'+mac),cursor.slice(0,-1),cursor+'=','not-a-cursor'])assert.throws(()=>f.events.page(WS,25,bad),{status:400});
  }finally{f.close();}
  const local=service(new Store(':memory:')),other=service(new Store(':memory:'));
  try{
  const inv=issue(local.store,'fictional-local-ws');
  directPayment(local,'fictional-local-ws',inv,300);
  const page=local.events.page('fictional-local-ws',25);
  assert.equal(page.events.length,1);
  assert.match(Buffer.from(page.nextCursor,'base64url').toString(),/^v1\.1\.[0-9a-f]{64}$/);
  assert.throws(()=>local.events.page('fictional-local-ws',25,forge('v1.0.'+'0'.repeat(64))),{status:400});
  assert.throws(()=>other.events.page('fictional-local-ws',25,page.nextCursor),{status:400});
  }finally{local.close();other.close();}
});

test('event storage failure rolls the payment back with a safe 503 and stays reconcilable',async()=>{
  const f=fixture();try{
  const inv=issue(f.store,WS);
  const view=await f.receiving.create(WS,{invoiceId:inv.id,method:'lightning',adapterId:'fictional-live',amount:300},randomUUID());
  f.paid.add(view.id);
  f.store.db.exec("CREATE TRIGGER fictional_event_failure BEFORE INSERT ON invoice_events BEGIN SELECT RAISE(ABORT,'Fictional event storage failure');END;");
  await assert.rejects(()=>f.receiving.check(view.id,WS),{status:503,message:'Invoice event storage is unavailable; the payment was not credited. Reconcile and retry.'});
  assert.equal(rows(f.store,WS).length,0);assert.equal(head(f.store,WS),0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries WHERE workspace=?').get(WS)!.n,0);
  assert.equal(f.receiving.read(view.id,WS).status,'awaiting_payment');
  assert.equal(f.ledger.balance(inv,WS).state,'unpaid');
  f.store.db.exec('DROP TRIGGER fictional_event_failure');
  assert.equal((await f.receiving.check(view.id,WS)).status,'paid');
  assert.deepEqual(f.events.page(WS,25).events.map(row=>[row.seq,row.type]),[[1,'payment.received']]);
  }finally{f.close();}
});

test('pagination is ascending, stable under inserts and every terminal cursor remains usable',async()=>{
  const f=fixture();try{
  const inv=issue(f.store,WS,{items:[{description:'Fictional service',quantity:1,unitAmount:100000}]});
  for(let i=0;i<7;i++)directPayment(f,WS,inv,100);
  const first=f.events.page(WS,3);
  assert.deepEqual([first.events.map(row=>row.seq),first.hasMore],[[1,2,3],true]);
  const second=f.events.page(WS,3,first.nextCursor);
  assert.deepEqual([second.events.map(row=>row.seq),second.hasMore],[[4,5,6],true]);
  const third=f.events.page(WS,3,second.nextCursor);
  assert.deepEqual([third.events.map(row=>row.seq),third.hasMore],[[7],false]);
  assert.match(Buffer.from(third.nextCursor,'base64url').toString(),/^v1\.7\.[0-9a-f]{64}$/);
  assert.deepEqual(f.events.page(WS,3,first.nextCursor),second);
  directPayment(f,WS,inv,100);
  assert.deepEqual(f.events.page(WS,3,third.nextCursor).events.map(row=>row.seq),[8]);
  const empty=f.events.page('fictional-empty-workspace',3);
  assert.deepEqual([empty.events.length,empty.hasMore],[0,false]);
  assert.match(Buffer.from(empty.nextCursor,'base64url').toString(),/^v1\.0\.[0-9a-f]{64}$/);
  assert.throws(()=>f.events.page(WS,0),{status:400});
  assert.throws(()=>f.events.page(WS,101),{status:400});
  }finally{f.close();}
});

test('authenticated but malformed event payloads cannot expose extra fields or escape as raw errors',()=>{
 const valid={id:'evt_'+ 'c'.repeat(32),seq:1,type:'payment.received',occurredAt:'2026-11-08T12:00:00.000Z',invoiceId:'fictional-invoice',total:100,effectiveTotal:100,currency:'SAT',mode:'live',payment:{amount:100,method:'cashu',verification:'provider'}};
 for(const value of [null,{...valid,checkoutToken:'fictional-private-bearer'},{...valid,payment:{...valid.payment,proof:'fictional-private-proof'}},{...valid,occurredAt:'not-a-time'}]){
  const f=fixture();try{
   f.store.db.prepare('INSERT INTO invoice_events(id,workspace,sequence,data) VALUES(?,?,?,?)').run(valid.id,WS,1,f.store.encode(value,'invoice_events',valid.id,WS));
   assert.throws(()=>f.events.page(WS,25),{status:503,message:'Invoice events are temporarily unavailable.'});
  }finally{f.close();}
 }
});

test('unsupported live verification cannot commit a payment followed by an unreadable event',()=>{
 const f=fixture();try{
  const inv=issue(f.store,WS),{entry,receipt}=buildPayment(f,WS,inv,100);
  entry.verification='self_report' as never;
  assert.throws(()=>f.ledger.payment(WS,inv,'fictional-invalid-verification',entry,receipt),{status:400});
  assert.equal(f.ledger.read(WS,inv.id).entries.length,0);
  assert.equal(f.events.page(WS,25).events.length,0);
 }finally{f.close();}
});

test('direct event append requires the existing payment transaction and cannot create orphan events',()=>{
 const f=fixture();try{
  const inv=issue(f.store,WS),{entry,receipt}=buildPayment(f,WS,inv,1000),before=f.ledger.balance(inv,WS);
  assert.throws(()=>f.events.appendReceipt(WS,inv,entry,receipt,before,{...before,paid:1000,due:0,state:'paid'}),{status:409,code:'EVENT_TRANSACTION_REQUIRED'});
  assert.equal(f.events.page(WS,25).events.length,0);assert.equal(head(f.store,WS),0);
  assert.equal(f.ledger.read(WS,inv.id).entries.length,0);
 }finally{f.close();}
});

test('a real payment arriving after a full credit still emits the genuine paid threshold once',async()=>{
 const f=fixture();try{
  const inv=issue(f.store,WS),saved=await f.receiving.create(WS,{invoiceId:inv.id,method:'lightning',adapterId:'fictional-live'},randomUUID());
  f.ledger.credit(WS,inv.id,1000,'Fictional credit before delayed bank-independent receipt',f.now());
  assert.equal(f.ledger.balance(inv,WS).state,'credited');assert.equal(f.events.page(WS,25).events.length,0);
  f.paid.add(saved.id);await f.receiving.check(saved.id,WS);
  assert.deepEqual(f.events.page(WS,25).events.map(event=>event.type),['payment.received','invoice.paid']);
  await f.receiving.check(saved.id,WS);assert.equal(f.events.page(WS,25).events.length,2);
  const balance=f.ledger.balance(inv,WS);assert.equal(balance.paid,1000);assert.equal(balance.overpaid,1000);
 }finally{f.close();}
});
