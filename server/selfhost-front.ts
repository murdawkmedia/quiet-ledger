import {MARMOT_RELAY_CSP} from '../shared/marmot-relays.js';
import express, {type Express} from 'express';
import type {IncomingMessage} from 'node:http';
import {isIP} from 'node:net';
import {lstatSync,realpathSync,readdirSync} from 'node:fs';
import {extname,join,resolve} from 'node:path';

export interface SelfHostFrontendOptions {clientDir:string;proxySecret:string;publicOrigin:string}
/** The in-process self-host front is the trusted proxy. Caller-provided proxy/IP
 * headers never acquire authority, including on WebSocket upgrade requests. */
export function prepareSelfHostRequest(request:IncomingMessage,proxySecret:string){
  for(const header of ['x-quiet-ledger-proxy','x-quiet-ledger-client-ip','forwarded','x-forwarded-for','x-forwarded-proto','x-forwarded-host','x-forwarded-port','x-real-ip','cf-connecting-ip'])delete request.headers[header];
  const address=request.socket.remoteAddress;
  request.headers['x-quiet-ledger-proxy']=proxySecret;
  request.headers['x-quiet-ledger-client-ip']=address&&isIP(address)?address:'unknown';
}
function checkedClientDirectory(input:string){
  const directory=resolve(input);
  if(realpathSync(directory)!==directory||!lstatSync(directory).isDirectory())throw new Error('Self-host frontend needs a real built client directory.');
  let count=0;
  const inspect=(path:string)=>{
    const info=lstatSync(path);if(info.isSymbolicLink())throw new Error('Self-host client files cannot contain symlinks.');
    if(info.isDirectory())for(const name of readdirSync(path))inspect(join(path,name));
    else if(!info.isFile()||++count>2000||info.size>16*1024*1024)throw new Error('Self-host frontend contains unsupported build files.');
  };
  inspect(directory);
  if(!lstatSync(join(directory,'index.html')).isFile())throw new Error('Build the client before starting the self-host frontend.');
  return directory;
}
/** Standalone static/client + encrypted account API. No Cloudflare or outside
 * service is needed to route requests. This does not change hosted API-only mode. */
export function createSelfHostFrontend(api:Express,options:SelfHostFrontendOptions):Express{
  const clientDir=checkedClientDirectory(options.clientDir),origin=new URL(options.publicOrigin);
  if(origin.origin!==options.publicOrigin||origin.username||origin.password||origin.search||origin.hash||!(origin.protocol==='https:'||(origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))||! /^[\x21-\x7e]{32,512}$/.test(options.proxySecret))throw new Error('Invalid self-host frontend configuration.');
  const websocketOrigin=origin.origin.replace(/^http/,'ws');
  const app=express();app.disable('x-powered-by');app.set('trust proxy',false);
  app.locals.prepareUpgradeRequest=(request:IncomingMessage)=>prepareSelfHostRequest(request,options.proxySecret);
  app.use((_req,res,next)=>{
    res.set('X-Content-Type-Options','nosniff');res.set('Referrer-Policy','no-referrer');res.set('X-Frame-Options','DENY');
    res.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');res.set('X-Robots-Tag','noindex, nofollow');res.set('Cache-Control','no-store');
    res.set('Content-Security-Policy',`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ${websocketOrigin} ${MARMOT_RELAY_CSP}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`);
    next();
  });
  const backend=(path:string)=>path==='/api'||path.startsWith('/api/')||path==='/marmot'||path.startsWith('/marmot/');
  app.use((req,res,next)=>{if(!backend(req.path))return next();prepareSelfHostRequest(req,options.proxySecret);return api(req,res,next);});
  app.use((req,res,next)=>backend(req.path)?res.status(404).json({error:'API route not found.'}):next());
  // An accidentally copied private filename must not be served as a static file.
  app.use((req,res,next)=>{if(req.path.split('/').some(part=>part.startsWith('.')||/\.(?:sqlite(?:-wal|-shm)?|db|qlb|env)$/i.test(part))||/^\/(?:data|secrets|backups)(?:\/|$)/i.test(req.path))return res.status(404).end();next();});
  app.use(express.static(clientDir,{index:false,dotfiles:'deny',maxAge:0,setHeaders:res=>res.setHeader('Cache-Control','no-store')}));
  app.get('/{*path}',(req,res)=>{if(extname(req.path))return res.status(404).end();return res.sendFile(join(clientDir,'index.html'));});
  app.use((_req,res)=>res.status(404).end());
  return app;
}
