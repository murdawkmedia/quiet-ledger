import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const origin='https://invoice-email.example',proxy='fictional-email-proxy-secret-at-least32bytes';
function setup(){
 const dir=mkdtempSync(join(tmpdir(),'quiet-ledger-email-api-')),key=Buffer.alloc(32,85),path=join(dir,'ledger.sqlite');let sends=0,clock=new Date('2026-11-06T00:00:00Z');
 const app=createApp({dbPath:path,encryptionKey:key,hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true},now:()=>clock,invoiceEmail:{publicOrigin:origin,transportFactory:()=>({verify:async()=>true,sendMail:async message=>{sends++;return{messageId:message.messageId,accepted:[...message.to,...message.cc],rejected:[]};}})}});
 const store=new Store(path,{encryptionKey:key});const base={'x-quiet-ledger-proxy':proxy,Origin:origin};
 const owner=()=>{const value=randomBytes(32).toString('base64url'),csrf=randomUUID(),workspace=randomUUID();store.saveSession(value,{role:'owner',workspace,accountId:randomUUID(),csrf,expires:'2026-12-01T00:00:00Z'});return{Cookie:'ql_session='+value,'X-CSRF-Token':csrf};};
 const get=(url:string,headers={})=>request(app).get(url).set({...base,...headers});const post=(url:string,body:object,headers={},id:string=randomUUID())=>request(app).post(url).set({...base,...headers,'Idempotency-Key':id}).send(body);
 const invoice=(headers:ReturnType<typeof owner>)=>post('/api/invoices',{customerName:'Fictional workshop client',customerEmail:'client@example.test',title:'Fictional editing',currency:'CAD',items:[{description:'Edit recording',quantity:1,unitAmount:5000}]},headers);
 return{app,store,get,post,owner,invoice,sends:()=>sends,advance:(days:number)=>{clock=new Date(clock.getTime()+days*86400000);},close(){store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}};
}
test('browser email routes require session, CSRF and invoice ownership; SMTP credentials never appear in readback',async()=>{
 const f=setup();try{
  const a=f.owner(),b=f.owner(),invoice=await f.invoice(a);assert.equal(invoice.status,201);const endpoint='/api/invoices/'+invoice.body.id+'/email';
  assert.equal((await f.get(endpoint)).status,401);assert.equal((await f.get(endpoint,b)).status,404);
  assert.equal((await f.post('/api/invoice-email/settings',{}, {Cookie:a.Cookie})).status,403);
  const saved=await f.post('/api/invoice-email/settings',{savedRecipients:[{label:'Fictional client',email:'client@example.test'}],senderEmail:'merchant@example.test',selfCopyEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'},a);assert.equal(saved.status,200);assert.ok(!JSON.stringify(saved.body).includes('abcdefghijklmnop'));
  assert.deepEqual((await f.get('/api/invoice-email/settings',b)).body.settings.savedRecipients,[]);
  assert.equal((await f.post('/api/invoice-email/verify',{},a)).status,200);
  const body={action:'send',to:['client@example.test'],copyToSelf:true};const result=await f.post(endpoint,body,a,'one-fictional-email');assert.equal(result.body.state,'provider_accepted');assert.deepEqual(result.body.cc,['merchant@example.test']);
  assert.equal((await f.post(endpoint,body,a,'one-fictional-email')).body.messageId,result.body.messageId);assert.equal(f.sends(),1);
  const context=await f.get(endpoint,a);assert.equal(context.body.deliveries.length,1);assert.ok(!JSON.stringify(context.body).includes('abcdefghijklmnop'));
  assert.equal((await f.post(endpoint,{...body,to:['other@example.test']},a,'one-fictional-email')).status,409);
 }finally{f.close();}
});
test('demo email previews cannot send, open mail drafts, authenticate Gmail or use other invoices',async()=>{
 const f=setup();try{
  const login=await f.post('/api/session/hackathon-demo',{password:'marmot'});const demo={Cookie:String(login.headers['set-cookie'][0]).split(';')[0],'X-CSRF-Token':login.body.csrfToken};
  const view=(await f.get('/api/hackathon-demo',demo)).body,endpoint='/api/invoices/'+view.invoice.id+'/email';
  assert.equal((await f.post('/api/invoice-email/settings',{savedRecipients:[],selfCopyEmail:'merchant@example.test'},demo)).status,200);
  const preview=await f.post(endpoint,{action:'preview',to:['client@example.test'],copyToSelf:true},demo);assert.equal(preview.status,200);assert.equal(preview.body.state,'preview');assert.equal(preview.body.mailtoUrl,undefined);
  for(const action of ['send','draft'])assert.equal((await f.post(endpoint,{action,to:['client@example.test'],copyToSelf:false},demo)).status,403);
  assert.equal((await f.post('/api/invoice-email/settings',{savedRecipients:[],senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'},demo)).status,403);
  assert.equal((await f.post('/api/invoice-email/verify',{},demo)).status,403);assert.equal(f.sends(),0);
  const owner=f.owner(),other=await f.invoice(owner);assert.equal((await f.get('/api/invoices/'+other.body.id+'/email',demo)).status,404);
  f.advance(31);assert.equal((await f.post('/api/session/hackathon-demo',{password:'marmot'})).status,200);assert.equal(f.store.getInvoice(view.invoice.id),undefined);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM invoice_email_settings').get()!.n,0);
 }finally{f.close();}
});
