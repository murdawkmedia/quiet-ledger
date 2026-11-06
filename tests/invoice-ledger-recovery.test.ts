import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {Store,hash} from '../server/store.js';
import {createInvoice,settleInvoice} from '../server/domain.js';
import {ReceivingService,type QuoteReceiving} from '../server/receiving-service.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import type {Receipt} from '../shared/contracts.js';
import {createEncryptedBackup,restoreEncryptedBackup} from '../ops/backup.js';

const clock=new Date('2026-11-06T12:00:00Z');
const input={customerName:'Fictional Recovery Studio',title:'Fictional durable project',currency:'CAD',items:[{description:'Fictional recovery service',quantity:1,unitAmount:1000}]};
const quote:QuoteReceiving=async invoice=>({expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.total,source:'fictional exact fixture',observedAt:clock.toISOString()});
function adapter(id='fictional-alias',mode:'live'|'test'='live'):ReceivingAdapter{return {id,mode,methods:['lightning'],create:async c=>({providerId:c.requestId,asset:'BTC',network:'mainnet'}),check:async c=>({status:'paid',paymentId:'fictional-shared-transaction',reference:c.requestId,amount:c.amount,currency:c.currency})};}

test('encrypted installments survive restart, retries, alias deduplication, tenants and revocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'quiet-ledger-installments-')),path=join(dir,'fixture.sqlite'),encryptionKey=randomBytes(32);let store=new Store(path,{encryptionKey});
 try{
  let ledger=new InvoiceLedger(store),service=new ReceivingService(store,[adapter(),adapter('fictional-second-alias')],quote,()=>clock);
  const invoice=createInvoice(store,'fictional-tenant-a',input,clock),body={invoiceId:invoice.id,method:'lightning' as const,adapterId:'fictional-alias',amount:300};
  const first=await service.create('fictional-tenant-a',body,'fictional-durable-key');await service.check(first.id,'fictional-tenant-a');
  assert.equal(ledger.read('fictional-tenant-a',invoice.id).balance.due,700);
  store.close();store=new Store(path,{encryptionKey});ledger=new InvoiceLedger(store);service=new ReceivingService(store,[adapter(),adapter('fictional-second-alias')],quote,()=>clock);
  assert.equal((await service.create('fictional-tenant-a',body,'fictional-durable-key')).id,first.id);await service.check(first.id,'fictional-tenant-a');
  assert.equal(ledger.read('fictional-tenant-a',invoice.id).entries.length,1);
  assert.throws(()=>ledger.read('fictional-tenant-b',invoice.id),/not found/);await assert.rejects(service.create('fictional-tenant-b',body,'fictional-durable-key'),/not found/);
  const alias=await service.create('fictional-tenant-a',{...body,adapterId:'fictional-second-alias'},'fictional-alias-key');await assert.rejects(service.check(alias.id,'fictional-tenant-a'),/already assigned/);
  const other=createInvoice(store,'fictional-tenant-b',input,clock),own=await service.create('fictional-tenant-b',{...body,invoiceId:other.id},'fictional-durable-key');await service.check(own.id,'fictional-tenant-b');assert.equal(ledger.read('fictional-tenant-b',other.id).balance.paid,300);
  const entry=ledger.read('fictional-tenant-a',invoice.id).entries[0];assert.equal(ledger.getReceipt(entry.receiptToken!)!.receipt.amount,300);store.revokeInvoiceLinks(invoice.id,'fictional-tenant-a',clock.toISOString());assert.equal(ledger.getReceipt(entry.receiptToken!),undefined);assert.throws(()=>service.publicRead(first.token),/not found/);
  assert.throws(()=>store.db.prepare('UPDATE invoice_ledger_entries SET data=data').run(),/append-only/);assert.throws(()=>store.db.prepare('DELETE FROM invoice_ledger_entries').run(),/append-only/);
  assert(!JSON.stringify(store.db.prepare('SELECT * FROM invoice_ledger_entries').all()).includes('Fictional Recovery Studio'));store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');assert(!readFileSync(path).includes(Buffer.from('fictional-shared-transaction')));
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('legacy live payment remains a single credit with no invoice or receipt rewrite',async()=>{
 const store=new Store(':memory:');try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',input,clock),receipt:Receipt={number:'FICTIONAL-LEGACY',issuedAt:clock.toISOString(),mode:'live',method:'lightning',amount:1000,currency:'CAD',invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName,nativePayment:{asset:'BTC',network:'mainnet',atomicAmount:'10000',paymentId:'fictional-shared-transaction',verification:'provider'}};
  store.addReceipt('fictional-legacy-token',invoice.id,receipt);store.saveInvoice({...invoice,status:'paid',settlementMode:'live',paymentMethod:'lightning',receiptToken:'fictional-legacy-token',nativePayment:receipt.nativePayment});
  const before=store.db.prepare('SELECT data FROM invoices WHERE id=?').get(invoice.id)!.data;
  for(let i=0;i<3;i++){const view=ledger.read('owner',invoice.id);assert.equal(view.balance.paid,1000);assert.equal(view.entries.length,1);assert.equal(view.entries[0].receiptToken,'fictional-legacy-token');}
  assert.equal(store.db.prepare('SELECT data FROM invoices WHERE id=?').get(invoice.id)!.data,before);assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM invoice_ledger_entries').get()!.n,0);
  const service=new ReceivingService(store,[adapter()],quote,()=>clock),other=createInvoice(store,'owner',input,clock),pending=await service.create('owner',{invoiceId:other.id,method:'lightning',adapterId:'fictional-alias',amount:300},'fictional-legacy-dedup');await assert.rejects(service.check(pending.id),/already assigned/);assert.equal(ledger.read('owner',other.id).balance.paid,0);
 }finally{store.close();}
});

test('test-mode receiving and legacy simulations never enter live balances',async()=>{
 const store=new Store(':memory:');try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',input,clock),service=new ReceivingService(store,[adapter('fictional-test','test')],quote,()=>clock),record=await service.create('owner',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-test',amount:300},'fictional-test-key');
  assert.equal((await service.check(record.id)).receipt!.mode,'test');assert.equal(ledger.read('owner',invoice.id).balance.paid,0);assert.equal(ledger.read('owner',invoice.id).entries.length,0);
  store.transaction(()=>settleInvoice(store,'owner',store.getInvoice(invoice.id)!, 'cashu',clock));const view=ledger.read('owner',invoice.id);assert.equal(view.balance.mode,'simulation');assert.equal(view.balance.paid,1000);assert.equal(view.entries.length,1);assert.equal(view.entries[0].verification,undefined);assert.throws(()=>ledger.credit('owner',invoice.id,1,'Fictional cannot credit simulation',clock),/balance/);
 }finally{store.close();}
});

test('outstanding live quotes prevent void and actual payments after credits retain value',async()=>{
 const store=new Store(':memory:');try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',input,clock),service=new ReceivingService(store,[adapter()],quote,()=>clock),record=await service.create('owner',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-alias'},'fictional-void-quote');
  assert.throws(()=>ledger.void('owner',invoice.id,'Fictional cancellation',clock),/outstanding|receiving request/);
  ledger.credit('owner',invoice.id,800,'Fictional scope reduction',clock);await service.check(record.id);const view=ledger.read('owner',invoice.id);assert.deepEqual([view.balance.paid,view.balance.credited,view.balance.overpaid,view.balance.due],[1000,800,800,0]);assert.equal(view.entries.filter(e=>e.kind==='payment').length,1);assert.equal(ledger.getReceipt(view.entries.find(e=>e.kind==='payment')!.receiptToken!)!.receipt.amount,1000);
 }finally{store.close();}
});

test('earlier provider expiry requires explicit owner review and preserves exact installment',async()=>{
 const store=new Store(':memory:');let current=clock;try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',input,clock),base=adapter(),native:ReceivingAdapter={...base,create:async c=>({...await base.create(c),expiresAt:new Date(clock.getTime()+1000).toISOString()})},service=new ReceivingService(store,[native],quote,()=>current),record=await service.create('owner',{invoiceId:invoice.id,method:'lightning',adapterId:native.id,amount:300},'fictional-expiry-key');
  current=new Date(clock.getTime()+1000);assert.equal((await service.check(record.id)).status,'awaiting_payment');assert.equal(ledger.read('owner',invoice.id).balance.paid,0);assert.match(service.read(record.id).reviewReason!,/expiry/);
  const settled=service.confirm(record.id,'owner','Fictional independent late-payment review','fictional-late-transaction');assert.equal(settled.receipt!.amount,300);const view=ledger.read('owner',invoice.id);assert.equal(view.balance.due,700);assert.equal(view.entries[0].verification,'manual');
 }finally{store.close();}
});

test('encrypted backup restores installment receipts and append-only history without double allocation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'quiet-ledger-installment-backup-')),path=join(dir,'source.sqlite'),encryptionKey=randomBytes(32),backupKey=randomBytes(32),store=new Store(path,{encryptionKey});let copy:Store|undefined;
 try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'fictional-backup-tenant',input,clock),service=new ReceivingService(store,[adapter()],quote,()=>clock),record=await service.create('fictional-backup-tenant',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-alias',amount:300},'fictional-backup-key');await service.check(record.id,'fictional-backup-tenant');ledger.credit('fictional-backup-tenant',invoice.id,100,'Fictional backup correction',clock);const before=ledger.read('fictional-backup-tenant',invoice.id);
  const backup=await createEncryptedBackup({dbPath:path,storageKey:encryptionKey,backupKey,outputDir:join(dir,'backups')});const restored=join(dir,'restored.sqlite');await restoreEncryptedBackup({backupPath:backup.file,storageKey:encryptionKey,backupKey,outputPath:restored});copy=new Store(restored,{encryptionKey});const recovered=new InvoiceLedger(copy);assert.deepEqual(recovered.read('fictional-backup-tenant',invoice.id),before);assert.equal(recovered.getReceipt(before.entries[0].receiptToken!)!.receipt.amount,300);
  const receiving=new ReceivingService(copy,[adapter()],quote,()=>clock);await receiving.check(record.id,'fictional-backup-tenant');assert.equal(recovered.read('fictional-backup-tenant',invoice.id).entries.length,2);assert.throws(()=>copy!.db.prepare('DELETE FROM invoice_ledger_entries').run(),/append-only/);
 }finally{store.close();copy?.close();rmSync(dir,{recursive:true,force:true});}
});

test('uncertain partial creation recovers original amount after a later credit',async()=>{
 const store=new Store(':memory:');let creates=0,recoveredAmount=0;try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',input,clock),base=adapter(),uncertain:ReceivingAdapter={...base,create:async()=>{creates++;throw Object.assign(new Error('fictional uncertain response'),{code:'LNURL_CREATION_UNCERTAIN'});},recover:async c=>{recoveredAmount=c.amount;return {providerId:c.requestId,network:'mainnet',asset:'BTC'};}},service=new ReceivingService(store,[uncertain],quote,()=>clock),body={invoiceId:invoice.id,method:'lightning' as const,adapterId:uncertain.id,amount:300};
  await assert.rejects(service.create('owner',body,'fictional-uncertain-partial'));ledger.credit('owner',invoice.id,900,'Fictional later correction',clock);const saved=service.list().requests[0],record=await service.recover(saved.id);assert.equal(record.id,saved.id);assert.equal(record.amount,300);assert.equal(recoveredAmount,300);assert.equal(creates,1);
  await service.check(record.id);const view=ledger.read('owner',invoice.id);assert.deepEqual([view.balance.paid,view.balance.credited,view.balance.overpaid],[300,900,200]);
 }finally{store.close();}
});

test('the adjustment quota cannot block a verified payment on an existing quote',async()=>{
 const store=new Store(':memory:');try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',{...input,items:[{...input.items[0],unitAmount:10000}]},clock),service=new ReceivingService(store,[adapter()],quote,()=>clock),record=await service.create('owner',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-alias',amount:300},'fictional-capacity-quote');
  // Prepare the documented boundary without spending thousands of HTTP requests.
  store.transaction(()=>{const insert=store.db.prepare('INSERT INTO invoice_ledger_entries(id,workspace,invoice_id,data) VALUES(?,?,?,?)');for(let i=0;i<2000;i++){
   const entry={id:'fictional-boundary-credit-'+i,kind:'credit',amount:1,currency:'CAD',createdAt:clock.toISOString(),reason:'Fictional boundary correction'};insert.run(entry.id,'owner',invoice.id,store.encode(entry,'invoice_ledger_entries',entry.id,'owner'));
  }});
  assert.throws(()=>ledger.credit('owner',invoice.id,1,'Fictional extra adjustment',clock),/adjustment limit/);
  const paid=await service.check(record.id);assert.equal(paid.status,'paid');assert.equal(paid.receipt!.amount,300);const view=ledger.read('owner',invoice.id);assert.deepEqual([view.balance.paid,view.balance.credited,view.balance.due,view.entries.length],[300,2000,7700,2001]);assert.equal(ledger.getReceipt(view.entries.at(-1)!.receiptToken!)!.receipt.amount,300);
 }finally{store.close();}
});


async function legacyOutstandingFixture(){
 const store=new Store(':memory:',{encryptionKey:randomBytes(32)}),ledger=new InvoiceLedger(store),original=adapter('fictional-original-alias');
 const extra:ReceivingAdapter={...adapter('fictional-extra-alias'),check:async c=>({status:'paid',paymentId:'fictional-extra-transaction',reference:c.requestId,amount:c.amount,currency:c.currency})};
 const service=new ReceivingService(store,[original,extra],quote,()=>clock),invoice=createInvoice(store,'fictional-legacy-tenant',input,clock);
 const first=await service.create('fictional-legacy-tenant',{invoiceId:invoice.id,method:'lightning',adapterId:original.id},'fictional-before-upgrade-first');
 const outstanding=await service.create('fictional-legacy-tenant',{invoiceId:invoice.id,method:'lightning',adapterId:extra.id,amount:300},'fictional-before-upgrade-extra');
 const nativePayment={asset:'BTC',network:'mainnet',atomicAmount:'10000',paymentId:'fictional-shared-transaction',verification:'provider' as const};
 const receipt:Receipt={number:'FICTIONAL-OLD-RECEIPT',issuedAt:clock.toISOString(),mode:'live',method:'lightning',amount:1000,currency:'CAD',invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName,nativePayment};
 store.addReceipt('fictional-old-receipt-token',invoice.id,receipt);store.saveInvoice({...invoice,status:'paid',settlementMode:'live',totalCad:1234,paidAt:clock.toISOString(),paymentMethod:'lightning',receiptToken:'fictional-old-receipt-token',nativePayment});
 const row=store.db.prepare('SELECT data FROM receiving_requests WHERE id=?').get(first.id)!;
 const saved=store.decode<Record<string,unknown>>(row.data,'receiving_requests',first.id,'fictional-legacy-tenant');saved.status='paid';
 const oldIdentity=hash('BTC:mainnet:fictional-shared-transaction'),oldKey=store.indexValue('payment',hash(`fictional-legacy-tenant:${original.id}:${oldIdentity}`));
 store.db.prepare('UPDATE receiving_requests SET payment_key=?,data=? WHERE id=?').run(oldKey,store.encode(saved,'receiving_requests',first.id,'fictional-legacy-tenant'),first.id);
 return {store,ledger,service,invoice,outstanding};
}

test('post-upgrade extra payment preserves the original legacy valuation and receipt provenance',async()=>{
 const f=await legacyOutstandingFixture();try{
  const before=f.store.getInvoice(f.invoice.id)!,receiptBytes=f.store.db.prepare('SELECT data FROM receipts WHERE invoice_id=?').get(f.invoice.id)!.data;
  await f.service.check(f.outstanding.id,'fictional-legacy-tenant');const invoice=f.store.getInvoice(f.invoice.id)!;
  assert.equal(invoice.totalCad,1234);assert.deepEqual(invoice.nativePayment,before.nativePayment);assert.equal(invoice.paidAt,before.paidAt);
  assert.equal(f.ledger.receivedCad(invoice,'fictional-legacy-tenant'),1534);assert.deepEqual([f.ledger.read('fictional-legacy-tenant',invoice.id).balance.paid,f.ledger.read('fictional-legacy-tenant',invoice.id).balance.overpaid],[1300,300]);
  assert.equal(f.store.db.prepare('SELECT data FROM receipts WHERE invoice_id=?').get(invoice.id)!.data,receiptBytes);
 }finally{f.store.close();}
});

test('legacy payment remains deduplicated across aliases after a different extra payment settles',async()=>{
 const f=await legacyOutstandingFixture();try{
  await f.service.check(f.outstanding.id,'fictional-legacy-tenant');
  const other=createInvoice(f.store,'fictional-legacy-tenant',input,clock),pending=await f.service.create('fictional-legacy-tenant',{invoiceId:other.id,method:'lightning',adapterId:'fictional-original-alias',amount:300},'fictional-after-upgrade-duplicate');
  await assert.rejects(f.service.check(pending.id,'fictional-legacy-tenant'),/already assigned/);assert.equal(f.ledger.read('fictional-legacy-tenant',other.id).balance.paid,0);
 }finally{f.store.close();}
});


test('saved verified requests can use the reserved space after new-record admission closes',async()=>{
 const store=new Store(':memory:',{encryptionKey:randomBytes(32)});try{
  const ledger=new InvoiceLedger(store),invoice=createInvoice(store,'owner',input,clock),service=new ReceivingService(store,[adapter()],quote,()=>clock),record=await service.create('owner',{invoiceId:invoice.id,method:'lightning',adapterId:'fictional-alias',amount:300},'fictional-reserved-space');
  store.db.exec('CREATE TABLE fictional_capacity_fixture(data BLOB);INSERT INTO fictional_capacity_fixture VALUES(zeroblob(54525952));');
  assert.throws(()=>store.assertWriteBudget(),/storage budget/);
  assert(Number(store.db.prepare('PRAGMA page_count').get()!.page_count)<Number(store.db.prepare('PRAGMA max_page_count').get()!.max_page_count));
  const result=await service.check(record.id);assert.equal(result.status,'paid');assert.equal(ledger.read('owner',invoice.id).balance.paid,300);
  await service.check(record.id);assert.equal(ledger.read('owner',invoice.id).entries.length,1);
  assert.throws(()=>ledger.credit('owner',invoice.id,100,'Fictional new adjustment',clock),/storage budget/);
 }finally{store.close();}
});


test('expired uncertain creation retains its recovery classification without another allocation',async()=>{
 const store=new Store(':memory:');let current=clock,creates=0;try{
  const invoice=createInvoice(store,'owner',input,clock),base=adapter(),service=new ReceivingService(store,[{...base,create:async()=>{creates++;throw new Error('Fictional lost allocation response');}}],quote,()=>current),body={invoiceId:invoice.id,method:'lightning' as const,adapterId:base.id,amount:300};
  await assert.rejects(service.create('owner',body,'fictional-expired-uncertain'));
  current=new Date(clock.getTime()+900000);
  await assert.rejects(service.create('owner',body,'fictional-expired-uncertain'),(error:unknown)=>Boolean(error&&typeof error==='object'&&'code' in error&&error.code==='RECEIVING_UNCERTAIN'));
  assert.equal(creates,1);assert.equal(service.list().requests.length,1);
 }finally{store.close();}
});
