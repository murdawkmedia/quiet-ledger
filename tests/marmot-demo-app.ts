import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.js';

// Temporary encrypted fictional data only. Never opens an existing runtime.
const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-marmot-browser-'));
const origin='http://localhost:4335';
const proxySecret='fictional-marmot-browser-proxy-at-least32-bytes';
const hosted={publicOrigin:origin,proxySecret,allowInsecureLoopback:true,hackathonDemo:true};
const app=createApp({dbPath:join(directory,'fictional.sqlite'),ownerToken:'fictional-unused-marmot-owner',encryptionKey:Buffer.alloc(32,53),hosted,simulationOnly:true});
const outer=express();
outer.use((req,_res,next)=>{
  // Browser tests represent separate clients while retaining real application quotas.
  // This fixture-only cookie never participates in production proxy trust.
  const client=Number(req.headers.cookie?.match(/(?:^|;\s*)ql_fixture_client=([1-9]\d{0,2})(?:;|$)/)?.[1]);
  req.headers['x-quiet-ledger-proxy']=proxySecret;
  req.headers['x-quiet-ledger-client-ip']=Number.isInteger(client)&&client>0&&client<255?`198.51.100.${client}`:'127.0.0.1';next();
});
outer.use(app);
outer.use(express.static(resolve('dist/client')));
outer.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/client/index.html')));
const server=outer.listen(4335,'127.0.0.1',()=>console.log('Isolated fictional Marmot browser fixture ready.'));
let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));app.locals.close();rmSync(directory,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());
process.on('SIGINT',()=>void close());
