import { mkdirSync, existsSync, chmodSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createApp } from './app.js';
import { loadSquareSandboxOptions } from './square-config.js';
import {loadReceivingConnections} from './receiving-config.js';
import type {ApiScope} from './api-access.js';
import {loadOrCreatePrivateToken} from './private-token.js';
import {loadHostedRuntime} from './hosted-runtime.js';
import {loadDemoAgentRuntime} from './demo-agent-runtime.js';
import {createSelfHostFrontend} from './selfhost-front.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hostedRuntime=loadHostedRuntime(process.env);
if(hostedRuntime&&(!process.env.DATA_DIR||!process.env.DATA_DIR.startsWith('/')))throw new Error('Hosted mode requires an explicit private DATA_DIR.');
const dataDir = resolve(process.env.DATA_DIR ?? join(root, '.runtime'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
chmodSync(dataDir, 0o700);
const tokenPath = join(dataDir, 'owner-token');
const ownerToken = hostedRuntime?undefined:process.env.OWNER_TOKEN??loadOrCreatePrivateToken(tokenPath);
const configuredHosts=process.env.ALLOWED_HOSTS?.split(',').map(host=>host.trim()).filter(Boolean);
const allowedHosts=configuredHosts?.length?configuredHosts:hostedRuntime?.selfHosted?[new URL(hostedRuntime.hosted.publicOrigin).hostname,'localhost','127.0.0.1','[::1]']:undefined;
const apiTokenPath=join(dataDir,'api-token');
const apiToken=hostedRuntime?undefined:loadOrCreatePrivateToken(apiTokenPath);
const apiScopes:ApiScope[]=['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read'];
const connections=hostedRuntime?undefined:loadReceivingConnections(process.env.RECEIVING_CONNECTIONS_FILE);
const demoTeam=loadDemoAgentRuntime(process.env);
const app = createApp({communications:{background:true},demoTeam,dbPath:join(dataDir,'ledger.sqlite'),ownerToken,allowedHosts:allowedHosts?.length?allowedHosts:undefined,
  ...(hostedRuntime?hostedRuntime:{privateScenarioPath:process.env.PRIVATE_SCENARIO_PATH,squareSandbox:loadSquareSandboxOptions(process.env),receivingAdapters:connections!.adapters,collateral:connections!.collateral,arkConnections:connections!.arkConnections,apiKeys:[{token:apiToken!,scopes:apiScopes}]})});
const host = process.env.HOST ?? '127.0.0.1';
const port = Number(process.env.PORT ?? (hostedRuntime?.selfHosted?'4417':'4317'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid TCP port.');
let vite: { close: () => Promise<void> } | undefined;
let requestApp=app;
if(hostedRuntime){
  if(process.env.NODE_ENV!=='production')throw new Error('Hosted mode requires the production runtime.');
  if(hostedRuntime.selfHosted){
    const clientDir=process.env.SELFHOST_CLIENT_DIR??(existsSync(join(root,'public/index.html'))?join(root,'public'):join(root,'dist/client'));
    requestApp=createSelfHostFrontend(app,{clientDir,proxySecret:hostedRuntime.hosted.proxySecret,publicOrigin:hostedRuntime.hosted.publicOrigin});
  }else app.use((_req,res)=>res.status(404).json({error:'API route not found.'}));
} else if (process.env.NODE_ENV === 'production') {
  const clientDir = join(root, 'dist/client');
  if (!existsSync(join(clientDir, 'index.html'))) throw new Error('Build the client with npm run build before production start.');
  app.use(express.static(clientDir, { index: false, maxAge: 0 }));
  app.get('/{*path}', (_req, res) => res.sendFile(join(clientDir, 'index.html')));
} else {
  const { createServer } = await import('vite');
  const development = await createServer({ root: join(root, 'client'), configFile: join(root, 'vite.config.ts'), server: { middlewareMode: true, hmr: { port: port + 1 } }, appType: 'spa' });
  vite = development;
  app.use(development.middlewares);
}
const server = requestApp.listen(port, host, () => {
  console.log(`Quiet Ledger ready at ${hostedRuntime?.selfHosted?hostedRuntime.hosted.publicOrigin:`http://${host}:${port}`}; payouts remain simulated.`);
  console.log(hostedRuntime?`${hostedRuntime.selfHosted?'Private self-hosted':'Hosted'} accounts enabled. ${hostedRuntime.hosted.hackathonDemo?'Hackathon demo is explicitly enabled.':'No accounts are seeded.'}`:`Receiving: ${connections!.adapters.length} configured adapter(s). Live/test mode is explicit; no wallet is selected automatically.`);
  if(!hostedRuntime)console.log('Private owner access uses the local owner-token file in DATA_DIR. No token is logged.');
});
if(hostedRuntime){
  if(hostedRuntime.selfHosted)server.on('upgrade',req=>requestApp.locals.prepareUpgradeRequest(req));
  app.locals.demoTeam?.attachRelay(server,{proxySecret:hostedRuntime.hosted.proxySecret});
}
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await app.locals.demoTeam?.close();
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
  await vite?.close();
  await app.locals.closeAsync();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
