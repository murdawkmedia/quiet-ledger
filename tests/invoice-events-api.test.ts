import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {Store,DomainError,type StoredSession} from '../server/store.js';
import {InvoiceLedger} from '../server/invoice-ledger.js';
import {createInvoice} from '../server/domain.js';
import type {ApiAccess,ApiScope} from '../server/api-access.js';
import type {Invoice,Receipt} from '../shared/contracts.js';
import type {InvoiceLedgerEntry} from '../shared/invoice-ledger.js';

const eventsModule=await import('../server/invoice-events.js').catch(()=>undefined);
const routerModule=await import('../server/invoice-events-router.js').catch(()=>undefined);
assert(eventsModule&&routerModule,'Invoice events API is not implemented.');
const {InvoiceEvents}=eventsModule,{invoiceEventsRouter}=routerModule;

const WS='fictional-events-owner',OTHER='fictional-events-other';
const KEY=Buffer.alloc(32,77),T0=new Date('2026-11-08T12:00:00Z');
const input={customerName:'Fictional Studio',customerEmail:'private@fictional.example',note:'Fictional private note',title:'Fictional events project',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:100000}]};

function fixture(encrypted=true){
  const store=new Store(':memory:',encrypted?{encryptionKey:KEY}:{}),ledger=new InvoiceLedger(store),events=new InvoiceEvents(store),app=express();
  const sessionFor=(workspace:string):StoredSession=>({role:'owner',workspace,csrf:'fictional-csrf',expires:'2027-01-01T00:00:00Z'});
  app.use((req,res,next)=>{
    const mode=req.get('X-Fictional-Session')??'owner',workspace=req.get('X-Fictional-Workspace')??WS;
    if(mode!=='none')res.locals.session=mode==='demo'?{...sessionFor('demo'),role:'demo'}:mode==='hackathon'?{...sessionFor(workspace),role:'demo',hackathonDemo:true}:sessionFor(workspace);
    const scopes=req.get('X-Fictional-Api');
    if(scopes!==undefined){
      res.locals.apiAccess={keyId:'key-1',scopes:scopes.split(',').filter(Boolean).map(scope=>scope as ApiScope),version:'v1',workspace} as ApiAccess;
      if(!res.locals.session)res.locals.session=sessionFor(workspace);
    }
    next();
  });
  app.use('/api',invoiceEventsRouter(events));
  app.use((error:unknown,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error instanceof DomainError?error.status:500).json({error:error instanceof DomainError?error.message:'Unexpected fixture error.'}));
  const invoices=new Map<string,Invoice>();
  const invoiceFor=(workspace:string)=>{if(!invoices.has(workspace))invoices.set(workspace,createInvoice(store,workspace,input,T0));return invoices.get(workspace)!;};
  const seed=(workspace:string,count:number)=>{
    const inv=invoiceFor(workspace);
    for(let i=0;i<count;i++){
      const id=randomUUID(),createdAt=new Date(Date.parse('2026-11-08T12:00:00Z')+(i+1)*60000).toISOString();
      const entry:InvoiceLedgerEntry={id,kind:'payment',amount:100,currency:'CAD',createdAt,method:'lightning',verification:'provider'};
      const receipt:Receipt={number:'PAY-'+id,issuedAt:createdAt,mode:'live',method:'lightning',amount:100,currency:'CAD',invoiceNumber:inv.number,title:inv.title,customerName:inv.customerName};
      ledger.payment(workspace,inv,'fictional-receiving-'+id,entry,receipt);
    }
  };
  return {store,events,app,seed,invoice:invoiceFor(WS),close:()=>store.close()};
}

test('owner sessions read their workspace feed while demos, hackathon contexts and non-GET methods are refused',async()=>{
  const f=fixture();try{
  f.seed(WS,2);
  const ok=await request(f.app).get('/api/invoice-events').expect(200);
  assert.deepEqual(Object.keys(ok.body).sort(),['events','hasMore','nextCursor']);
  assert.deepEqual([ok.body.events.length,ok.body.hasMore],[2,false]);
  assert.equal(ok.headers['cache-control'],'no-store');
  await request(f.app).get('/api/invoice-events').set('X-Fictional-Session','none').expect(401);
  await request(f.app).get('/api/invoice-events').set('X-Fictional-Session','demo').expect(403);
  await request(f.app).get('/api/invoice-events').set('X-Fictional-Session','hackathon').expect(403);
  await request(f.app).post('/api/invoice-events').expect(403);
  await request(f.app).delete('/api/invoice-events').expect(403);
  await request(f.app).get('/api/invoice-events/extra').expect(404);
  }finally{f.close();}
});

test('api keys need the dedicated events:read scope with no broader fallback',async()=>{
  const f=fixture();try{
  f.seed(WS,1);
  for(const scopes of ['invoices:read','records:read','invoices:read,receiving:read','payments:confirm'])await request(f.app).get('/api/invoice-events').set('X-Fictional-Api',scopes).expect(403);
  assert.equal((await request(f.app).get('/api/invoice-events').set('X-Fictional-Api','events:read').expect(200)).body.events.length,1);
  await request(f.app).get('/api/invoice-events').set('X-Fictional-Api','invoices:read,events:read').expect(200);
  await request(f.app).get('/api/invoice-events').set('X-Fictional-Session','none').set('X-Fictional-Api','events:read').expect(200);
  }finally{f.close();}
});

test('queries accept only bounded limit and cursor parameters',async()=>{
  const f=fixture();try{
  f.seed(WS,2);
  for(const query of ['limit=0','limit=101','limit=abc','limit=1.5','limit=','foo=1','workspace=other','limit=1&limit=2','limit=1&cursor=x&limit=2','cursor='])await request(f.app).get('/api/invoice-events?'+query).expect(400);
  await request(f.app).get('/api/invoice-events?limit=1').expect(200);
  await request(f.app).get('/api/invoice-events?limit=100').expect(200);
  }finally{f.close();}
});

test('pages default to 25 ascending events and resume from every terminal or empty page',async()=>{
  const f=fixture();try{
  const fresh=await request(f.app).get('/api/invoice-events').set('X-Fictional-Workspace','fictional-fresh').expect(200);
  assert.deepEqual([fresh.body.events.length,fresh.body.hasMore],[0,false]);
  assert.match(String(fresh.body.nextCursor),/^[A-Za-z0-9_-]+$/);
  const stillEmpty=await request(f.app).get('/api/invoice-events').set('X-Fictional-Workspace','fictional-fresh').query({cursor:fresh.body.nextCursor}).expect(200);
  assert.deepEqual([stillEmpty.body.events.length,stillEmpty.body.hasMore],[0,false]);
  f.seed(WS,30);
  const first=await request(f.app).get('/api/invoice-events').expect(200);
  assert.deepEqual([first.body.events.length,first.body.hasMore],[25,true]);
  assert.deepEqual(first.body.events.map((row:{seq:number})=>row.seq),Array.from({length:25},(_,index)=>index+1));
  const second=await request(f.app).get('/api/invoice-events').query({cursor:first.body.nextCursor}).expect(200);
  assert.deepEqual([second.body.events.length,second.body.hasMore],[5,false]);
  assert.deepEqual(second.body.events.map((row:{seq:number})=>row.seq),[26,27,28,29,30]);
  const repeat=await request(f.app).get('/api/invoice-events').query({cursor:first.body.nextCursor}).expect(200);
  assert.deepEqual(repeat.body,second.body);
  f.seed(WS,1);
  const resumed=await request(f.app).get('/api/invoice-events').query({cursor:second.body.nextCursor}).expect(200);
  assert.deepEqual(resumed.body.events.map((row:{seq:number})=>row.seq),[31]);
  }finally{f.close();}
});

test('feeds and cursors never cross tenants',async()=>{
  const f=fixture();try{
  f.seed(WS,2);f.seed(OTHER,1);
  const own=await request(f.app).get('/api/invoice-events').expect(200);
  assert.equal(own.body.events.length,2);
  const other=await request(f.app).get('/api/invoice-events').set('X-Fictional-Workspace',OTHER).expect(200);
  assert.equal(other.body.events.length,1);
  assert.notEqual(other.body.events[0].invoiceId,own.body.events[0].invoiceId);
  await request(f.app).get('/api/invoice-events').set('X-Fictional-Workspace',OTHER).query({cursor:own.body.nextCursor}).expect(400);
  }finally{f.close();}
});

test('forged or foreign cursors are rejected',async()=>{
  const f=fixture();try{
  f.seed(WS,1);
  const cursor=String((await request(f.app).get('/api/invoice-events').expect(200)).body.nextCursor);
  const mac=Buffer.from(cursor,'base64url').toString().split('.')[2];
  const forge=(text:string)=>Buffer.from(text,'utf8').toString('base64url');
  for(const bad of [forge('v1.0.'+'0'.repeat(64)),forge('v1.5.'+mac),forge('v2.1.'+mac),forge('v1.01.'+mac),cursor.slice(0,-1),cursor+'=',cursor+'x','not-a-cursor'])await request(f.app).get('/api/invoice-events').query({cursor:bad}).expect(400);
  }finally{f.close();}
});

test('responses are redacted and exclude customer, capability and provider material',async()=>{
  const f=fixture();try{
  f.seed(WS,1);
  const page=await request(f.app).get('/api/invoice-events').expect(200);
  const text=JSON.stringify(page.body);
  for(const secret of [f.invoice.customerName,f.invoice.customerEmail!,f.invoice.note!,f.invoice.token,f.invoice.number])assert(!text.includes(secret));  assert.deepEqual(Object.keys(page.body.events[0]).sort(),['currency','effectiveTotal','id','invoiceId','mode','occurredAt','payment','seq','total','type']);
  }finally{f.close();}
});

test('local unencrypted installations serve the same authenticated feed',async()=>{
  const f=fixture(false);try{
  f.seed(WS,1);
  const page=await request(f.app).get('/api/invoice-events').expect(200);
  assert.equal(page.body.events.length,1);
  assert.match(Buffer.from(String(page.body.nextCursor),'base64url').toString(),/^v1\.1\.[0-9a-f]{64}$/);
  await request(f.app).get('/api/invoice-events').query({cursor:Buffer.from('v1.0.'+'0'.repeat(64),'utf8').toString('base64url')}).expect(400);
  }finally{f.close();}
});
