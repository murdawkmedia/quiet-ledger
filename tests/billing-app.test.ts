import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Express} from 'express';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';

/**
 * Stage-4 parent integration checks against the real `createApp` (real Express
 * middleware chain: host allowlist, proxy auth, sessions, origin/CSRF, idempotency).
 * Every workspace, invoice and payment here is fictional; the live payment is an
 * owner-confirmed manual bank receipt inside an isolated encrypted database, so no
 * provider, bank or network is contacted.
 */
const proxySecret='fictional-billing-app-proxy-secret-at-least-32';
const encryptionKey=Buffer.alloc(32,61);
const hostedOrigin='http://localhost:4363';
const invoiceInput={customerName:'Fictional billing-app client',title:'Fictional milestone work',currency:'CAD',items:[{description:'Fictional milestone delivery',quantity:1,unitAmount:125000}]};
const key=()=>randomUUID();

function localFixture(){
  const dir=mkdtempSync(join(tmpdir(),'ql-billing-app-')),ownerToken='fictional-billing-app-owner-token';
  const app=createApp({dbPath:join(dir,'fictional.sqlite'),ownerToken});
  return {app,ownerToken,close:()=>{app.locals.close();rmSync(dir,{recursive:true,force:true});}};
}
async function localOwner(app:Express,ownerToken:string){
  const response=await request(app).post('/api/session/owner').send({token:ownerToken});
  assert.equal(response.status,200);
  return {cookie:String(response.headers['set-cookie'][0]).split(';')[0],csrf:response.body.csrfToken as string};
}
function hostedFixture(){
  const dir=mkdtempSync(join(tmpdir(),'ql-billing-hosted-'));
  const app=createApp({dbPath:join(dir,'fictional.sqlite'),encryptionKey,hosted:{publicOrigin:hostedOrigin,proxySecret,allowInsecureLoopback:true},
    receivingQuote:async invoice=>({expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'Fictional billing-app quote; no market source contacted',observedAt:new Date().toISOString()})});
  const store=new Store(join(dir,'fictional.sqlite'),{encryptionKey});
  const proxy={'x-quiet-ledger-proxy':proxySecret};
  function actor(){
    const accountId=randomUUID(),workspace=randomUUID(),token=randomBytes(32).toString('base64url'),csrf=randomUUID();
    store.saveSession(token,{role:'owner',accountId,workspace,csrf,expires:new Date(Date.now()+86400000).toISOString()});
    const headers={...proxy,Cookie:'ql_session='+token,'X-CSRF-Token':csrf,Origin:hostedOrigin};
    return {workspace,headers,
      get:(path:string)=>request(app).get(path).set(headers),
      post:(path:string,body:object,extra:Record<string,string>={})=>request(app).post(path).set(headers).set('Idempotency-Key',key()).set(extra).send(body),
      patch:(path:string,body:object)=>request(app).patch(path).set(headers).set('Idempotency-Key',key()).send(body)};
  }
  return {app,store,actor,proxy,close:async()=>{store.close();await app.locals.closeAsync();rmSync(dir,{recursive:true,force:true});}};
}

test('actual app mounts /api/billing owner-only behind session, CSRF and idempotency with tenant isolation',async()=>{
  const f=hostedFixture();try{
    // Before the parent mount this returned 404 "API route not found."; the wired app
    // must answer with the owner-browser authorization boundary instead.
    const anonymous=await request(f.app).get('/api/billing/projects').set(f.proxy);
    assert.notEqual(anonymous.status,404);
    assert.equal(anonymous.status,401);
    const a=f.actor(),b=f.actor();
    // Idempotent project create: the same key replays one saved response and one row.
    const createKey=key(),name='Fictional Aurora project';
    const first=await a.post('/api/billing/projects',{name},{'Idempotency-Key':createKey});
    assert.equal(first.status,201);assert.equal(first.body.project.name,name);
    const replay=await a.post('/api/billing/projects',{name},{'Idempotency-Key':createKey});
    assert.equal(replay.status,201);assert.equal(replay.body.project.id,first.body.project.id);
    let overview=(await a.get('/api/billing/projects').expect(200)).body;
    assert.equal(overview.projects.length,1);
    // Rename, milestone CRUD and the empty-project delete rule.
    const projectId=first.body.project.id as string;
    assert.equal((await a.patch(`/api/billing/projects/${projectId}`,{name:'Fictional Aurora project v2'})).status,200);
    const milestone=await a.post('/api/billing/milestones',{label:'Fictional edit milestone',amount:50000,currency:'CAD',projectId});
    assert.equal(milestone.status,201);assert.equal(milestone.body.milestone.projectId,projectId);
    const milestoneId=milestone.body.milestone.id as string;
    const deleteBlocked=await request(f.app).delete(`/api/billing/projects/${projectId}`).set(a.headers).set('Idempotency-Key',key());
    assert.equal(deleteBlocked.status,409);
    const renamed=await a.patch(`/api/billing/milestones/${milestoneId}`,{label:'Fictional renamed milestone'});
    assert.equal(renamed.status,200);assert.equal(renamed.body.milestone.label,'Fictional renamed milestone');
    // Planned amounts and currency are immutable after creation.
    assert.equal((await a.patch(`/api/billing/milestones/${milestoneId}`,{amount:1})).status,400);
    assert.equal((await a.patch(`/api/billing/milestones/${milestoneId}`,{currency:'USD'})).status,400);
    // Link the milestone to a real invoice in the caller's workspace.
    const invoice=(await a.post('/api/invoices',invoiceInput).expect(201)).body;
    const linked=await a.patch(`/api/billing/milestones/${milestoneId}`,{invoiceId:invoice.id});
    assert.equal(linked.status,200);assert.equal(linked.body.milestone.invoice.id,invoice.id);
    assert.equal(linked.body.milestone.invoice.effectiveTotal,invoiceInput.items[0].unitAmount);
    overview=(await a.get('/api/billing/projects').expect(200)).body;
    assert.equal(overview.projects[0].milestones[0].invoice.number,invoice.number);
    // Mutations require the session CSRF token and a same-origin request.
    const noCsrf={...a.headers} as Record<string,string>;delete noCsrf['X-CSRF-Token'];
    assert.equal((await request(f.app).post('/api/billing/projects').set(noCsrf).set('Idempotency-Key',key()).send({name:'No csrf'})).status,403);
    assert.equal((await a.post('/api/billing/projects',{name:'Cross origin'},{Origin:'https://evil.fictional.invalid'})).status,403);
    // Cross-tenant ids 404 without leaking existence, including invoice links.
    assert.equal((await b.get('/api/billing/milestones/'+milestoneId)).status,404);
    assert.equal((await b.patch('/api/billing/milestones/'+milestoneId,{label:'Steal'})).status,404);
    assert.equal((await b.post('/api/billing/deliverables',{invoiceId:invoice.id,label:'Steal',url:'https://files.fictional.invalid/stolen.zip'})).status,404);
    // Scoped API keys never reach the owner-browser billing surface. Key creation
    // itself refuses Idempotency-Key headers by design, so it is sent without one.
    const apiKey=(await request(f.app).post('/api/account/api-keys').set(a.headers).send({label:'Fictional billing denial key',scopes:['invoices:read']}).expect(201)).body.key;
    const bearer=await request(f.app).get('/api/billing/projects').set(f.proxy).set('Authorization','Bearer '+apiKey.token);
    assert.equal(bearer.status,403);
  }finally{await f.close();}
});

test('checkout exposes released deliverables only after live receipt-backed payment at the effective method total',async()=>{
  const f=hostedFixture();try{
    const a=f.actor();
    // A method-priced invoice: the payer confirms the interac price on public checkout,
    // so the settlement target is the agreed effective total, not the issued total.
    const priced=(await a.post('/api/invoices',{...invoiceInput,title:'Fictional priced milestone work',items:[{description:'Fictional priced delivery',quantity:1,unitAmount:20000}],taxBps:0,acceptedMethods:['interac'],methodPricing:[{method:'interac',discountBps:1000}]}).expect(201)).body;
    const checkoutToken=priced.token as string;
    const publicGet=()=>request(f.app).get('/api/checkout/'+checkoutToken).set(f.proxy);
    let page=(await publicGet().expect(200)).body;
    const offer=page.pricingOffers.find((row:{method:string})=>row.method==='interac');
    assert.ok(offer);
    // The parent-owned checkout projection always answers with a payer-safe array.
    assert.deepEqual(page.deliverables,[]);
    await request(f.app).post('/api/checkout/'+checkoutToken+'/method-agreement').set(f.proxy).set('Idempotency-Key',key()).send({method:'interac',offerHash:offer.offerHash}).expect(201);
    const agreementId=((await a.get('/api/invoices/'+priced.id).expect(200)).body.priceAgreement??{}).id as string;
    assert.ok(agreementId);
    const effectiveTotal=((await a.get('/api/invoices/'+priced.id).expect(200)).body.balance.effectiveTotal) as number;
    assert.ok(effectiveTotal<20000);
    // Owner saves and releases a deliverable before any payment: still hidden.
    const deliverable=(await a.post('/api/billing/deliverables',{invoiceId:priced.id,label:'Fictional final recording',url:'https://files.fictional.invalid/final-recording.mp4'}).expect(201)).body.deliverable;
    assert.equal(deliverable.released,false);
    const released=await a.post(`/api/billing/deliverables/${deliverable.id}/release`,{});
    assert.equal(released.status,200);assert.equal(released.body.deliverable.released,true);assert.equal(released.body.deliverable.releaseReady,false);
    assert.deepEqual((await publicGet().expect(200)).body.deliverables,[]);
    // A partial live receipt is real money but not the effective total: still hidden.
    const manual=(amount:number)=>a.post('/api/receiving',{invoiceId:priced.id,method:'interac',adapterId:'owner-confirmed-manual',amount,agreementId});
    const partial=await manual(effectiveTotal-10000);
    assert.equal(partial.status,201);
    await a.post(`/api/receiving/${partial.body.request.id}/confirm`,{transactionId:'fictional-bank-reference-1',note:'Fictional owner-reviewed bank receipt; no bank was contacted.'}).expect(200);
    assert.deepEqual((await publicGet().expect(200)).body.deliverables,[]);
    // The covering live receipt at the effective total unlocks the released link.
    const remainder=await manual(10000);
    assert.equal(remainder.status,201);
    await a.post(`/api/receiving/${remainder.body.request.id}/confirm`,{transactionId:'fictional-bank-reference-2',note:'Fictional owner-reviewed bank receipt; no bank was contacted.'}).expect(200);
    page=(await publicGet().expect(200)).body;
    assert.deepEqual(page.deliverables,[{label:'Fictional final recording',url:'https://files.fictional.invalid/final-recording.mp4'}]);
    // The payer whitelist is exactly label/url: no ids, invoice or workspace metadata.
    for(const item of page.deliverables)assert.deepEqual(Object.keys(item).sort(),['label','url']);
    // Hiding again re-closes the gate; releasing once more re-opens it.
    await a.post(`/api/billing/deliverables/${deliverable.id}/unrelease`,{}).expect(200);
    assert.deepEqual((await publicGet().expect(200)).body.deliverables,[]);
    await a.post(`/api/billing/deliverables/${deliverable.id}/release`,{}).expect(200);
    assert.equal((await publicGet().expect(200)).body.deliverables.length,1);
    // A URL edit clears the release atomically; the new destination needs a new release.
    const edited=await a.patch(`/api/billing/deliverables/${deliverable.id}`,{url:'https://files.fictional.invalid/final-recording-v2.mp4'});
    assert.equal(edited.status,200);assert.equal(edited.body.deliverable.released,false);
    assert.deepEqual((await publicGet().expect(200)).body.deliverables,[]);
    await a.post(`/api/billing/deliverables/${deliverable.id}/release`,{}).expect(200);
    assert.deepEqual((await publicGet().expect(200)).body.deliverables,[{label:'Fictional final recording',url:'https://files.fictional.invalid/final-recording-v2.mp4'}]);
    // Revoking the invoice links removes the public checkout capability entirely.
    await a.post('/api/invoices/'+priced.id+'/revoke-links',{}).expect(200);
    assert.equal((await publicGet()).status,404);
    // No public route resolves deliverables by invoice UUID: the checkout token is the
    // only payer capability.
    assert.equal((await request(f.app).get('/api/checkout/'+priced.id).set(f.proxy)).status,404);
    assert.equal((await request(f.app).get('/api/checkout/'+randomUUID()).set(f.proxy)).status,404);
  }finally{await f.close();}
});

test('simulation, credits and demo workspaces never expose deliverable links',async()=>{
  const f=localFixture();try{
    const owner=await localOwner(f.app,f.ownerToken);
    const ownerHeaders={Cookie:owner.cookie,'X-CSRF-Token':owner.csrf};
    const ownerPost=(path:string,body:object)=>request(f.app).post(path).set(ownerHeaders).set('Idempotency-Key',key()).send(body);
    assert.equal((await request(f.app).get('/api/billing/projects')).status,401);
    // The local demo session is refused before any body parse or replay.
    const demo=await request(f.app).post('/api/session/demo').send({});
    const demoCookie=String(demo.headers['set-cookie'][0]).split(';')[0];
    assert.equal((await request(f.app).get('/api/billing/projects').set('Cookie',demoCookie)).status,403);
    // A demo-workspace checkout still answers with an empty payer-safe array.
    const demoInvoice=(await request(f.app).post('/api/invoices').set('Cookie',demoCookie).set('X-CSRF-Token',demo.body.csrfToken).set('Idempotency-Key',key()).send(invoiceInput).expect(201)).body;
    assert.deepEqual((await request(f.app).get('/api/checkout/'+demoInvoice.token).expect(200)).body.deliverables,[]);
    // A simulated settlement never unlocks a released link.
    const simulated=(await ownerPost('/api/invoices',invoiceInput).expect(201)).body;
    await request(f.app).post('/api/checkout/'+simulated.token+'/pay').set('Idempotency-Key',key()).send({method:'bitcoin'}).expect(200);
    const simDeliverable=(await ownerPost('/api/billing/deliverables',{invoiceId:simulated.id,label:'Fictional simulation deliverable',url:'https://files.fictional.invalid/simulation.mp4'}).expect(201)).body.deliverable;
    await ownerPost(`/api/billing/deliverables/${simDeliverable.id}/release`,{}).expect(200);
    assert.deepEqual((await request(f.app).get('/api/checkout/'+simulated.token).expect(200)).body.deliverables,[]);
    // A credit-only balance is live mode but carries no receipt-backed payment value.
    const credited=(await ownerPost('/api/invoices',{...invoiceInput,title:'Fictional credited milestone work'}).expect(201)).body;
    await ownerPost(`/api/invoices/${credited.id}/credits`,{amount:credited.total,reason:'Fictional scope withdrawn'}).expect(200);
    const creditDeliverable=(await ownerPost('/api/billing/deliverables',{invoiceId:credited.id,label:'Fictional credited deliverable',url:'https://files.fictional.invalid/credited.mp4'}).expect(201)).body.deliverable;
    await ownerPost(`/api/billing/deliverables/${creditDeliverable.id}/release`,{}).expect(200);
    const creditedBalance=(await request(f.app).get('/api/invoices/'+credited.id).set('Cookie',owner.cookie).expect(200)).body.balance;
    assert.equal(creditedBalance.state,'credited');assert.equal(creditedBalance.mode,'live');
    assert.deepEqual((await request(f.app).get('/api/checkout/'+credited.token).expect(200)).body.deliverables,[]);
  }finally{f.close();}
});
