import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createApp} from '../server/app.js';

test('invoice issuance requires an explicit retry key so uncertain submissions cannot silently duplicate',async()=>{
  const app=createApp({dbPath:':memory:',ownerToken:'regression-fixture-owner-token'});
  try{
    const user=request.agent(app);
    const session=await user.post('/api/session/demo').send({});
    const input={customerName:'Fictional buyer',title:'Retry-safe invoice',currency:'CAD',items:[{description:'Service',quantity:1,unitAmount:1000}]};
    const before=(await user.get('/api/invoices')).body.invoices.length;
    await user.post('/api/invoices').set('X-CSRF-Token',session.body.csrfToken).send(input).expect(400);
    const after=(await user.get('/api/invoices')).body.invoices.length;
    assert.equal(before,after);
    const first=await user.post('/api/invoices').set('X-CSRF-Token',session.body.csrfToken).set('Idempotency-Key','explicit-issue-key').send(input).expect(201);
    const retry=await user.post('/api/invoices').set('X-CSRF-Token',session.body.csrfToken).set('Idempotency-Key','explicit-issue-key').send(input).expect(201);
    assert.equal(first.body.id,retry.body.id);
  }finally{app.locals.close();}
});
