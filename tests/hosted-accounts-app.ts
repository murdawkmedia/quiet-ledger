import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.js';

// Isolated fictional signup fixture. This never opens the real local runtime.
const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-hosted-browser-'));
const origin='http://localhost:4332';
const proxySecret='synthetic-hosted-browser-proxy-at-least32-bytes';
const app=createApp({dbPath:join(directory,'fictional.sqlite'),ownerToken:'synthetic-unused-hosted-owner',encryptionKey:Buffer.alloc(32,7),hosted:{publicOrigin:origin,proxySecret,allowInsecureLoopback:true}});
const outer=express();
outer.use((req,_res,next)=>{req.headers['x-quiet-ledger-proxy']=proxySecret;req.headers['x-quiet-ledger-client-ip']='127.0.0.1';next();});
outer.use(app);
outer.use(express.static(resolve('dist/client')));
outer.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/client/index.html')));
const server=outer.listen(4332,'127.0.0.1',()=>console.log('Synthetic hosted account browser fixture ready.'));
let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));app.locals.close();rmSync(directory,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
