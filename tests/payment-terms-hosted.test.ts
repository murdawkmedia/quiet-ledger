import test from 'node:test';import assert from 'node:assert/strict';import request from 'supertest';
import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {randomBytes} from 'node:crypto';
import {Store} from '../server/store.js';import {createInvoice} from '../server/domain.js';import {createApp} from '../server/app.js';
test('hosted public invoice includes frozen client-facing terms while private owner note stays hidden',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fictional-hosted-terms-')),dbPath=join(dir,'fixture.sqlite'),encryptionKey=randomBytes(32),store=new Store(dbPath,{encryptionKey});
 const invoice=createInvoice(store,'fictional-terms-workspace',{customerName:'Fictional hosted client',title:'Fictional terms snapshot',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:10000}],issueDate:'2026-11-06',paymentTermDays:90,paymentTerms:'Fictional public terms\nSecond milestone in 30 days.',note:'fictional-owner-note-do-not-publish'},new Date('2026-11-06T12:00:00Z'));store.close();
 const proxy='fictional-proxy-secret-at-least-32-characters',app=createApp({dbPath,encryptionKey,hosted:{publicOrigin:'https://example.test',proxySecret:proxy}});
 try{const result=(await request(app).get('/api/checkout/'+invoice.token).set('x-quiet-ledger-proxy',proxy).expect(200)).body;assert.equal(result.invoice.paymentTermDays,90);assert.equal(result.invoice.dueDate,'2027-02-04');assert.equal(result.invoice.paymentTerms,invoice.paymentTerms);assert.equal(result.invoice.note,undefined);assert(!JSON.stringify(result).includes('fictional-owner-note-do-not-publish'));}
 finally{app.locals.close();rmSync(dir,{recursive:true,force:true});}
});
