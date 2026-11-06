import test from 'node:test';
import assert from 'node:assert/strict';
import * as mail from '../server/invoice-delivery.js';
import {DomainError,Store} from '../server/store.js';

const invalid=(error:unknown)=>error instanceof DomainError&&error.status===400;

test('generated reply headers accept only bounded single addresses and RFC message identities',()=>{
 assert.equal(typeof mail.invoiceMailThreadHeaders,'function');
 const headers={replyTo:'merchant@example.test',inReplyTo:'<parent@ledger.example>',references:['<root@ledger.example>','<parent@ledger.example>']};
 assert.deepEqual(mail.invoiceMailThreadHeaders(headers),headers);assert.deepEqual(mail.invoiceMailThreadHeaders({}),{});
 for(const input of [{replyTo:'merchant@example.test\r\nBcc: hidden@example.test'},{replyTo:'Name <merchant@example.test>'},{replyTo:'one@example.test,two@example.test'},{inReplyTo:'<parent@ledger.example>\r\nBcc: hidden@example.test'},{inReplyTo:'parent@ledger.example'},{inReplyTo:'<parent@ledger.example> <other@ledger.example>'},{inReplyTo:`<${'x'.repeat(255)}@ledger.example>`},{references:[]},{references:['<root@ledger.example>\nSubject: injected']},{references:Array.from({length:33},(_,index)=>`<${index}@ledger.example>`)},{references:'<root@ledger.example>'},{replyTo:'merchant@example.test',headers:{Bcc:'hidden@example.test'}}])assert.throws(()=>mail.invoiceMailThreadHeaders(input),invalid);
});

test('the fixed Gmail transport validates reply headers before opening a socket',async()=>{
 let sockets=0;const transport=await mail.createGmailTransport({senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'},()=>{sockets++;throw new Error('A network connection is not permitted in this test.');});
 try{
  await assert.rejects(transport.sendMail({from:'merchant@example.test',to:['client@example.test'],cc:[],subject:'Invoice',text:'Fictional invoice',messageId:'<generated@ledger.example>',replyTo:'merchant@example.test\r\nBcc: hidden@example.test',disableFileAccess:true,disableUrlAccess:true}),invalid);assert.equal(sockets,0);
 }finally{transport.close?.();}
});

test('public invoice compose inputs cannot supply mail thread headers',()=>{
 const store=new Store(':memory:');const delivery=new mail.InvoiceDelivery(store,{publicOrigin:'https://ledger.example'});
 try{
  store.addInvoice('fixture',{id:'fixture',number:'INV-1',token:'fixture-token',title:'Fictional work',customerName:'Fictional client',currency:'CAD',items:[{description:'Work',quantity:1,unitAmount:100}],taxBps:0,subtotal:100,tax:0,total:100,totalCad:100,amountSats:1,status:'open',createdAt:'2026-11-06T10:00:00.000Z'});
  for(const extra of [{replyTo:'other@example.test'},{inReplyTo:'<other@ledger.example>'},{references:['<other@ledger.example>']}])assert.throws(()=>delivery.compose('fixture','fixture',{action:'preview',to:['client@example.test'],copyToSelf:false,...extra},'headers',{demo:false}),invalid);
 }finally{store.close();}
});
