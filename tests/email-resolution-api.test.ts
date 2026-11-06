import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
test('email resolution is explicit, scoped and never retries the uncertain intent',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ql-resolution-')),path=join(dir,'ledger.sqlite'),key=Buffer.alloc(32,74),origin='https://fictional-recovery.example',proxy='fictional-resolution-proxy-key-at-least32';let sends=0;
 const app=createApp({dbPath:path,encryptionKey:key,now:()=>new Date('2026-11-06T00:00:00Z'),hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true},invoiceEmail:{publicOrigin:origin,transportFactory:()=>({verify:async()=>true,sendMail:async()=>{sends++;throw new Error('Fictional uncertain SMTP submission');}})}});
 const store=new Store(path,{encryptionKey:key});
 const owner=()=>{const token=randomBytes(32).toString('base64url'),csrf=randomUUID();store.saveSession(token,{workspace:randomUUID(),accountId:randomUUID(),role:'owner',csrf,expires:'2026-12-01T00:00:00Z'});return{Cookie:'ql_session='+token,'X-CSRF-Token':csrf};};
 const post=(url:string,body:object,h={},id=randomUUID())=>request(app).post(url).set({...h,Origin:origin,'x-quiet-ledger-proxy':proxy,'Idempotency-Key':id}).send(body);
 try{
  const a=owner(),b=owner(),invoice=await post('/api/invoices',{customerName:'Fictional studio',title:'Fictional service',currency:'CAD',items:[{description:'Editing',quantity:1,unitAmount:1000}]},a);
  await post('/api/invoice-email/settings',{savedRecipients:[],senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'},a);await post('/api/invoice-email/verify',{},a);
  const route='/api/invoices/'+invoice.body.id+'/email',body={action:'send',to:['client@example.test'],copyToSelf:false},key=randomUUID();const sent=await post(route,body,a,key);
  assert.equal(sent.body.state,'unknown');assert.equal(sends,1);
  const endpoint=route+'/'+sent.body.deliveryId+'/resolve',review={outcome:'confirmed_sent',note:'Checked the sent mailbox and found this exact message.'};
  assert.equal((await post(endpoint,review,b)).status,404);
  assert.equal((await post(endpoint,review,{Cookie:a.Cookie})).status,403);
  const result=await post(endpoint,review,a);assert.equal(result.status,200);assert.equal(result.body.resolutionOutcome,'confirmed_sent');assert.equal(result.body.state,'unknown');
  assert.equal((await post(endpoint,review,a)).status,200);assert.equal(sends,1);
  assert.equal((await post(endpoint,{...review,outcome:'confirmed_not_sent'},a)).status,409);
  assert.equal((await post(route,body,a,key)).body.deliveryId,sent.body.deliveryId);assert.equal(sends,1);
  const demoLogin=await post('/api/session/hackathon-demo',{password:'marmot'}),demo={Cookie:String(demoLogin.headers['set-cookie'][0]).split(';')[0],'X-CSRF-Token':demoLogin.body.csrfToken};
  assert.equal((await post(endpoint,review,demo)).status,403);
 }finally{store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}
});
