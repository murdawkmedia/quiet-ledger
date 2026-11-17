import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import * as bolt11 from 'bolt11';
import {createApp} from '../server/app.js';
import {createCoinosPosAdapter} from '../integrations/coinos-pos.js';

// Actual app/browser integration with a controlled provider. No real Coinos,
// mint, wallet, relay or model is contacted; scalar1 is a published fixture key.
const root=mkdtempSync(join(tmpdir(),'ql-demo-live-browser-'));
const origin='http://localhost:4359',proxy='fictional-demo-live-browser-proxy-value-32';
const invoices=new Map<string,{created:number;pr:string}>();let creates=0,paid=false;
const adapter=createCoinosPosAdapter({id:'fictional-live-browser',token:'ab'.repeat(32),expectedAddress:'countzapula@coinos.io',fetcher:async(url,init)=>{
  const path=new URL(url).pathname;
  if(path==='/pos/me')return Response.json({username:'countzapula',address:'countzapula@coinos.io',currency:'CAD'});
  if(path==='/pos/invoice'&&init?.method==='POST'){
    if(init.body!=='{"amount":21}')throw new Error('Fictional provider requires21sats.');
    const created=Date.now(),hash=createHash('sha256').update('fictional-browser-'+(++creates)).digest('hex');
    const metadata=JSON.stringify([['text/plain','Paying countzapula@coinos.io'],['text/identifier','countzapula@coinos.io']]);
    const pr=bolt11.sign(bolt11.encode({network:{bech32:'bc',pubKeyHash:0,scriptHash:5,validWitnessVersions:[0,1]},timestamp:Math.floor(created/1000),millisatoshis:'21000',tags:[{tagName:'payment_hash',data:hash},{tagName:'purpose_commit_hash',data:createHash('sha256').update(metadata).digest('hex')},{tagName:'expire_time',data:900}]}),'0'.repeat(63)+'1').paymentRequest!;
    invoices.set(hash,{created,pr});return Response.json({id:hash,hash:pr,amount:21,created,currency:'CAD'});
  }
  const hash=path.split('/').at(-1)!,invoice=invoices.get(hash);
  if(invoice&&path==='/pos/invoice/'+hash)return Response.json({id:hash,amount:21,tip:0,received:paid?21:0,paid:paid?Date.now():null,created:invoice.created});
  throw new Error('Unexpected fictional provider endpoint.');
}});
const app=createApp({dbPath:join(root,'fictional.sqlite'),encryptionKey:Buffer.alloc(32,63),hosted:{publicOrigin:origin,proxySecret:proxy,hackathonDemo:true,allowInsecureLoopback:true},demoLiveAdapter:adapter});
const outer=express();
outer.get('/__fixture/status',(_req,res)=>res.json({creates,paid}));
outer.post('/__fixture/settle',(_req,res)=>{paid=true;res.json({fictional:true});});
outer.use((req,_res,next)=>{req.headers['x-quiet-ledger-proxy']=proxy;req.headers['x-quiet-ledger-client-ip']='127.0.0.1';next();});
outer.use(app);outer.use(express.static(resolve('dist/client')));
outer.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/client/index.html')));
const server=outer.listen(4359,'127.0.0.1');let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await app.locals.closeAsync();rmSync(root,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
