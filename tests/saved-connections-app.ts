import express from 'express';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createApp} from '../server/app.js';
import type {HttpFetch} from '../integrations/http.js';

// Fictional accounts and encrypted SQLite only. This fixture never opens the local runtime.
const directory=mkdtempSync(join(tmpdir(),'quiet-ledger-saved-connections-browser-'));
const origin='http://localhost:4333',proxySecret='synthetic-saved-connections-proxy-at-least32-bytes';
let providerReads=0;
const connectionFetcher:HttpFetch=async(url,init={})=>{
  if(url!=='https://api.stripe.com/v1/account'||(init.method??'GET')!=='GET'||init.body!==undefined)throw new Error('Unexpected provider operation in read-only browser fixture.');
  if(new Headers(init.headers).get('Authorization')!=='Bearer sk_test_FICTIONAL_BROWSER_PRIVATE_KEY_83694')throw new Error('Unexpected synthetic credential in browser fixture.');
  providerReads++;
  return Response.json({id:'acct_FICTIONALBROWSER',country:'CA',charges_enabled:true});
};
const app=createApp({dbPath:join(directory,'fictional.sqlite'),ownerToken:'synthetic-unused-saved-connections-owner',encryptionKey:Buffer.alloc(32,37),hosted:{publicOrigin:origin,proxySecret,allowInsecureLoopback:true},connectionFetcher,receivingQuote:async invoice=>({expectedAtomic:String(invoice.total),cadEquivalent:invoice.total,source:'Fixed fictional browser quote; no market/provider request',observedAt:new Date().toISOString()})});
const outer=express();
outer.get('/_fixture/provider-reads',(_req,res)=>res.json({reads:providerReads}));
outer.use((req,_res,next)=>{req.headers['x-quiet-ledger-proxy']=proxySecret;req.headers['x-quiet-ledger-client-ip']='127.0.0.1';next();});
outer.use(app);
outer.use(express.static(resolve('dist/client')));
outer.get('/{*path}',(_req,res)=>res.sendFile(resolve('dist/client/index.html')));
const server=outer.listen(4333,'127.0.0.1',()=>console.log('Fictional saved connections browser fixture ready.'));
let closing=false;
async function close(){if(closing)return;closing=true;server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));app.locals.close();rmSync(directory,{recursive:true,force:true});}
process.on('SIGTERM',()=>void close());process.on('SIGINT',()=>void close());
