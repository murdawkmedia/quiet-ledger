import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createInvoice,publicInvoice,settleInvoice} from '../server/domain.js';
import {InvoiceTemplates} from '../server/invoice-templates.js';
import {DomainError,Store} from '../server/store.js';

const now=new Date('2026-11-06T12:00:00.000Z'),workspace='fictional-billing-workspace',key=Buffer.alloc(32,47);
const draft={customerName:'Fictional customer',customerEmail:'private-client@fictional.example',title:'Fictional workshop service',currency:'CAD',items:[{description:'Fictional service',quantity:3,unitAmount:10001}],taxBps:500,discountBps:1000,premiumBps:250};
const billing=()=>({sellerName:'Fictional Studio',sellerEmail:'invoices@fictional.example',sellerAddress:'123 Fictional Lane\nExample City',sellerTaxId:'FICTIONAL_TAX_REFERENCE_41723',customerAddress:'456 Fictional Lane\nAnother Example City'});
const invalid=(fn:()=>unknown)=>assert.throws(fn,error=>error instanceof DomainError&&error.status===400);

test('issued billing is an encrypted snapshot that survives restart and caller mutation',()=>{
  const directory=mkdtempSync(join(tmpdir(),'ql-billing-fixture-')),path=join(directory,'billing.sqlite');
  let store=new Store(path,{encryptionKey:key});
  try{
    const original=billing(),expected={...original};
    const invoice=createInvoice(store,workspace,{...draft,billing:original},now);
    original.sellerName='Fictional renamed studio';original.customerAddress='Fictional changed address';
    assert.deepEqual(invoice.billing,expected);
    const stored=String(store.db.prepare('SELECT data FROM invoices WHERE id=? AND workspace=?').get(invoice.id,workspace)!.data);
    assert.match(stored,/^qlr:v1:/);
    for(const value of Object.values(expected))assert.ok(!stored.includes(value));
    store.close();store=new Store(path,{encryptionKey:key});
    assert.deepEqual(store.getInvoice(invoice.id,workspace)?.billing,expected);
    assert.equal(store.getInvoice(invoice.id,'another-fictional-workspace'),undefined);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('billing normalization trims edges, preserves address lines and omits blank optional fields',()=>{
  const store=new Store(':memory:');try{
    const invoice=createInvoice(store,workspace,{...draft,billing:{sellerName:'  Fictional Studio  ',sellerEmail:' ',sellerAddress:'  123 Fictional Lane\nExample City  ',customerAddress:' ',sellerTaxId:''}},now);
    assert.deepEqual(invoice.billing,{sellerName:'Fictional Studio',sellerAddress:'123 Fictional Lane\nExample City'});
    assert.deepEqual(publicInvoice(invoice).billing,invoice.billing);
  }finally{store.close();}
});

test('strict billing validation rejects unknown malformed oversized and header-shaped fields before any writes',()=>{
  const store=new Store(':memory:');try{
    const invalidBilling=[null,[],{},'Fictional Studio',
      {sellerName:''},{sellerName:' '},{sellerName:'N'.repeat(121)},{sellerName:1},
      {sellerName:'Fictional Studio',workspace:'other'},
      {sellerName:'Fictional Studio',customerEmail:'another@fictional.example'},
      {sellerName:'Fictional Studio',sellerAddress:'A'.repeat(1001)},
      {sellerName:'Fictional Studio',customerAddress:'A'.repeat(1001)},
      {sellerName:'Fictional Studio',sellerAddress:[]},
      {sellerName:'Fictional Studio',customerAddress:3},
      {sellerName:'Fictional Studio',sellerTaxId:'T'.repeat(81)},
      {sellerName:'Fictional Studio',sellerTaxId:'Fictional\nidentifier'},
      {sellerName:'Fictional Studio',sellerTaxId:'Fictional\u0000identifier'},
      {sellerName:'Fictional Studio',sellerTaxId:13},
      {sellerName:'Fictional Studio',sellerEmail:'not-a-mailbox'},
      {sellerName:'Fictional Studio',sellerEmail:'a@fictional.example,b@fictional.example'},
      {sellerName:'Fictional Studio',sellerEmail:'Display Name <a@fictional.example>'},
      {sellerName:'Fictional Studio',sellerEmail:'a@fictional.example\r\nBcc:b@fictional.example'},
      {sellerName:'Fictional Studio',sellerEmail:'a@fictional.example\n'},
      {sellerName:'Fictional Studio',sellerEmail:'a'.repeat(255)},
      {sellerName:'Fictional Studio',sellerEmail:12}];
    for(const billing of invalidBilling)invalid(()=>createInvoice(store,workspace,{...draft,billing},now));
    assert.deepEqual(store.listInvoices(workspace),[]);
    assert.deepEqual(store.audits(workspace,true),[]);
  }finally{store.close();}
});

test('billing permits its exact field bounds and one explicit seller mailbox',()=>{
  const store=new Store(':memory:');try{
    const email='a'.repeat(64)+'@'+'b'.repeat(63)+'.'+'c'.repeat(63)+'.'+'d'.repeat(61);
    const expected={sellerName:'N'.repeat(120),sellerEmail:email,sellerAddress:'A'.repeat(1000),customerAddress:'B'.repeat(1000),sellerTaxId:'T'.repeat(80)};
    const invoice=createInvoice(store,workspace,{...draft,billing:expected},now);
    assert.deepEqual(invoice.billing,expected);
  }finally{store.close();}
});

test('public invoice includes the intended billing snapshot while keeping private customer email and tokens private',()=>{
  const store=new Store(':memory:');try{
    const invoice=createInvoice(store,workspace,{...draft,billing:billing()},now),view=publicInvoice(invoice);
    assert.deepEqual(view.billing,billing());
    for(const field of ['id','token','customerEmail','receiptToken'])assert.equal(Object.hasOwn(view,field),false);
    const paid=settleInvoice(store,workspace,invoice,'cashu',now);
    assert.deepEqual(paid.invoice.billing,billing());
    assert.equal(paid.invoice.status,'paid');
    assert.equal(paid.receiptToken,store.getInvoice(invoice.id,workspace)?.receiptToken);
  }finally{store.close();}
});

test('legacy invoices retain an absent billing field and read back without fabricated seller details',()=>{
  const store=new Store(':memory:',{encryptionKey:key});try{
    const invoice=createInvoice(store,workspace,draft,now),stored=store.getInvoice(invoice.id,workspace)!;
    assert.equal(Object.hasOwn(invoice,'billing'),false);
    assert.equal(Object.hasOwn(stored,'billing'),false);
    assert.equal(Object.hasOwn(publicInvoice(stored),'billing'),false);
    assert.equal(stored.total,29141);
  }finally{store.close();}
});

test('adding billing leaves exact totals unchanged for every existing invoice currency',()=>{
  const store=new Store(':memory:');try{
    for(const currency of ['CAD','USD','EUR','GBP','KRW']){
      const plain=createInvoice(store,workspace,{...draft,currency},now),withBilling=createInvoice(store,workspace,{...draft,currency,billing:billing()},now);
      for(const field of ['subtotal','tax','discountAmount','premiumAmount','total','totalCad','amountSats'] as const)assert.equal(withBilling[field],plain[field]);
    }
  }finally{store.close();}
});

test('billing travels through saved invoice templates and later template edits cannot rewrite issued snapshots',()=>{
  const store=new Store(':memory:',{encryptionKey:key});try{
    const templates=new InvoiceTemplates(store),template=templates.save(workspace,{label:'Fictional billing template',draft:{...draft,billing:billing()}});
    const invoice=createInvoice(store,workspace,template.draft,now),expected=billing();
    templates.save(workspace,{id:template.id,label:template.label,draft:{...draft,billing:{sellerName:'Fictional new studio'}}});
    assert.deepEqual(store.getInvoice(invoice.id,workspace)?.billing,expected);
    assert.deepEqual(templates.list(workspace)[0].draft.billing,{sellerName:'Fictional new studio'});
    const legacy=templates.save(workspace,{label:'Fictional legacy template',draft});
    assert.equal(Object.hasOwn(legacy.draft,'billing'),false);
  }finally{store.close();}
});
