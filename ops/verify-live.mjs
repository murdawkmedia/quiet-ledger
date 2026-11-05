// Live acceptance creates only explicitly labelled fictional accounts. No HAR, trace or secret output.
import {chromium,expect} from '@playwright/test';
import {generateSecretKey,getPublicKey,finalizeEvent} from 'nostr-tools/pure';
import {randomUUID} from 'node:crypto';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const base=process.env.QUIET_LEDGER_LIVE_URL;
if(!base||new URL(base).protocol!=='https:'||new URL(base).origin!==base)throw new Error('Set the reviewed public HTTPS origin.');
const output=resolve(process.env.QUIET_LEDGER_LIVE_EVIDENCE??'.runtime/live-acceptance');mkdirSync(output,{recursive:true,mode:0o700});
const stamp=new Date().toISOString(),browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true});const contexts=[];const errors=[],sockets=[];
const context=async()=>{const c=await browser.newContext({baseURL:base});contexts.push(c);return c;};
const pageFor=async c=>{const p=await c.newPage();p.on('pageerror',error=>errors.push(error.name));p.on('websocket',socket=>sockets.push(new URL(socket.url()).origin));return p;};
async function dashboard(p){await expect(p.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible({timeout:20000});}
async function session(c){const r=await c.request.get('/api/session');expect(r.status()).toBe(200);return r.json();}
async function post(c,path,body={},key=randomUUID()){const s=await session(c);return c.request.post(path,{headers:{'X-CSRF-Token':s.csrfToken,'Idempotency-Key':key},data:body});}
const result={public_origin:base,started_at:stamp,seed_policy:'fictional test accounts only',tracing:false,seeded_test_account_ids:[]};
function progress(phase,id){result.phase=phase;if(id&&!result.seeded_test_account_ids.includes(id))result.seeded_test_account_ids.push(id);writeFileSync(join(output,'live-progress.json'),JSON.stringify(result,null,2)+'\n');}
let temp;
try{
 const a=await context(),pa=await pageFor(a);await pa.goto('/');await expect(pa.getByRole('heading',{name:'Sign in without a password.',exact:true})).toBeVisible();
 await pa.setViewportSize({width:390,height:844});expect(await pa.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await pa.screenshot({path:join(output,'public-signup-mobile.png'),fullPage:true});await pa.setViewportSize({width:1280,height:900});
 const cdp=await a.newCDPSession(pa);await cdp.send('WebAuthn.enable');const virtual=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
 await pa.getByRole('button',{name:'Create an account',exact:true}).click();await pa.getByLabel('Private display name (optional)',{exact:true}).fill('TEST - launch passkey '+stamp);await pa.getByRole('button',{name:'Create account with a passkey',exact:true}).click();await dashboard(pa);const sa=await session(a);progress('passkey-created',sa.accountId);
 await pa.getByRole('button',{name:'Leave workspace',exact:true}).click();await pa.getByRole('button',{name:'Continue with a passkey',exact:true}).click();await dashboard(pa);expect((await session(a)).accountId).toBe(sa.accountId);await pa.reload();await dashboard(pa);
 const cookies=await a.cookies();expect(cookies.filter(c=>c.name==='ql_session').every(c=>c.secure&&c.httpOnly&&c.sameSite==='Strict')).toBe(true);
 const savedLabel='TEST - saved connection '+stamp;
 await pa.getByRole('link',{name:'Connections',exact:true}).click();await pa.getByRole('button',{name:'Connect Bank / Interac / Wise instructions',exact:true}).click();
 await pa.getByLabel('Connection label (optional)',{exact:true}).fill(savedLabel);await pa.getByLabel('Receiving method',{exact:true}).selectOption('interac');await pa.getByLabel('Payee / recipient name',{exact:true}).fill('TEST ONLY fictional recipient');await pa.getByLabel('Receiving instructions',{exact:true}).fill('TEST ONLY - no actual receiving details. Do not send funds.');await pa.getByRole('button',{name:'Save receiving instructions',exact:true}).click();await expect(pa.getByText('Saved instructions · manual confirmation',{exact:true})).toBeVisible();
 const connectionList=await(await a.request.get('/api/account/connections')).json();expect(connectionList.providers).toHaveLength(13);expect(connectionList.connections).toHaveLength(1);const savedConnection=connectionList.connections[0];expect(savedConnection.status).toBe('manual');
 await pa.getByRole('button',{name:'Leave workspace',exact:true}).click();await pa.getByRole('button',{name:'Continue with a passkey',exact:true}).click();await dashboard(pa);await pa.getByRole('link',{name:'Connections',exact:true}).click();await pa.reload();await expect(pa.getByText(savedLabel,{exact:true})).toBeVisible();progress('connection-reloaded');
 const issued=await post(a,'/api/invoices',{customerName:'TEST - fictional launch customer',title:'TEST ONLY - no funds requested',currency:'CAD',items:[{description:'TEST ONLY fictional service',quantity:1,unitAmount:125}],note:'TEST_PRIVATE_NOTE_NOT_FOR_PUBLIC_PAGE'});expect(issued.status()).toBe(201);const invoice=await issued.json();
 const b=await context(),pb=await pageFor(b),key=generateSecretKey(),pubkey=getPublicKey(key);await pb.exposeFunction('__testOnlySign',event=>finalizeEvent(event,key));await pb.addInitScript(({pubkey})=>{window.nostr={getPublicKey:async()=>pubkey,signEvent:async event=>window.__testOnlySign(event)};},{pubkey});
 await pb.goto('/');await pb.getByRole('button',{name:'Create an account',exact:true}).click();await pb.getByLabel('Private display name (optional)',{exact:true}).fill('TEST - launch Nostr '+stamp);await pb.getByRole('button',{name:'Create account with Nostr',exact:true}).click();await dashboard(pb);const sb=await session(b);progress('nostr-created',sb.accountId);expect(sb.accountId).not.toBe(sa.accountId);
 await pb.getByRole('button',{name:'Leave workspace',exact:true}).click();await pb.getByRole('button',{name:'Continue with Nostr',exact:true}).click();await dashboard(pb);expect((await session(b)).accountId).toBe(sb.accountId);
 expect((await b.request.get('/api/invoices/'+invoice.id)).status()).toBe(404);expect((await(await b.request.get('/api/evidence/export')).json()).invoices).toHaveLength(0);
 expect((await(await b.request.get('/api/account/connections')).json()).connections).toHaveLength(0);expect((await post(b,'/api/account/connections/'+savedConnection.id+'/check')).status()).toBe(404);
 const wrong=await a.request.post('/api/invoices',{headers:{'X-CSRF-Token':'invalid','Idempotency-Key':randomUUID()},data:{}});expect(wrong.status()).toBe(403);
 const payer=await context();const checkout=await payer.request.get('/api/checkout/'+invoice.token);expect(checkout.status()).toBe(200);expect(JSON.stringify(await checkout.json())).not.toContain('TEST_PRIVATE_NOTE_NOT_FOR_PUBLIC_PAGE');
 const projected=await(await payer.request.get('/api/checkout/'+invoice.token)).json();expect(projected.adapters[0].id).toBe(savedConnection.id);expect(JSON.stringify(projected)).not.toContain(savedLabel);
 const received=await payer.request.post('/api/checkout/'+invoice.token+'/receiving',{headers:{'Idempotency-Key':randomUUID()},data:{method:'interac',adapterId:savedConnection.id}});expect(received.status()).toBe(201);const receive=(await received.json()).request;
 expect((await post(b,'/api/receiving/'+receive.id+'/confirm',{note:'TEST blocked cross-account action',transactionId:'TEST-BLOCKED'})).status()).toBe(404);
 expect(JSON.stringify(await(await payer.request.get('/api/receive/'+receive.token)).json())).toContain('TEST ONLY - no actual receiving details. Do not send funds.');
 const reference='TEST-NO-FUNDS-'+randomUUID();expect((await post(a,'/api/receiving/'+receive.id+'/confirm',{note:'TEST ONLY fictional acceptance; no actual funds received',transactionId:reference})).status()).toBe(200);
 const paid=await(await a.request.get('/api/invoices/'+invoice.id)).json();expect(paid.status).toBe('paid');const receipt=await payer.request.get('/api/receipts/'+paid.receiptToken);expect(receipt.status()).toBe(200);expect(JSON.stringify(await receipt.json())).not.toContain(reference);
 const current=await session(b);const created=await b.request.post('/api/account/api-keys',{headers:{'X-CSRF-Token':current.csrfToken},data:{label:'TEST - launch remote MCP',scopes:['invoices:read','invoices:write','receiving:read','receiving:write','collateral:read'],expiresInDays:1}});expect(created.status()).toBe(201);const apiKey=(await created.json()).key;
 expect((await a.request.get('/api/v1/invoices/'+invoice.id,{headers:{Authorization:'Bearer '+apiKey.token}})).status()).toBe(404);
 temp=mkdtempSync(join(tmpdir(),'ql-live-mcp-'));const tokenPath=join(temp,'api-token');writeFileSync(tokenPath,apiKey.token,{mode:0o600});
 const transport=new StdioClientTransport({command:process.execPath,args:['--import','tsx','server/mcp.ts'],cwd:process.cwd(),env:{PATH:process.env.PATH,QUIET_LEDGER_URL:base,QUIET_LEDGER_ALLOW_REMOTE:'true',QUIET_LEDGER_API_TOKEN_FILE:tokenPath},stderr:'pipe'});transport.stderr?.on('data',()=>{});const client=new Client({name:'test-only-hosted-acceptance',version:'1.0.0'});
 try{await client.connect(transport);expect((await client.listTools()).tools).toHaveLength(9);const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});expect(r.isError).not.toBe(true);return r.structuredContent;};
  expect((await call('list_payment_methods')).walletOptions).toHaveLength(14);expect((await call('list_invoices')).invoices).toHaveLength(0);
  const mcpInvoice=(await call('create_invoice',{idempotencyKey:randomUUID(),customerName:'TEST - MCP fictional customer',title:'TEST ONLY remote MCP invoice',currency:'CAD',items:[{description:'TEST synthetic service',quantity:1,unitAmount:125}]})).invoice;
  expect((await call('get_invoice',{invoiceId:mcpInvoice.id})).invoice.id).toBe(mcpInvoice.id);
  const req=(await call('create_receive_request',{invoiceId:mcpInvoice.id,method:'interac',adapterId:'owner-confirmed-manual',idempotencyKey:randomUUID()})).request;
  expect((await call('list_receive_requests')).requests.some(row=>row.id===req.id)).toBe(true);expect((await call('check_receive_request',{requestId:req.id})).request.status).toBe('awaiting_payment');
  expect((await client.callTool({name:'get_collateral',arguments:{}})).isError).toBe(true);expect((await client.callTool({name:'get_ark_status',arguments:{}})).isError).toBe(true);
 }finally{await client.close();}
 expect((await b.request.delete('/api/account/api-keys/'+apiKey.id,{headers:{'X-CSRF-Token':current.csrfToken}})).status()).toBe(204);expect((await a.request.get('/api/v1/invoices',{headers:{Authorization:'Bearer '+apiKey.token}})).status()).toBe(401);
 expect((await post(a,'/api/invoices/'+invoice.id+'/revoke-links')).status()).toBe(200);expect((await payer.request.get('/api/checkout/'+invoice.token)).status()).toBe(404);expect((await payer.request.get('/api/receipts/'+paid.receiptToken)).status()).toBe(404);
 expect((await a.request.delete('/api/account/connections/'+savedConnection.id,{headers:{'X-CSRF-Token':(await session(a)).csrfToken}})).status()).toBe(200);expect((await(await a.request.get('/api/account/connections')).json()).connections).toHaveLength(0);
 for(const c of [a,b]){const s=await session(c);expect((await c.request.delete('/api/session',{headers:{'X-CSRF-Token':s.csrfToken}})).status()).toBe(200);}
 await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId:virtual.authenticatorId});await cdp.detach();
 expect(errors).toEqual([]);expect(sockets).toEqual([]);
 Object.assign(result,{completed_at:new Date().toISOString(),passkey_signup_and_login:true,nostr_signup_and_login:true,secure_cookies:true,tenant_isolation:true,csrf_rejection:true,public_invoice_privacy:true,manual_test_receipt:true,public_link_revocation:true,remote_mcp_tools:9,api_key_revoked:true,saved_connection_ui:true,saved_connection_login_reload:true,connection_isolation:true,public_receiving_instructions:true,connection_disconnected:true,seeded_test_account_ids:[sa.accountId,sb.accountId],test_accounts_created:2,websockets_opened:0,console_page_errors:0,actual_funds_moved:false});
 writeFileSync(join(output,'live-acceptance.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}catch(error){for(const c of contexts){try{const info=await session(c);if(info.accountId)progress('failed-own-test-session',info.accountId);}catch{}}console.error(JSON.stringify({live_acceptance_failed:true,error_type:error?.name??'Error',message:String(error?.message??'').replaceAll(/https?:\/\/[^\s)]+/g,'[reviewed origin]').slice(0,500)}));process.exitCode=1;}
finally{for(const c of contexts)await c.close().catch(()=>{});await browser.close();if(temp)rmSync(temp,{recursive:true,force:true});}
