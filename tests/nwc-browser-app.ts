// Loopback-only actual-app fixture. All identities/invoices are fictional.
import express from 'express';
import {randomUUID,randomBytes} from 'node:crypto';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createApp} from '../server/app.js';
import {Store} from '../server/store.js';
import {fictionalNwcWallet} from './fixtures/nwc-wallet.js';
const directory=mkdtempSync(join(tmpdir(),'ql-nwc-browser-')),dbPath=join(directory,'ledger.sqlite'),encryptionKey=Buffer.alloc(32,53);
const origin='http://localhost:4364',proxy='fictional-nwc-browser-proxy-at-least32',wallet=fictionalNwcWallet();
const app=createApp({dbPath,encryptionKey,hosted:{publicOrigin:origin,proxySecret:proxy,allowInsecureLoopback:true},nwcTransport:wallet.transport});
const token=randomBytes(32).toString('base64url'),store=new Store(dbPath,{encryptionKey});store.saveSession(token,{role:'owner',accountId:randomUUID(),workspace:randomUUID(),csrf:'fictional-nwc-browser-csrf',expires:new Date(Date.now()+3600000).toISOString()});store.close();
const outer=express();outer.get('/__fixture/enter',(_req,res)=>{res.setHeader('Set-Cookie',`ql_session=${token}; HttpOnly; SameSite=Lax; Path=/`);res.redirect('/integrations');});
outer.get('/__fixture/status',(_req,res)=>res.json({calls:wallet.calls}));outer.post('/__fixture/paid',async(_req,res)=>{wallet.setPaid(true);await app.locals.detectPayments();res.json({fictional:true});});
outer.use((req,_res,next)=>{req.headers['x-quiet-ledger-proxy']=proxy;req.headers['x-quiet-ledger-client-ip']='127.0.0.1';next();});outer.use(app);outer.use(express.static(resolve('dist/client')));outer.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/client/index.html')));
const server=outer.listen(4364,'127.0.0.1');let closed=false;
async function close(){if(closed)return;closed=true;server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));await app.locals.closeAsync();rmSync(directory,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
