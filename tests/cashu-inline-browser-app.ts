import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import * as bolt11 from 'bolt11';
import {createApp} from '../server/app.js';
import {createCoinosPosAdapter} from '../integrations/coinos-pos.js';
import {createSelfHostFrontend} from '../server/selfhost-front.js';
const root=mkdtempSync(join(tmpdir(),'ql-cashu-browser-')),origin='http://localhost:4367',proxy='fictional-cashu-inline-browser-proxy-32';
const invoices=new Map<string,{created:number;pr:string;paid:boolean}>();let creates=0;
const adapter=createCoinosPosAdapter({id:'fictional-cashu-browser',token:'ab'.repeat(32),expectedAddress:'countzapula@coinos.io',fetcher:async(url,init)=>{
 const path=new URL(url).pathname;
 if(path==='/pos/me')return Response.json({username:'countzapula',address:'countzapula@coinos.io',currency:'CAD'});
 if(path==='/pos/invoice'&&init?.method==='POST'){
  if(init.body!=='{"amount":21}')throw new Error('Fictional provider requires21sats.');
  const created=Date.now(),preimage=createHash('sha256').update('fictional-cashu-browser-'+(++creates)).digest('hex'),hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
  const metadata=JSON.stringify([['text/plain','Paying countzapula@coinos.io'],['text/identifier','countzapula@coinos.io']]);
  const pr=bolt11.sign(bolt11.encode({timestamp:Math.floor(created/1000),millisatoshis:'21000',tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:createHash('sha256').update(metadata).digest('hex')},{tagName:'expire_time',data:900}]}),'0'.repeat(63)+'1').paymentRequest!;
  invoices.set(hash,{created,pr,paid:false});return Response.json({id:hash,hash:pr,amount:21,created,currency:'CAD'});
 }
 const hash=path.split('/').at(-1)!,invoice=invoices.get(hash);
 if(invoice&&path==='/pos/invoice/'+hash)return Response.json({id:hash,amount:21,tip:0,received:invoice.paid?21:0,paid:invoice.paid?Date.now():null,created:invoice.created});
 throw new Error('Unexpected fictional provider endpoint.');
}});
const api=createApp({dbPath:join(root,'fictional.sqlite'),encryptionKey:Buffer.alloc(32,61),hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true,allowInsecureLoopback:true},demoLiveAdapter:adapter});
const front=createSelfHostFrontend(api,{clientDir:resolve('dist/client'),proxySecret:proxy,publicOrigin:origin}),outer=express();
outer.use(express.json());
outer.get('/__fixture/status',(_req,res)=>res.json({creates}));
outer.post('/__fixture/settle',(req,res)=>{const invoice=invoices.get(req.body.paymentHash);if(!invoice)return res.sendStatus(404);invoice.paid=true;res.json({fictional:true});});
outer.use(front);const server=outer.listen(4367,'127.0.0.1');let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await api.locals.closeAsync();rmSync(root,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
