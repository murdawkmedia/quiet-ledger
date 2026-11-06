import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer,connect,type Socket} from 'node:net';
import type {TLSSocket} from 'node:tls';
import {createGmailTransport,InvoiceDelivery} from '../server/invoice-delivery.js';
import {Store} from '../server/store.js';

test('the real Nodemailer adapter destroys the owned connection on close before a delayed SMTP greeting',async()=>{
 let peer:Socket|undefined,connected!:()=>void,closed!:()=>void,secured!:()=>void;const connection=new Promise<void>(resolve=>{connected=resolve;}),closure=new Promise<void>(resolve=>{closed=resolve;}),ready=new Promise<void>(resolve=>{secured=resolve;});const received:string[]=[];
 const server=createServer(socket=>{peer=socket;socket.on('data',data=>received.push(data.toString()));socket.once('close',closed);connected();});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();assert.ok(address&&typeof address!=='string');
 const transport=await createGmailTransport({senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'},options=>{
  assert.equal(options.host,'smtp.gmail.com');assert.equal(options.port,465);assert.equal(options.servername,'smtp.gmail.com');assert.equal(options.rejectUnauthorized,true);
  const socket=connect(address.port,'127.0.0.1');socket.once('connect',()=>{socket.emit('secureConnect');setImmediate(secured);});return socket as unknown as TLSSocket;
 });
 try{
  const rejected=assert.rejects(transport.verify());await connection;await ready;transport.close!();await rejected;
  await Promise.race([closure,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new Error('Owned SMTP connection stayed open.')),1000);timer.unref();})]);
  assert.equal(peer!.destroyed,true);assert.deepEqual(received,[]);
 }finally{transport.close?.();peer?.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
test('a failed connection check clears stale verified status without changing the stored sender',async()=>{
 const store=new Store(':memory:',{encryptionKey:Buffer.alloc(32,91)});let accepted=true;
 const delivery=new InvoiceDelivery(store,{publicOrigin:'https://ledger.example',transportFactory:()=>({verify:async()=>{if(!accepted)throw new Error('Fictional authentication rejected.');return true;},sendMail:async()=>({})})});
 try{delivery.saveSettings('fictional-workspace',{savedRecipients:[],senderEmail:'merchant@example.test',appPassword:'abcdefghijklmnop'});assert.ok((await delivery.verifyGmail('fictional-workspace',{demo:false})).gmailVerifiedAt);accepted=false;await assert.rejects(delivery.verifyGmail('fictional-workspace',{demo:false}));assert.equal(delivery.settings('fictional-workspace').gmailVerifiedAt,undefined);assert.equal(delivery.settings('fictional-workspace').gmailConfigured,true);}finally{store.close();}
});
