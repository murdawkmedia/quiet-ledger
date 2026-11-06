import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {Store,DomainError,type StoredSession} from '../server/store.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {createInvoice} from '../server/domain.js';
import {invoiceBalanceCsv} from '../server/invoice-csv.js';
import {createApp} from '../server/app.js';

const implementation=await import('../server/business-records-router.js').catch(()=>undefined);
const workspace='fictional-owner-workspace',other='other-fictional-workspace';
const input={customerName:'Fictional Studio',title:'Fictional service',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:1000}],issueDate:'2026-11-06',dueDate:'2026-12-06',paymentTermDays:30,paymentTerms:'Fictional agreed Net 30',note:'Fictional private note',customerEmail:'private@fictional.example'};
function fixture(){
 assert(implementation,'Business records router is not implemented.');
 const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,91)}),ledger=new InvoiceLedger(store),app=express();app.use(express.json({limit:'48kb'}));
 const session:StoredSession={role:'owner',workspace,csrf:'fictional-csrf',expires:'2027-01-01T00:00:00Z'};
 app.use((req,res,next)=>{if(req.get('X-Fictional-Session')!=='none')res.locals.session={...session,...(req.get('X-Fictional-Session')==='demo'?{role:'demo'}:{}),...(req.get('X-Fictional-Session')==='hackathon'?{hackathonDemo:true}:{})};if(req.get('X-Fictional-Api'))res.locals.apiAccess={};next();});
 app.use('/api/business-records',implementation.businessRecordsRouter(store,ledger));
 app.use((error:Error,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof DomainError?error.status:500).json({error:error.message}));
 const invoice=createInvoice(store,workspace,input,new Date('2026-11-06T12:00:00Z'));
 return {store,ledger,app,invoice,close:()=>store.close(),post:(path:string,body:object)=>request(app).post('/api/business-records/'+path).send(body)};
}
function snapshot(store:Store){return store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>({name:row.name,rows:store.db.prepare('SELECT * FROM "'+String(row.name).replaceAll('"','""')+'" ORDER BY rowid').all()}));}

test('statement snapshots issued terms, distinct ledger entries and exact native currency/mode summaries without capabilities',async()=>{
 const f=fixture();try{
  f.ledger.credit(workspace,f.invoice.id,200,'Fictional scope reduction',new Date('2026-11-06T13:00:00Z'));
  const won=createInvoice(f.store,workspace,{...input,currency:'KRW',items:[{description:'Fictional whole won service',quantity:1,unitAmount:144001}]},new Date('2026-11-06T12:00:00Z'));
  const simulated=createInvoice(f.store,workspace,{...input},new Date('2026-11-06T12:00:00Z'));
  f.store.saveInvoice({...simulated,status:'paid',receiptToken:'fictional-secret-receipt',paymentMethod:'cashu',settlementMode:'simulation',nativePayment:{asset:'BTC',network:'mainnet',atomicAmount:'100',paymentId:'fictional-private-provider-id',verification:'provider'}});
  const before=snapshot(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const response=await f.post('statement',{invoiceIds:[f.invoice.id,won.id,simulated.id]}).expect(200),body=response.body;
  assert.deepEqual(body.invoices.map((row:any)=>row.invoice.id),[f.invoice.id,won.id,simulated.id]);
  assert.equal(body.invoices[0].invoice.paymentTermDays,30);assert.equal(body.invoices[0].invoice.paymentTerms,input.paymentTerms);assert.equal(body.invoices[0].invoice.dueDate,'2026-12-06');assert.equal(body.invoices[0].balance.due,800);
  assert.equal(body.invoices[0].entries[0].kind,'credit');assert.equal(body.invoices[2].entries[0].kind,'payment');
  assert.deepEqual(body.summary.map((row:any)=>[row.currency,row.mode,row.issued,row.paid,row.credited,row.due]),[['CAD','live',1000,0,200,800],['CAD','simulation',1000,1000,0,0],['KRW','live',144001,0,0,144001]]);
  const text=JSON.stringify(body);for(const privateText of [f.invoice.token,won.token,simulated.token,input.note,input.customerEmail,'fictional-secret-receipt','fictional-private-provider-id'])assert(!text.includes(privateText));
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 }finally{f.close();}
});

test('statement selection is explicit, unique, bounded and all-or-nothing tenant scoped',async()=>{
 const f=fixture();try{
  const foreign=createInvoice(f.store,other,{...input},new Date('2026-11-06T12:00:00Z')),before=snapshot(f.store);
  const denied=await f.post('statement',{invoiceIds:[f.invoice.id,foreign.id]}).expect(404);assert(!JSON.stringify(denied.body).includes(f.invoice.number));
  await f.post('statement',{invoiceIds:[randomUUID()]}).expect(404);
  for(const body of [{invoiceIds:[]},{invoiceIds:[f.invoice.id,f.invoice.id]},{invoiceIds:['invalid']},{invoiceIds:Array.from({length:201},()=>randomUUID())},{invoiceIds:[f.invoice.id],customerName:'Guess client'}])await f.post('statement',body).expect(400);
  assert.deepEqual(snapshot(f.store),before);
 }finally{f.close();}
});

test('both preview routes require an owner browser and reject API and demo contexts',async()=>{
 const f=fixture();try{
  for(const [path,body] of [['statement',{invoiceIds:[f.invoice.id]}],['csv-preview',{csv:invoiceBalanceCsv(f.ledger.list(workspace))}]] as const){
   for(const session of ['demo','hackathon'])await request(f.app).post('/api/business-records/'+path).set('X-Fictional-Session',session).send(body).expect(403);
   await request(f.app).post('/api/business-records/'+path).set('X-Fictional-Session','none').send(body).expect(401);
   await request(f.app).post('/api/business-records/'+path).set('X-Fictional-Api','true').send(body).expect(403);
  }
 }finally{f.close();}
});

test('CSV preview matches only the owner workspace and cannot create invoices, receipts, events or idempotency records',async()=>{
 const f=fixture();try{
  const foreign=createInvoice(f.store,other,{...input},new Date('2026-11-06T12:00:00Z'));foreign.number='INV-FICTIONAL-OTHER';f.store.saveInvoice(foreign);
  const before=snapshot(f.store),changes=f.store.db.prepare('SELECT total_changes() AS n').get()!.n;
  const response=await f.post('csv-preview',{csv:invoiceBalanceCsv([...f.ledger.list(workspace),...f.ledger.list(other)])}).expect(200);
  assert.deepEqual(response.body.rows.map((row:any)=>row.classification),['existing','new']);assert.equal(response.body.notice,'Preview only; no records imported');assert.equal(response.body.rows[1].invoiceNumber,foreign.number);
  await f.post('csv-preview',{csv:'x'.repeat(16385)}).expect(400);await f.post('csv-preview',{csv:'"malformed'}).expect(400);await f.post('csv-preview',{csv:'',import:true}).expect(400);
  assert.deepEqual(snapshot(f.store),before);assert.equal(f.store.db.prepare('SELECT total_changes() AS n').get()!.n,changes);
 }finally{f.close();}
});

test('application mount retains same-origin, CSRF and browser-only API boundaries',async()=>{
 const ownerToken='fictional-business-records-owner',apiToken='fictional-business-records-api-token-at-least32',app=createApp({dbPath:':memory:',ownerToken,apiKeys:[{token:apiToken,scopes:['records:read','invoices:read']}]});
 try{
  const user=request.agent(app),login=await user.post('/api/session/owner').send({token:ownerToken}).expect(200),csrf=login.body.csrfToken;
  const invoice=(await user.post('/api/invoices').set('X-CSRF-Token',csrf).set('Idempotency-Key',randomUUID()).send(input).expect(201)).body;
  for(const [path,body] of [['statement',{invoiceIds:[invoice.id]}],['csv-preview',{csv:invoiceBalanceCsv([{invoice,balance:{total:1000,paid:0,credited:0,due:1000,overpaid:0,currency:'CAD',state:'unpaid',mode:'live'},entries:[]}])}]] as const){
   await request(app).post('/api/business-records/'+path).send(body).expect(401);await user.post('/api/business-records/'+path).send(body).expect(403);
   await user.post('/api/business-records/'+path).set('X-CSRF-Token',csrf).set('Origin','https://fictional-untrusted.invalid').send(body).expect(403);
   await request(app).post('/api/v1/business-records/'+path).set('Authorization','Bearer '+apiToken).send(body).expect(403);
   await user.post('/api/business-records/'+path).set('X-CSRF-Token',csrf).send(body).expect(200);
  }
 }finally{app.locals.close();}
});
