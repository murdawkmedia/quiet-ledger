import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Store} from '../server/store.js';import {createInvoice,settleInvoice} from '../server/domain.js';
const key=Buffer.alloc(32,7),input={customerName:'FICTIONAL ENCRYPTED CUSTOMER SENTINEL',title:'Fictional encryption check',currency:'CAD',items:[{description:'Synthetic service',quantity:1,unitAmount:125}],note:'FICTIONAL PRIVATE NOTE SENTINEL'};
test('encrypted SQL records and public-token indices exclude plaintext while retaining scoped reads',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-encrypted-store-'));const path=join(dir,'test.sqlite');const store=new Store(path,{encryptionKey:key});
  try{const invoice=createInvoice(store,'fictional-account-a',input,new Date());
    assert.equal(store.getInvoice(invoice.id,'fictional-account-b'),undefined);assert.equal(store.getInvoice(invoice.id,'fictional-account-a')?.note,input.note);
    assert.equal(store.getCheckout(invoice.token)?.invoice.id,invoice.id);
    settleInvoice(store,'fictional-account-a',invoice,'cashu',new Date());const saved=store.getInvoice(invoice.id)!;assert.ok(store.getReceipt(saved.receiptToken!)?.receipt);
    const raw=JSON.stringify(store.db.prepare('SELECT * FROM invoices').all());assert.ok(!raw.includes(input.customerName));assert.ok(!raw.includes(input.note));assert.ok(!raw.includes(invoice.token));
    store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');const bytes=readFileSync(path);assert.ok(!bytes.includes(Buffer.from(input.customerName)));assert.ok(!bytes.includes(Buffer.from(input.note)));assert.ok(!bytes.includes(Buffer.from(invoice.token)));
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('encrypted records reject ciphertext substitution across accounts and record identities',()=>{
  const store=new Store(':memory:',{encryptionKey:key});try{const a=createInvoice(store,'fictional-a',input,new Date()),b=createInvoice(store,'fictional-b',input,new Date());
    const row=store.db.prepare('SELECT data FROM invoices WHERE id=?').get(a.id)!;store.db.prepare('UPDATE invoices SET data=? WHERE id=?').run(String(row.data),b.id);assert.throws(()=>store.getInvoice(b.id));
  }finally{store.close();}
});
test('encrypted sessions and retry responses survive reopen and expire without plaintext JSON queries',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-encrypted-session-')),path=join(dir,'test.sqlite');let store=new Store(path,{encryptionKey:key});
  try{store.saveSession('fictional-session-token',{role:'owner',workspace:'fictional-account',csrf:'fictional-csrf',expires:'2026-11-05T02:00:00Z'});store.idempotent('fictional-account:operation','fictional-retry-key',{},201,()=>({note:input.note}));store.close();store=new Store(path,{encryptionKey:key});
    assert.equal(store.session('fictional-session-token')?.workspace,'fictional-account');assert.deepEqual(store.idempotent('fictional-account:operation','fictional-retry-key',{},201,()=>{throw new Error('must reuse');}).body,{note:input.note});
    store.removeExpiredSessions('2026-11-05T03:00:00Z');assert.equal(store.session('fictional-session-token'),undefined);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
test('storage mode refuses an existing plaintext database or a missing/wrong encryption key',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ql-encryption-guard-')),path=join(dir,'test.sqlite'),fresh=join(dir,'fresh.sqlite');
  try{let local=new Store(path);createInvoice(local,'owner',input,new Date());local.close();
    assert.throws(()=>new Store(path,{encryptionKey:key}));
    const encrypted=new Store(fresh,{encryptionKey:key});encrypted.close();assert.throws(()=>new Store(fresh));assert.throws(()=>new Store(fresh,{encryptionKey:Buffer.alloc(32,9)}));
    const reopened=new Store(fresh,{encryptionKey:key});reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});
