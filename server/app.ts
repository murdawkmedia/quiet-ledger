import express, { type Request, type Response, type NextFunction } from 'express';
import {isIP} from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z, ZodError } from 'zod';
import QRCode from 'qrcode';
import { listIntegrations } from '../integrations/catalog.js';
import { fetchReferenceRate } from '../integrations/reference.js';
import { Store, DomainError, hash, type StoredSession } from './store.js';
import { createInvoice, createQuote, approvePayout, advancePayout, settleInvoice, publicInvoice, seedDemo, parse, token } from './domain.js';
import { SquareSandbox,type SquareSandboxOptions } from './square-sandbox.js';
import {InvoiceTemplates} from './invoice-templates.js';
import {InvoiceDelivery,type InvoiceDeliveryOptions} from './invoice-delivery.js';
import {invoiceAllowsMethod,invoiceRequiresManualReport} from '../shared/invoice-options.js';
import {PaymentReports} from './payment-reports.js';
import {METHOD_DEFINITIONS,PAYMENT_METHOD_IDS,methodInfo,receivedValue,canFundPayout} from '../shared/payment-methods.js';
import {WALLET_OPTIONS} from '../shared/wallet-options.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import {ReceivingService,type QuoteReceiving} from './receiving-service.js';
import {quoteReceiving} from './receiving-quote.js';
import {inspectCollateral,type CollateralConfig} from '../integrations/collateral.js';
import {inspectArk,type ArkConnectionConfig} from '../integrations/ark-receiving.js';
import {createApiAccess,type ApiScope} from './api-access.js';
import {createAccountAuth} from './account-auth.js';
import {createAccountApiKeys} from './account-api-keys.js';
import {createAccountConnections} from './account-connections.js';
import {createDemoTeam,type DemoTeamOptions} from './demo-agents.js';
import {HackathonDemo} from './hackathon-demo.js';
import {createMarmotConversationsRouter} from './marmot-conversations.js';
import type {HttpFetch} from '../integrations/http.js';
import {manualReceiving} from './receiving-config.js';
import type {Invoice,Receipt} from '../shared/contracts.js';

export interface AppOptions {
  dbPath: string;
  invoiceEmail?:InvoiceDeliveryOptions;
  demoTeam?:Omit<DemoTeamOptions,'store'|'now'|'getSession'|'getDemoCase'|'publicOrigin'>;
  ownerToken?: string;
  encryptionKey?:Buffer;
  hosted?:{publicOrigin:string;proxySecret:string;hackathonDemo?:boolean;allowInsecureLoopback?:boolean;limits?:{invoicesPerWorkspace?:number;receiveRequestsPerInvoice?:number;idempotencyPerScope?:number;requestsPerMinute?:number}};
  receivingAdaptersForWorkspace?:(workspace:string)=>ReceivingAdapter[];
  connectionFetcher?:HttpFetch;
  privateScenarioPath?: string;
  fxFetcher?: () => Promise<unknown>;
  now?: () => Date;
  simulationOnly?: boolean;
  squareSandbox?: SquareSandboxOptions;
  allowedHosts?: string[];
  receivingAdapters?:ReceivingAdapter[];
  receivingQuote?:QuoteReceiving;
  collateral?:CollateralConfig;
  arkConnections?:ArkConnectionConfig[];
  apiKeys?:{token:string;scopes:ApiScope[]}[];
}

function sessionToken(req: Request): string | undefined {
  const item = req.headers.cookie?.split(';').map(p => p.trim()).find(p => p.startsWith('ql_session='));
  const value = item?.slice('ql_session='.length);
  return value && /^[a-zA-Z0-9_-]{43}$/.test(value) ? value : undefined;
}
function demoResumeToken(req:Request):string|undefined {
  const values=req.headers.cookie?.split(';').map(value=>value.trim()).filter(value=>value.startsWith('ql_demo_resume='))??[];
  const value=values.length===1?values[0].slice('ql_demo_resume='.length):undefined;
  return value&&/^[A-Za-z0-9_-]{43}$/.test(value)?value:undefined;
}
function sameOrigin(req: Request, res: Response, next: NextFunction) {
  const origin = req.get('origin');
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (parsed.origin !== (res.locals.publicOrigin??`${req.protocol}://${req.get('host')}`)) throw new Error('origin');
    } catch { return next(new DomainError(403, 'Cross-origin requests are not permitted.')); }
  }
  const site = req.get('sec-fetch-site');
  if (site === 'cross-site') return next(new DomainError(403, 'Cross-site requests are not permitted.'));
  next();
}
function idempotencyKey(req: Request) { return req.get('idempotency-key'); }
function sendResult(res: Response, result: { status: number; body: unknown }) { res.status(result.status).json(result.body); }
function param(req: Request, name: string) { return String(req.params[name] ?? ''); }

const scenarioCurrency = z.string().regex(/^[A-Za-z]{3}$/);
const scenarioSchema = z.object({
  title: z.string(), sourceDate: z.string().optional(), status: z.string().optional(), summary: z.string().optional(),
  metrics: z.array(z.object({label:z.string(),amount:z.number().int().optional(),value:z.union([z.string(),z.number()]).optional(),currency:scenarioCurrency.optional(),note:z.string().optional()}).passthrough()).optional(),
  obligations: z.array(z.object({label:z.string(),amount:z.number().int(),currency:scenarioCurrency.optional(),status:z.string().optional(),note:z.string().optional()}).passthrough()).optional(),
  conditions: z.array(z.object({label:z.string(),status:z.string().optional(),note:z.string().optional()}).passthrough()).optional(),
  sources: z.array(z.string()).optional(), notes: z.array(z.string()).optional(),
}).passthrough();

export function createApp(options: AppOptions) {
  const simulationOnly = options.simulationOnly ?? process.env.SIMULATION_ONLY !== 'false';
  if (!simulationOnly) throw new Error('Real-money mode is not enabled. This MVP requires simulation mode.');
  const hosted=options.hosted;
  if(!hosted&&(!options.ownerToken||options.ownerToken.length<16||options.ownerToken.length>256))throw new Error('Owner token must contain between 16 and 256 characters.');
  if(hosted){
    const origin=new URL(hosted.publicOrigin),loopback=['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
    if(!options.encryptionKey||options.encryptionKey.length!==32||origin.origin!==hosted.publicOrigin||origin.username||origin.password||origin.search||origin.hash||!(origin.protocol==='https:'||(hosted.allowInsecureLoopback&&loopback&&origin.protocol==='http:'))||!/^[\x21-\x7e]{32,512}$/.test(hosted.proxySecret))throw new Error('Hosted mode requires private encryption, a fixed HTTPS origin and protected proxy transport.');
    if(options.privateScenarioPath||options.squareSandbox||options.collateral||options.arkConnections?.length||options.apiKeys?.length||options.receivingAdapters?.length)throw new Error('Hosted accounts cannot inherit local owner data, credentials or connections.');
  }
  const now = options.now ?? (() => new Date());
  const store = new Store(options.dbPath,{encryptionKey:options.encryptionKey,limits:hosted?.limits});
  // Keep the registry available when disabled so existing/expired demo links cannot become live checkouts.
  const hackathonDemo=hosted?new HackathonDemo({store,now}):undefined;
  const demoEnabled=hosted?.hackathonDemo===true;
  const isHackathonWorkspace=(workspace:string)=>Boolean(hackathonDemo&&store.db.prepare('SELECT 1 FROM hackathon_demo_workspaces WHERE id=?').get(workspace));
  const assertPublicWorkspace=(workspace:string)=>{if(isHackathonWorkspace(workspace)&&(!demoEnabled||!hackathonDemo!.hasWorkspace(workspace)))throw new DomainError(404,'This demo visit is unavailable or expired.');};
  const denyDemoFinancial=(workspace:string)=>{if(isHackathonWorkspace(workspace))throw new DomainError(403,'Use the signed-in demo tour to simulate this fictional payment.');};
  const squareSandbox=new SquareSandbox(store,options.squareSandbox,now);
  const paymentReports=new PaymentReports(store);
  const invoiceTemplates=new InvoiceTemplates(store);
  const invoiceEmail=new InvoiceDelivery(store,{...options.invoiceEmail,publicOrigin:hosted?.publicOrigin??options.invoiceEmail?.publicOrigin??'http://localhost:4317',allowInsecureLoopback:hosted?.allowInsecureLoopback??options.invoiceEmail?.allowInsecureLoopback??!hosted,now});
  const receiving=new ReceivingService(store,hosted?[manualReceiving]:options.receivingAdapters??[],options.receivingQuote??quoteReceiving,now);
  const demoReceiving=hosted?new ReceivingService(store,[],options.receivingQuote??quoteReceiving,now):undefined;
  const accountConnections=hosted?createAccountConnections({store,publicOrigin:hosted.publicOrigin,now,getSession:(_req,res)=>res.locals.session,fetcher:options.connectionFetcher,allowInsecureLoopback:hosted.allowInsecureLoopback}):undefined;
  const scopedReceiving=new Map<string,{revision:string;service:ReceivingService}>();
  const receivingFor=(workspace:string)=>{
    if(isHackathonWorkspace(workspace))return demoReceiving!;
    if(!accountConnections)return receiving;
    const revision=accountConnections.revision(workspace);let cached=scopedReceiving.get(workspace);
    if(!cached||cached.revision!==revision){
      const adapters=[...accountConnections.adaptersForWorkspace(workspace),...(options.receivingAdaptersForWorkspace?.(workspace)??[manualReceiving])];
      cached={revision,service:new ReceivingService(store,adapters,options.receivingQuote??quoteReceiving,now,hosted?.publicOrigin)};
      if(scopedReceiving.size>=128)scopedReceiving.delete(scopedReceiving.keys().next().value!);scopedReceiving.set(workspace,cached);
    }return cached.service;
  };
  const walletOptions=(workspace='owner')=>WALLET_OPTIONS.map(option=>({...option,configured:receivingFor(workspace).metadata().some(adapter=>adapter.walletOptionIds?.includes(option.id))}));
  const receivingForToken=(value:string)=>{const row=store.db.prepare('SELECT workspace FROM receiving_requests WHERE token=?').get(store.tokenIndex(value));if(!row)throw new DomainError(404,'Receive request not found.');denyDemoFinancial(String(row.workspace));return receivingFor(String(row.workspace));};
  const publicView=(invoice:Invoice)=>{const value=publicInvoice(invoice);if(!hosted)return value;const {note:_note,nativePayment,...safe}=value;return {...safe,...(nativePayment?{nativePayment:{asset:nativePayment.asset,atomicAmount:nativePayment.atomicAmount,network:nativePayment.network,verification:nativePayment.verification}}:{})};};
  const publicReceipt=(receipt:Receipt)=>{if(!hosted||!receipt.nativePayment)return receipt;const {paymentId:_paymentId,...proof}=receipt.nativePayment;return {...receipt,nativePayment:proof};};
  if(!hosted)seedDemo(store, now());
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  const demoTeam=hosted?createDemoTeam({...options.demoTeam,store,now,publicOrigin:hosted.publicOrigin,allowLoopbackRelays:hosted.allowInsecureLoopback,
    getSession:(_req,res)=>{const session=res.locals.session as StoredSession|undefined;return demoEnabled&&session&&hackathonDemo!.sessionValid(session)?session:undefined;},
    getDemoCase:workspace=>{if(!demoEnabled)throw new DomainError(403,'The hackathon demo is disabled.');return hackathonDemo!.view(workspace);}}):undefined;
  app.locals.demoTeam=demoTeam;
  let storeClosed=false;const closeStore=()=>{if(!storeClosed){storeClosed=true;store.close();}};
  app.locals.close = () => {void demoTeam?.close();closeStore();};
  app.locals.closeAsync=async()=>{await demoTeam?.close();closeStore();};
  const allowedHosts = new Set((options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]']).map(host => host.toLowerCase()));
  app.use((req, _res, next) => {
    const host = req.get('host');
    try {
      if (!host || /[\s/@\\?#]/.test(host) || !allowedHosts.has(new URL(`http://${host}`).hostname.toLowerCase())) throw new Error('host');
    } catch { return next(new DomainError(421, 'This host is not allowed by the local application.')); }
    next();
  });
  if(hosted)app.use((req,res,next)=>{
    const provided=req.get('x-quiet-ledger-proxy')??'';
    if(!timingSafeEqual(Buffer.from(hash(provided),'hex'),Buffer.from(hash(hosted.proxySecret),'hex')))return next(new DomainError(403,'Direct backend access is not permitted.'));
    res.locals.publicOrigin=hosted.publicOrigin;
    const client=req.get('x-quiet-ledger-client-ip')??'';res.locals.clientIp=isIP(client)?client:req.ip??'unknown';
    next();
  });
  if(hosted){
    const budget=new Map<string,{start:number;count:number}>(),maximum=hosted.limits?.requestsPerMinute??120;
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>10000)throw new Error('Invalid hosted request limit.');
    app.use('/api',(req,res,next)=>{const time=now().getTime(),client=String(res.locals.clientIp),old=budget.get(client);let entry=old;
      if(!entry||time-entry.start>=60000){for(const [id,value] of budget)if(time-value.start>=60000)budget.delete(id);if(budget.size>=5000)return next(new DomainError(429,'This hosted beta is busy. Try again shortly.'));entry={start:time,count:0};budget.set(client,entry);}
      if(++entry.count>maximum)return next(new DomainError(429,'Too many requests. Try again shortly.'));next();
    });
  }
  app.use(express.json({ limit: '48kb',verify:(_req,res,buffer)=>{(res as Response).locals.rawBody=Buffer.from(buffer);} }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.set('X-Frame-Options', 'DENY');
    next();
  });
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', (req, res, next) => {
    const value = sessionToken(req);
    const session = value ? store.session(value) : undefined;
    if (session && Date.parse(session.expires) > now().getTime()) {
      if(!hosted)res.locals.session=session;
      else if(session.hackathonDemo||session.role==='demo'||isHackathonWorkspace(session.workspace)){
        if(demoEnabled&&hackathonDemo!.sessionValid(session))res.locals.session=session;
      }else if(session.role==='owner'&&session.accountId&&!['owner','demo'].includes(session.workspace))res.locals.session=session;
    }
    next();
  });
  const sessionView = (session?: StoredSession) => ({
    authenticated: Boolean(session), role: session?.role ?? null,
    ...(session ? { csrfToken: session.csrf,...(session.accountId?{accountId:session.accountId}:{}) } : {}),
    authMode:hosted?'hosted':'local',
    demoAvailable:demoEnabled,
    ...(hosted?{marmotAvailable:true}:{}),
    ...(session?.hackathonDemo?{hackathonDemo:true}:{}),
    privateScenarioAvailable: !hosted&&session?.role === 'owner' && Boolean(options.privateScenarioPath && existsSync(options.privateScenarioPath)),
  });
  const failedLogins = new Map<string, { count: number; until: number }>();
  function rememberDemoBrowser(req:Request,res:Response,visit:{expiresAt:string;resumeToken?:string}) {
    if(visit.resumeToken)res.cookie('ql_demo_resume',visit.resumeToken,{httpOnly:true,sameSite:'strict',secure:Boolean(hosted)||req.secure,path:'/',maxAge:Math.max(0,Date.parse(visit.expiresAt)-now().getTime())});
  }
  function establishSession(req: Request, res: Response, role: 'demo' | 'owner',account?:{id:string;workspaceId:string},demo?:{expiresAt:string;sessionExpiresAt?:string;resumeToken?:string}) {
    if(demo)store.assertWriteBudget();
    if(!demo)store.removeExpiredSessions(now().toISOString());
    const value = token();
    const previousToken = sessionToken(req);
    if (previousToken) store.removeSession(previousToken);
    const session: StoredSession = { role, workspace: account?.workspaceId??role,...(account?{accountId:account.id}:{}),...(demo?{hackathonDemo:true}:{}), csrf: randomBytes(24).toString('base64url'), expires: demo?.sessionExpiresAt??demo?.expiresAt??new Date(now().getTime() + 86400000).toISOString() };
    store.saveSession(value, session);
    res.cookie('ql_session', value, { httpOnly: true, sameSite: 'strict', secure: Boolean(hosted)||req.secure, path: '/', maxAge: demo?Math.max(0,Date.parse(session.expires)-now().getTime()):86400000 });
    if(demo)rememberDemoBrowser(req,res,demo);
    res.json(sessionView(session));
  }
  app.post('/api/session/hackathon-demo',sameOrigin,(req,res)=>{
    if(!demoEnabled)throw new DomainError(404,'The hackathon demo is unavailable.');
    if(req.headers.authorization!==undefined)throw new DomainError(403,'Use the browser demo sign-in.');
    if(!req.is('application/json'))throw new DomainError(415,'Send the demo password as JSON.');
    const input=parse(z.object({password:z.string().min(1).max(128)}).strict(),req.body);
    store.transaction(()=>{
      const visit=hackathonDemo!.start(input.password,String(res.locals.clientIp??'unknown'),demoResumeToken(req));
      establishSession(req,res,'demo',{id:visit.accountId,workspaceId:visit.workspace},visit);
    });
  });
  // Runs before both public financial routes and account routers. Conversations have their own scoped authorization.
  app.use('/api',(req,res,next)=>{
    const session=res.locals.session as StoredSession|undefined;
    if(!session?.hackathonDemo)return next();
    if(req.headers.authorization!==undefined)return next(new DomainError(403,'Demo sessions cannot use API credentials.'));
    if(/^\/(?:account|receiving|collateral|ark)(?:\/|$)/i.test(req.path)||(/^\/auth(?:\/|$)/i.test(req.path)&&!(req.method==='GET'&&req.path==='/auth/config')))return next(new DomainError(403,'Use a private account for account settings and provider connections.'));
    if(['GET','HEAD','OPTIONS'].includes(req.method))return next();
    const conversation=/^\/(?:invoices|checkout)\/[A-Za-z0-9_-]{1,128}\/conversation(?:\/(?:events|query))?$/.test(req.path);
    if((req.method==='DELETE'&&(req.path==='/session'||/^\/invoice-templates\/[0-9a-f-]{36}$/.test(req.path)))||(req.method==='POST'&&(conversation||req.path==='/invoice-templates'||req.path==='/invoice-email/settings'||/^\/invoices\/[0-9a-f-]{36}\/email$/.test(req.path)||req.path==='/hackathon-demo/invoices'||req.path==='/hackathon-demo/simulate-payment'||/^\/hackathon-demo\/agents(?:\/(?:connect|pause|resume|reset|invite))?$/.test(req.path))))return next();
    return next(new DomainError(403,'This fictional demo supports only its tour, conversation and simulated payment actions.'));
  });
  if(hosted)app.use(createMarmotConversationsRouter({store,now,publicOrigin:hosted.publicOrigin,getSession:(_req,res)=>res.locals.session,assertPublicWorkspace,isDemoWorkspace:isHackathonWorkspace}));
  const accountAuth=hosted?createAccountAuth({store,publicOrigin:hosted.publicOrigin,now,getClientIp:(_req,res)=>res.locals.clientIp??'unknown',getSession:(_req,res)=>res.locals.session,onAuthenticated:(req,res,account)=>establishSession(req,res,'owner',account)}):undefined;
  if(hosted)app.use('/api/auth',(req,_res,next)=>/^Bearer(?:\s|$)/i.test(req.get('authorization')??'')?next(new DomainError(403,'API keys cannot access account authentication.')):next());
  if(accountAuth)app.use(accountAuth.router);
  if(hosted)app.use('/api/auth',(_req,res)=>res.status(404).json({error:'Account endpoint not found.'}));
  const accountKeys=hosted?createAccountApiKeys({store,now,getSession:(_req,res)=>res.locals.session}):undefined;
  app.use(createApiAccess({keys:hosted?[]:options.apiKeys??[],resolve:accountKeys?.resolve}));
  app.use('/api',(_req,res,next)=>{const access=res.locals.apiAccess;if(access)res.locals.session={role:'owner',workspace:access.workspace??'owner',...(access.accountId?{accountId:access.accountId}:{}),csrf:'',expires:new Date(now().getTime()+60000).toISOString()};next();});
  app.get('/api/health', (_req, res) => res.json({ ok: true, mode: 'simulation',authMode:hosted?'hosted':'local' }));
  app.get('/api/session', (req, res) => {
    const session=res.locals.session as StoredSession|undefined;
    if(demoEnabled&&session?.hackathonDemo){
      let ownCookie=false;
      try{const saved=hackathonDemo!.resume(demoResumeToken(req));ownCookie=saved.workspace===session.workspace&&saved.accountId===session.accountId;}
      catch(error){if(!(error instanceof DomainError)||error.status!==404)throw error;}
      if(!ownCookie)rememberDemoBrowser(req,res,hackathonDemo!.remember(session));
    }
    res.json(sessionView(session));
  });
  if(hosted)app.use(['/api/session/owner','/api/session/demo','/api/scenario','/api/square-sandbox','/api/square-test'],(_req,res)=>res.status(404).json({error:'This local-only route is unavailable.'}));
  app.post('/api/session/demo', sameOrigin, (req, res) => establishSession(req, res, 'demo'));
  app.post('/api/session/owner', sameOrigin, (req, res) => {
    const ip = req.ip ?? 'unknown';
    const attempts = failedLogins.get(ip);
    if (attempts && attempts.until > now().getTime() && attempts.count >= 8) throw new DomainError(429, 'Too many sign-in attempts. Try again later.');
    const supplied = typeof req.body?.token === 'string' && req.body.token.length <= 256 ? req.body.token : '';
    if (!timingSafeEqual(Buffer.from(hash(supplied), 'hex'), Buffer.from(hash(options.ownerToken??''), 'hex'))) {
      failedLogins.set(ip, { count: attempts && attempts.until > now().getTime() ? attempts.count + 1 : 1, until: now().getTime() + 15 * 60 * 1000 });
      throw new DomainError(401, 'Owner token was not accepted.');
    }
    failedLogins.delete(ip);
    establishSession(req, res, 'owner');
  });

  app.get('/api/checkout/:token', async (req, res) => {
    const found = store.getCheckout(param(req, 'token'));
    if (!found) throw new DomainError(404, 'Checkout not found.');
    assertPublicWorkspace(found.workspace);
    const demo=isHackathonWorkspace(found.workspace);
    const requestText = `DEMO-ONLY:quiet-ledger:${found.invoice.number}:${found.invoice.amountSats}:sats`;
    const qrDataUrl = await QRCode.toDataURL(requestText, { width: 240, margin: 1, color: { dark: '#163b2d', light: '#ffffff' } });
    res.json({ invoice: publicView(found.invoice), payment: { mode: 'simulation', amountSats: found.invoice.amountSats, request: requestText, qrDataUrl }, report:paymentReports.forInvoice(found.invoice.id),adapters:demo?[]:(hosted||found.workspace==='owner')?receivingFor(found.workspace).metadata():[],...(hosted?{conversationAvailable:true}:{}),...(demo?{hackathonDemo:true}:{}), ...(found.invoice.receiptToken ? { receiptToken: found.invoice.receiptToken } : {}) });
  });
  app.post('/api/checkout/:token/pay', sameOrigin, (req, res) => {
    const checkoutToken = param(req, 'token');
    const checkout=store.getCheckout(checkoutToken);if(checkout)denyDemoFinancial(checkout.workspace);
    const input = parse(z.object({ method: z.enum(PAYMENT_METHOD_IDS) }).strict(), req.body);
    const result = store.idempotent('public-payment', idempotencyKey(req), { checkout: hash(checkoutToken), ...input }, 200, () => {
      const found = store.getCheckout(checkoutToken);
      if (!found) throw new DomainError(404, 'Checkout not found.');
      if((hosted||found.workspace==='owner')&&receivingFor(found.workspace).hasLive())throw new DomainError(409,'This business uses live receiving. Choose a configured live payment method.');
      if(!invoiceAllowsMethod(found.invoice,input.method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
      if(found.invoice.status!=='paid'&&invoiceRequiresManualReport(found.invoice,input.method))return {invoice:publicView(found.invoice),alreadyPaid:false,report:paymentReports.report(found.workspace,found.invoice.id,input.method,now())};
      return settleInvoice(store, found.workspace, found.invoice, input.method, now());
    });
    sendResult(res, result);
  });
  app.get('/api/receipts/:token', (req, res) => {
    const found = store.getReceipt(param(req, 'token'));
    if (!found) throw new DomainError(404, 'Receipt not found.');
    assertPublicWorkspace(store.invoiceWorkspace(found.invoice.id));
    res.json({ receipt: publicReceipt(found.receipt), invoice: publicView(found.invoice) });
  });
  app.get('/api/square-test/:token',(req,res)=>res.json({checkout:squareSandbox.publicView(param(req,'token'))}));
  app.post('/api/square-test/:token/check',sameOrigin,async(req,res)=>{
    parse(z.object({}).strict(),req.body??{});
    res.json({checkout:await squareSandbox.checkPublic(param(req,'token'))});
  });
  app.get('/api/receive/:token',(req,res)=>res.json({request:receivingForToken(param(req,'token')).publicRead(param(req,'token'))}));
  app.post('/api/receive/:token/check',sameOrigin,async(req,res)=>{
    const input=parse(z.object({transactionId:z.string().min(1).max(200).optional()}).strict(),req.body??{});
    res.json({request:await receivingForToken(param(req,'token')).checkPublic(param(req,'token'),input)});
  });
  app.post('/api/checkout/:token/receiving',sameOrigin,async(req,res)=>{
    const input=parse(z.object({method:z.enum(METHOD_DEFINITIONS.map(row=>row.id)),adapterId:z.string().min(1).max(192)}).strict(),req.body);
    const found=store.getCheckout(param(req,'token'));if(!found||(!hosted&&found.workspace!=='owner'))throw new DomainError(404,'Live receiving invoice not found.');
    denyDemoFinancial(found.workspace);
    res.status(201).json({request:await receivingFor(found.workspace).create(found.workspace,{invoiceId:found.invoice.id,...input},idempotencyKey(req))});
  });

  app.use('/api', (req, res, next) => {
    const session = res.locals.session as StoredSession | undefined;
    if (!session) return next(new DomainError(401, 'Sign in to continue.'));
    if (!res.locals.apiAccess&&!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      sameOrigin(req, res, (error?: unknown) => {
        if (error) return next(error);
        const csrf = req.get('x-csrf-token');
        if (csrf !== session.csrf) return next(new DomainError(403, 'The session security token is missing or invalid.'));
        next();
      });
    } else next();
  });
  const demoSession=(res:Response)=>{
    const session=res.locals.session as StoredSession;
    if(!demoEnabled||!hackathonDemo!.sessionValid(session))throw new DomainError(403,'Start a fictional hackathon demo visit first.');
    return session;
  };
  app.get('/api/hackathon-demo',(_req,res)=>{const session=demoSession(res);res.json(hackathonDemo!.view(session.workspace));});
  app.post('/api/hackathon-demo/simulate-payment',(req,res)=>{
    parse(z.object({}).strict(),req.body??{});
    const session=demoSession(res);
    res.json(hackathonDemo!.simulatePayment(session.workspace));
  });
  app.post('/api/hackathon-demo/invoices',(req,res)=>{const session=demoSession(res);sendResult(res,store.idempotent('demo-invoice:'+session.workspace,idempotencyKey(req),req.body,201,()=>hackathonDemo!.create(session.workspace,req.body)));});
  app.get('/api/invoice-templates',(_req,res)=>{if(res.locals.apiAccess)throw new DomainError(403,'Use a browser session for invoice templates.');res.json({templates:invoiceTemplates.list((res.locals.session as StoredSession).workspace)});});
  app.post('/api/invoice-templates',(req,res)=>{if(res.locals.apiAccess)throw new DomainError(403,'Use a browser session for invoice templates.');res.status(201).json({template:invoiceTemplates.save((res.locals.session as StoredSession).workspace,req.body)});});
  app.delete('/api/invoice-templates/:id',(req,res)=>{if(res.locals.apiAccess)throw new DomainError(403,'Use a browser session for invoice templates.');res.json(invoiceTemplates.remove((res.locals.session as StoredSession).workspace,param(req,'id')));});
  const emailAccess=(res:Response)=>{if(res.locals.apiAccess)throw new DomainError(403,'Use a browser session for invoice emails.');const session=res.locals.session as StoredSession;return{workspace:session.workspace,context:{demo:session.role!=='owner'}};};
  app.get('/api/invoice-email/settings',(_req,res)=>{const {workspace}=emailAccess(res);res.json({settings:invoiceEmail.settings(workspace)});});
  app.post('/api/invoice-email/settings',(req,res)=>{const {workspace,context}=emailAccess(res);res.json({settings:invoiceEmail.saveSettings(workspace,req.body,context)});});
  app.post('/api/invoice-email/verify',async(req,res)=>{parse(z.object({}).strict(),req.body??{});const {workspace,context}=emailAccess(res);res.json({settings:await invoiceEmail.verifyGmail(workspace,context)});});
  app.get('/api/invoices/:id/email',(req,res)=>{const {workspace,context}=emailAccess(res);res.json(invoiceEmail.view(workspace,param(req,'id'),context));});
  app.post('/api/invoices/:id/email',async(req,res)=>{const {workspace,context}=emailAccess(res),id=param(req,'id'),key=idempotencyKey(req);sendResult(res,req.body?.action==='send'?await invoiceEmail.send(workspace,id,req.body,key,context):invoiceEmail.compose(workspace,id,req.body,key,context));});
  if(demoTeam)app.use(demoTeam.router);
  if(accountKeys)app.use(accountKeys.router);
  if(accountConnections)app.use(accountConnections.router);
  app.delete('/api/session', (req, res) => {
    const value = sessionToken(req);
    if (value) store.removeSession(value);
    res.clearCookie('ql_session', { httpOnly: true, sameSite: 'strict', secure: Boolean(hosted)||req.secure, path: '/' });
    res.json({ ok: true });
  });
  app.use('/api/square-sandbox',(_req,res,next)=>{
    if((res.locals.session as StoredSession).role!=='owner')return next(new DomainError(403,'Square sandbox is available only to the private owner workspace.'));
    next();
  });
  app.get('/api/square-sandbox',(_req,res)=>res.json(squareSandbox.status()));
  app.post('/api/square-sandbox/connection',async(req,res)=>{
    parse(z.object({}).strict(),req.body??{});
    res.json({connection:await squareSandbox.connect()});
  });
  app.post('/api/square-sandbox/checkouts',async(req,res)=>{
    const input=parse(z.object({invoiceId:z.string().min(1).max(128)}).strict(),req.body);
    const checkout=await squareSandbox.create(input.invoiceId,idempotencyKey(req));
    res.status(201).json({checkout});
  });
  app.post('/api/square-sandbox/checkouts/:id/reconcile',async(req,res)=>{
    parse(z.object({}).strict(),req.body??{});
    res.json({checkout:await squareSandbox.reconcile(param(req,'id'))});
  });
  app.get('/api/dashboard', (_req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    const invoices = store.listInvoices(workspace);
    const payouts = store.listPayouts(workspace);
    const invoicedCad = invoices.reduce((sum, invoice) => sum + invoice.totalCad, 0);
    const receivedCad = invoices.filter(invoice => invoice.status === 'paid').reduce((sum, invoice) => sum + receivedValue(invoice.paymentMethod!,invoice.totalCad), 0);
    const payoutEligibleCad=invoices.filter(invoice=>invoice.status==='paid'&&invoice.settlementMode!=='live'&&canFundPayout(invoice.paymentMethod)).reduce((sum,invoice)=>sum+invoice.totalCad,0);
    const spentCad = payouts.filter(payout => payout.status !== 'quoted').reduce((sum, payout) => sum + payout.totalDebit, 0);
    res.json({ totals: { invoicedCad, receivedCad, availableCad: payoutEligibleCad - spentCad, spentCad }, invoices, payouts, activity: store.audits(workspace) });
  });
  app.get('/api/payment-methods',(_req,res)=>{const workspace=(res.locals.session as StoredSession).workspace;res.json({methods:METHOD_DEFINITIONS,adapters:receivingFor(workspace).metadata(),walletOptions:walletOptions(workspace),defaultMode:'live'});});
  app.get('/api/payment-reports',(_req,res)=>res.json({reports:paymentReports.list((res.locals.session as StoredSession).workspace)}));
  app.post('/api/payment-reports/:id/confirm',(req,res)=>{
    parse(z.object({}).strict(),req.body??{});const workspace=(res.locals.session as StoredSession).workspace,id=param(req,'id');
    sendResult(res,store.idempotent(`report-confirm:${workspace}`,idempotencyKey(req),{id},200,()=>paymentReports.confirm(workspace,id,now())));
  });
  function paging(req:Request){
    const limit=req.query.limit===undefined?25:Number(req.query.limit);if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new DomainError(400,'List limit must be between 1 and 100.');
    let before=Number.MAX_SAFE_INTEGER;if(req.query.cursor!==undefined){const cursor=String(req.query.cursor),decoded=Buffer.from(cursor,'base64url').toString();if(!/^[1-9]\d*$/.test(decoded)||Buffer.from(decoded).toString('base64url')!==cursor)throw new DomainError(400,'Invalid list cursor.');before=Number(decoded);if(!Number.isSafeInteger(before))throw new DomainError(400,'Invalid list cursor.');}return {limit,before};
  }
  app.get('/api/invoices', (req, res) => {
    const workspace=(res.locals.session as StoredSession).workspace;
    if(!res.locals.apiAccess)return res.json({invoices:store.listInvoices(workspace)});
    const {limit,before}=paging(req),rows=store.db.prepare('SELECT rowid,id,workspace,data FROM invoices WHERE workspace=? AND rowid<? ORDER BY rowid DESC LIMIT ?').all(workspace,before,limit+1),page=rows.slice(0,limit);
    return res.json({invoices:page.map(row=>store.decode(row.data,'invoices',String(row.id),String(row.workspace))),nextCursor:rows.length>limit?Buffer.from(String(page.at(-1)!.rowid)).toString('base64url'):null});
  });
  const receivingOwner:express.RequestHandler=(_req,res,next)=>{if((res.locals.session as StoredSession).role!=='owner')return next(new DomainError(403,'Live receiving is available only in the private owner workspace.'));next();};
  app.use('/api/receiving',receivingOwner);
  app.get('/api/receiving',(req,res)=>{const workspace=(res.locals.session as StoredSession).workspace,{limit,before}=paging(req);res.json({...receivingFor(workspace).list(workspace,limit,before),adapters:receivingFor(workspace).metadata(),walletOptions:walletOptions(workspace),defaultMode:'live'});});
  app.get('/api/receiving/:id',(req,res)=>{const workspace=(res.locals.session as StoredSession).workspace;res.json({request:receivingFor(workspace).read(param(req,'id'),workspace)});});
  app.post('/api/receiving',async(req,res)=>{
    const workspace=(res.locals.session as StoredSession).workspace;
    const input=parse(z.object({invoiceId:z.string().min(1).max(128),method:z.enum(METHOD_DEFINITIONS.map(row=>row.id)),adapterId:z.string().min(1).max(192)}).strict(),req.body);
    res.status(201).json({request:await receivingFor(workspace).create(workspace,input,idempotencyKey(req))});
  });
  app.post('/api/receiving/:id/recover',async(req,res)=>{const workspace=(res.locals.session as StoredSession).workspace;parse(z.object({}).strict(),req.body??{});res.json({request:await receivingFor(workspace).recover(param(req,'id'),workspace)});});
  app.post('/api/receiving/:id/check',async(req,res)=>{const workspace=(res.locals.session as StoredSession).workspace;const input=parse(z.object({transactionId:z.string().min(1).max(200).optional()}).strict(),req.body??{});res.json({request:await receivingFor(workspace).check(param(req,'id'),workspace,input)});});
  app.post('/api/receiving/:id/confirm',(req,res)=>{
    const workspace=(res.locals.session as StoredSession).workspace;
    const input=parse(z.object({note:z.string().trim().min(1).max(1000),transactionId:z.string().trim().min(1).max(200)}).strict(),req.body),id=param(req,'id');
    sendResult(res,store.idempotent('receiving-confirm:'+workspace,idempotencyKey(req),{id,...input},200,()=>({request:receivingFor(workspace).confirm(id,workspace,input.note,input.transactionId)})));
  });
  app.get('/api/collateral',receivingOwner,async(_req,res)=>{if(!options.collateral)throw new DomainError(503,'No collateral watch configuration is connected. Select existing outputs and a synced mainnet source.');try{res.json({collateral:await inspectCollateral(options.collateral)});}catch{throw new DomainError(503,'Collateral could not be verified from the configured source. No ownership or lender acceptance is implied.');}});
  app.get('/api/ark',receivingOwner,async(_req,res)=>{if(!options.arkConnections?.length)throw new DomainError(503,'No Bark connection is configured.');try{res.json({ark:await Promise.all(options.arkConnections.map(config=>inspectArk(config)))});}catch{throw new DomainError(503,'Bark status is unavailable or its pinned network/server identity did not match.');}});
  app.get('/api/invoices/:id', (req, res) => {
    const invoice = store.getInvoice(param(req, 'id'), (res.locals.session as StoredSession).workspace);
    if (!invoice) throw new DomainError(404, 'Invoice not found.');
    res.json(invoice);
  });
  app.post('/api/invoices/:id/revoke-links',(req,res)=>{const workspace=(res.locals.session as StoredSession).workspace;parse(z.object({}).strict(),req.body??{});sendResult(res,store.idempotent('revoke-links:'+workspace,idempotencyKey(req),{id:param(req,'id')},200,()=>store.revokeInvoiceLinks(param(req,'id'),workspace,now().toISOString())));});
  app.post('/api/invoices', (req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    const result = store.idempotent(`invoice:${workspace}`, idempotencyKey(req), req.body, 201, () => createInvoice(store, workspace, req.body, now()));
    sendResult(res, result);
  });
  app.post('/api/sample-checkout', (req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    const result = store.idempotent(`sample:${workspace}`, idempotencyKey(req), req.body ?? {}, 201, () => createInvoice(store, workspace, { customerName: 'Guest customer', title: 'Field notes — website checkout', currency: 'CAD', items: [{ description: 'Digital field notes', quantity: 1, unitAmount: 2500 }], taxBps: 500, note: 'A fictional website purchase using the shared invoice and payment flow.' }, now()));
    sendResult(res, result);
  });
  app.get('/api/payouts', (_req, res) => res.json({ payouts: store.listPayouts((res.locals.session as StoredSession).workspace) }));
  app.post('/api/payouts/quote', (req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    sendResult(res, store.idempotent(`quote:${workspace}`, idempotencyKey(req), req.body, 201, () => createQuote(store, workspace, req.body, now())));
  });
  app.post('/api/payouts/:id/approve', (req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    const id = param(req, 'id');
    parse(z.object({}).strict(), req.body ?? {});
    sendResult(res, store.idempotent(`approve:${workspace}`, idempotencyKey(req), { id }, 200, () => approvePayout(store, workspace, id, now())));
  });
  app.post('/api/payouts/:id/advance', (req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    const id = param(req, 'id');
    parse(z.object({}).strict(), req.body ?? {});
    sendResult(res, store.idempotent(`advance:${workspace}`, idempotencyKey(req), { id }, 200, () => advancePayout(store, workspace, id, now())));
  });
  app.get('/api/evidence/export', (_req, res) => {
    const workspace = (res.locals.session as StoredSession).workspace;
    const invoices = store.listInvoices(workspace).map(({ token: _token, receiptToken: _receiptToken, ...invoice }) => invoice);
    const payments = invoices.filter(invoice => invoice.status === 'paid').map(invoice => ({ invoiceNumber: invoice.number, method: invoice.paymentMethod, amount: invoice.total, currency: invoice.currency, paidAt: invoice.paidAt, mode: invoice.settlementMode??'simulation',...(invoice.nativePayment?{nativePayment:invoice.nativePayment}:{}) }));
    const mode=payments.some(payment=>payment.mode==='live')?'mixed':'simulation';
    res.attachment('quiet-ledger-records.json').json({ schemaVersion: 1, mode, exportedAt: now().toISOString(), verification: mode==='simulation'?'Locally generated simulation records. Not bank-authenticated or lender-accepted evidence.':'Live receiving and simulation records are labelled individually. Manual review is distinct from provider verification; no lender acceptance is implied.', invoices, payments, payouts: store.listPayouts(workspace), activity: store.audits(workspace, true) });
  });
  app.get('/api/scenario', (_req, res) => {
    if ((res.locals.session as StoredSession).role !== 'owner') throw new DomainError(403, 'This scenario is available only to the private owner workspace.');
    if (!options.privateScenarioPath || !existsSync(options.privateScenarioPath)) return res.json({ scenario: null });
    try {
      const info = statSync(options.privateScenarioPath);
      if (!info.isFile() || info.size > 256 * 1024) throw new Error('invalid file');
      const data = JSON.parse(readFileSync(options.privateScenarioPath, 'utf8'));
      const validated = scenarioSchema.safeParse(data);
      if (!validated.success) throw new Error('invalid scenario');
      return res.json({ scenario: validated.data });
    } catch { throw new DomainError(503, 'The private scenario could not be loaded. Check the local owner file.'); }
  });
  app.get('/api/integrations', (_req, res) => res.json({ integrations: listIntegrations() }));
  app.get('/api/reference/fx', async (_req, res) => {
    try { res.json(await (options.fxFetcher ?? fetchReferenceRate)()); }
    catch { res.status(503).json({ error: 'The reference exchange rate is temporarily unavailable.' }); }
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof DomainError) return res.status(error.status).json({ error: error.message });
    if (error instanceof SyntaxError || error instanceof ZodError) return res.status(400).json({ error: 'Invalid JSON request.' });
    if (error && typeof error === 'object' && 'type' in error && error.type === 'entity.too.large') return res.status(413).json({ error: 'Request body is too large.' });
    return res.status(500).json({ error: 'The request could not be completed.' });
  });
  return app;
}
