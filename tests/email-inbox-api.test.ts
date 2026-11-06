import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp,type AppOptions} from '../server/app.js';
import {Store} from '../server/store.js';
test('email inbox is explicit, workspace-scoped and denied to demos',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'ql-inbox-api-')),path=join(dir,'ledger.sqlite'),key=Buffer.alloc(32,76),origin='https://fictional-inbox.example',proxy='fictional-inbox-proxy-key-at-least32characters';let opens=0;
 const options={dbPath:path,encryptionKey:key,now:()=>new Date('2026-11-06T00:00:00Z'),hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true},invoiceEmail:{publicOrigin:origin,transportFactory:()=>({verify:async()=>true,sendMail:async(message:{messageId:string;to:string[];cc:string[]})=>({messageId:message.messageId,accepted:[...message.to,...message.cc],rejected:[]})})},emailInbox:{mailboxFactory:()=>({open:async()=>{opens++;return{uidValidity:'1',uidNext:2};},headers:async()=>[],readText:async()=>({text:'Fictional body',truncated:false}),close(){}})}};
 const app=createApp(options as AppOptions),store=new Store(path,{encryptionKey:key});
 const owner=()=>{const token=randomBytes(32).toString('base64url'),csrf=randomUUID();store.saveSession(token,{workspace:randomUUID(),accountId:randomUUID(),role:'owner',csrf,expires:'2026-12-01T00:00:00Z'});return{Cookie:'ql_session='+token,'X-CSRF-Token':csrf};};
 const post=(url:string,body:object,h={})=>request(app).post(url).set({...h,Origin:origin,'x-quiet-ledger-proxy':proxy}).send(body);
 const get=(url:string,h={})=>request(app).get(url).set({...h,Origin:origin,'x-quiet-ledger-proxy':proxy});
 try{
  const a=owner(),b=owner();const initial=await get('/api/email-inbox/settings',a);assert.equal(initial.status,200);assert.equal(initial.body.settings.enabled,false);assert.equal(opens,0);
  await post('/api/invoice-email/settings',{savedRecipients:[],senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'},a);await post('/api/invoice-email/verify',{},a);assert.equal(opens,0);
  assert.equal((await get('/api/email-inbox/settings',a)).body.settings.enabled,false);
  assert.equal((await post('/api/email-inbox/settings',{enabled:true,folder:'INBOX'},{Cookie:a.Cookie})).status,403);
  assert.equal((await post('/api/email-inbox/settings',{enabled:true,folder:'INBOX'},a)).status,200);
  assert.equal((await get('/api/email-inbox/settings',b)).body.settings.enabled,false);
  assert.equal((await post('/api/email-inbox/sync',{},a)).body.status,'synced');assert.equal(opens,2);
  assert.deepEqual((await get('/api/email-inbox/items',b)).body.items,[]);
  assert.equal((await post('/api/email-inbox/items/'+randomUUID()+'/approve',{},b)).status,404);
  assert.equal((await post('/api/invoice-email/settings',{savedRecipients:[],disconnectGmail:true},a)).status,200);
  assert.equal((await get('/api/email-inbox/settings',a)).body.settings.enabled,false);
  assert.equal((await post('/api/email-inbox/sync',{},a)).body.status,'disabled');assert.equal(opens,2);
  const login=await post('/api/session/hackathon-demo',{password:'marmot'}),demo={Cookie:String(login.headers['set-cookie'][0]).split(';')[0],'X-CSRF-Token':login.body.csrfToken};
  assert.equal((await get('/api/email-inbox/items',demo)).status,403);assert.equal((await post('/api/email-inbox/sync',{},demo)).status,403);
  assert.equal((await get('/api/email-inbox/items?invoiceId='+randomUUID()+'&limit=101',a)).status,400);
 }finally{store.close();app.locals.close();rmSync(dir,{recursive:true,force:true});}
});
