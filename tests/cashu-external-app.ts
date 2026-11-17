import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.js';
import type {HttpFetch} from '../integrations/http.js';

// Fictional accounts and encrypted SQLite only. This fixture never opens the
// local runtime and never contacts a wallet, mint or provider: any transport
// attempt is counted and fails, proving the external Cashu journey is offline.
const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-cashu-external-browser-'));
const origin='http://localhost:4336',proxySecret='synthetic-cashu-external-proxy-at-least32';
let transportCalls=0;
const connectionFetcher:HttpFetch=async()=>{transportCalls++;throw new Error('Unexpected transport in the external Cashu browser fixture.');};
const app=createApp({dbPath:join(directory,'fictional.sqlite'),ownerToken:'synthetic-unused-cashu-external-owner',encryptionKey:Buffer.alloc(32,41),hosted:{publicOrigin:origin,proxySecret,allowInsecureLoopback:true},connectionFetcher});
const outer=express();
outer.get('/_fixture/transport-calls',(_req,res)=>res.json({calls:transportCalls}));
outer.use((req,_res,next)=>{req.headers['x-quiet-ledger-proxy']=proxySecret;req.headers['x-quiet-ledger-client-ip']='127.0.0.1';next();});
outer.use(app);
outer.use(express.static(resolve('dist/client')));
outer.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/client/index.html')));
const server=outer.listen(4336,'127.0.0.1',()=>console.log('Fictional external Cashu wallet browser fixture ready.'));
let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));app.locals.close();rmSync(directory,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
