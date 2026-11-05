import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const implementation=await import('../functions/api/[[path]].js').catch(()=>undefined);
const ready=()=>{assert.ok(implementation,'Hosted API proxy is not implemented.');return implementation;};
const secret='SYNTHETIC_PROXY_SECRET_'+'x'.repeat(32);
const env={PUBLIC_ORIGIN:'https://ledger.example',SHC_API_ORIGIN:'https://backend.example',PROXY_SHARED_SECRET:secret};
const req=(path='/api/health',options:RequestInit={})=>{const headers=new Headers({'CF-Connecting-IP':'203.0.113.7'});new Headers(options.headers).forEach((value,name)=>headers.set(name,value));return new Request(env.PUBLIC_ORIGIN+path,{...options,headers});};
const stub=(callback:(url:string,init:RequestInit)=>Response|Promise<Response>):typeof fetch=>(async(input,init)=>callback(String(input),init??{})) as typeof fetch;
const json=(body:unknown,status=200,headers:HeadersInit={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json',...Object.fromEntries(new Headers(headers))}});
async function staticFailure(response:Response,status:number){assert.equal(response.status,status);const body=await response.text();assert.ok(!body.includes(secret));assert.ok(!body.includes('/home/'));assert.ok(!body.includes(env.SHC_API_ORIGIN));assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');assert.equal(response.headers.get('X-Frame-Options'),'DENY');assert.match(response.headers.get('Cache-Control')??'',/no-store/);}

test('hosted API proxy exposes both direct and Pages handler entrypoints',()=>{assert.equal(typeof ready().proxyApi,'function');assert.equal(typeof ready().onRequest,'function');});

test('proxy fixes its upstream origin and strips forged forwarding headers',async()=>{
  let calls=0;
  const response=await ready().proxyApi(req('/api/invoices?next=https%3A%2F%2Fevil.example',{headers:{Authorization:'Bearer fictional-token',Cookie:'ql_session=fictional-session',Accept:'application/json',Origin:env.PUBLIC_ORIGIN,'Sec-Fetch-Site':'same-origin','X-CSRF-Token':'fictional-csrf','Idempotency-Key':'fictional-key','X-Quiet-Ledger-Proxy':'attacker','X-Quiet-Ledger-Client-IP':'192.0.2.1','X-Forwarded-For':'192.0.2.2','X-Forwarded-Host':'evil.example',Forwarded:'host=evil.example','CF-Access-Client-Secret':'untrusted','X-Unrecognized':'untrusted',Host:'evil.example'}}),env,stub((url,init)=>{
    calls++;assert.equal(url,'https://backend.example/api/invoices?next=https%3A%2F%2Fevil.example');assert.equal(init.method,'GET');assert.equal(init.redirect,'manual');assert.equal(init.cache,'no-store');assert.ok(init.signal instanceof AbortSignal);
    const headers=new Headers(init.headers);assert.equal(headers.get('X-Quiet-Ledger-Proxy'),secret);assert.equal(headers.get('X-Quiet-Ledger-Client-IP'),'203.0.113.7');
    for(const name of ['X-Forwarded-For','X-Forwarded-Host','Forwarded','Host','CF-Access-Client-Secret','X-Unrecognized','CF-Connecting-IP','Content-Length'])assert.equal(headers.get(name),null);
    assert.equal(headers.get('Authorization'),'Bearer fictional-token');assert.equal(headers.get('Cookie'),'ql_session=fictional-session');assert.equal(headers.get('X-CSRF-Token'),'fictional-csrf');assert.equal(headers.get('Idempotency-Key'),'fictional-key');
    return json({ok:true});
  }));
  assert.equal(response.status,200);assert.equal(calls,1);assert.deepEqual(await response.json(),{ok:true});
});

test('Nostr authentication body bytes including whitespace and Unicode remain exact',async()=>{
  const text=' {"challengeId":"fictional", "note":"한글"}\n',bytes=new TextEncoder().encode(text);let outboundHash='';
  const response=await ready().proxyApi(req('/api/auth/nostr/verify',{method:'POST',body:bytes.buffer,headers:{'Content-Type':'application/json','Content-Length':String(bytes.length),Authorization:'Nostr fictional-signed-event'}}),env,stub(async(_url,init)=>{
    const sent=new Uint8Array(await new Response(init.body).arrayBuffer());assert.deepEqual(sent,bytes);outboundHash=createHash('sha256').update(sent).digest('hex');assert.equal(new Headers(init.headers).get('Content-Type'),'application/json');return json({authenticated:true});
  }));
  assert.equal(response.status,200);assert.equal(outboundHash,createHash('sha256').update(bytes).digest('hex'));
});

test('configuration must contain separate canonical HTTPS origins and a private printable secret',async()=>{
  let calls=0;const fetcher=stub(()=>{calls++;return json({});});
  for(const bad of ['', 'http://backend.example','https://user:password@backend.example','https://backend.example/api','https://backend.example?private=yes','https://backend.example#private','https://backend.example/','https://BACKEND.example','https://backend.example:443'])await staticFailure(await ready().proxyApi(req(),{...env,SHC_API_ORIGIN:bad},fetcher),503);
  for(const bad of ['', 'http://ledger.example','https://ledger.example/','https://ledger.example/path'])await staticFailure(await ready().proxyApi(req(),{...env,PUBLIC_ORIGIN:bad},fetcher),503);
  for(const bad of ['', 'short','x'.repeat(513),'한'.repeat(32),'x'.repeat(31)+' '])await staticFailure(await ready().proxyApi(req(),{...env,PROXY_SHARED_SECRET:bad},fetcher),503);
  await staticFailure(await ready().proxyApi(req(),{...env,SHC_API_ORIGIN:env.PUBLIC_ORIGIN},fetcher),503);assert.equal(calls,0);
});

test('wrong public origin cross-origin requests paths and unsupported methods never reach backend',async()=>{
  let calls=0;const fetcher=stub(()=>{calls++;return json({});});
  await staticFailure(await ready().proxyApi(new Request('https://evil.example/api/health',{headers:{'CF-Connecting-IP':'203.0.113.7',Host:'ledger.example'}}),env,fetcher),403);
  await staticFailure(await ready().proxyApi(req('/api/health',{headers:{Origin:'https://evil.example'}}),env,fetcher),403);
  await staticFailure(await ready().proxyApi(req('/api/health',{headers:{'Sec-Fetch-Site':'cross-site'}}),env,fetcher),403);
  for(const path of ['/','/api','/api/','/assets/private','/api/private.json','/api/a%2Fb','/api/a%5Cb','/api/a%00b'])await staticFailure(await ready().proxyApi(req(path),env,fetcher),404);
  for(const method of ['PUT','PATCH','OPTIONS']){const response=await ready().proxyApi(req('/api/health',{method}),env,fetcher);await staticFailure(response,405);assert.equal(response.headers.get('Allow'),'GET, HEAD, POST, DELETE');}
  assert.equal(calls,0);
});

test('only strict platform-provided IPv4 or IPv6 is injected into the trusted client IP header',async()=>{
  for(const [ip,expected] of [['203.0.113.7','203.0.113.7'],['127.0.0.1','127.0.0.1'],['2001:0DB8:0:0:0:0:0:1','2001:db8::1'],['::1','::1'],['::ffff:192.0.2.1','::ffff:c000:201']]){
    const response=await ready().proxyApi(req('/api/health',{headers:{'CF-Connecting-IP':ip}}),env,stub((_url,init)=>{assert.equal(new Headers(init.headers).get('X-Quiet-Ledger-Client-IP'),expected);return json({});}));assert.equal(response.status,200);
  }
  let calls=0;const fetcher=stub(()=>{calls++;return json({});});
  for(const ip of ['', '203.0.113.7, 192.0.2.1','010.0.0.1','256.1.1.1','1.2.3','1.2.3.4:80','[::1]','fe80::1%eth0','2001:::1','host.example','x'.repeat(1000)])await staticFailure(await ready().proxyApi(req('/api/health',{headers:{'CF-Connecting-IP':ip}}),env,fetcher),400);
  const missing=new Request(env.PUBLIC_ORIGIN+'/api/health');await staticFailure(await ready().proxyApi(missing,env,fetcher),400);assert.equal(calls,0);
});

test('request Content-Length is optional but strict and bound to exact streamed bytes',async()=>{
  let calls=0;const fetcher=stub(()=>{calls++;return json({});});
  for(const length of ['-1','1.5','1, 1','01','not-a-number','99999999999999999999999'])await staticFailure(await ready().proxyApi(req('/api/invoices',{method:'POST',body:'{}',headers:{'Content-Length':length}}),env,fetcher),400);
  await staticFailure(await ready().proxyApi(req('/api/invoices',{method:'POST',body:'{}',headers:{'Content-Length':'1'}}),env,fetcher),400);
  await staticFailure(await ready().proxyApi(req('/api/invoices',{method:'POST',body:'{}',headers:{'Content-Length':String(48*1024+1)}}),env,fetcher),413);
  assert.equal(calls,0);assert.equal((await ready().proxyApi(req('/api/invoices',{method:'POST',body:'{}'}),env,fetcher)).status,200);assert.equal(calls,1);
});

test('request streams stop and cancel at the48KiB bound without forwarding partial bytes',async()=>{
  let cancelled=false,calls=0,pulls=0;
  const body=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(20000));},cancel(){cancelled=true;}});
  const request=req('/api/invoices',{method:'POST',body,duplex:'half'} as RequestInit);
  await staticFailure(await ready().proxyApi(request,env,stub(()=>{calls++;return json({});})),413);
  assert.equal(calls,0);assert.equal(cancelled,true);assert.ok(pulls<=5);
});

test('exact maximum request size and DELETE bodies are forwarded without transformation',async()=>{
  const bytes=new Uint8Array(48*1024).fill(123);
  const response=await ready().proxyApi(req('/api/account/api-keys/fictional-key',{method:'DELETE',body:bytes.buffer,headers:{'Content-Length':String(bytes.length)}}),env,stub(async(_url,init)=>{assert.equal(init.method,'DELETE');assert.deepEqual(new Uint8Array(await new Response(init.body).arrayBuffer()),bytes);return new Response(null,{status:204});}));assert.equal(response.status,204);assert.equal(await response.text(),'');
});

test('streamed byte snapshots do not change when an underlying source reuses an earlier buffer',async()=>{
  const first=new Uint8Array([1,2]);let observed:Uint8Array|undefined;
  const stream=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(first);setTimeout(()=>{first.fill(9);controller.enqueue(new Uint8Array([3,4]));controller.close();},0);}});
  const response=await ready().proxyApi(req('/api/invoices',{method:'POST',body:stream,duplex:'half'} as RequestInit),env,stub(async(_url,init)=>{observed=new Uint8Array(await new Response(init.body).arrayBuffer());return json({});}));assert.equal(response.status,200);assert.deepEqual(observed,new Uint8Array([1,2,3,4]));
});

test('redirects and followed or rebound upstream URLs fail closed with generic errors',async()=>{
  for(const status of [300,301,302,303,305,307,308]){
    const response=await ready().proxyApi(req(),env,stub(()=>new Response(secret+' /home/private',{status,headers:{Location:'https://evil.example/'+secret}})));await staticFailure(response,502);assert.equal(response.headers.get('Location'),null);
  }
  const followed=json({});Object.defineProperty(followed,'redirected',{value:true});await staticFailure(await ready().proxyApi(req(),env,stub(()=>followed)),502);
  const rebound=json({});Object.defineProperty(rebound,'url',{value:'https://evil.example/api/health'});await staticFailure(await ready().proxyApi(req(),env,stub(()=>rebound)),502);
});

test('upstream exceptions stream failures and non-JSON error pages do not disclose details',async()=>{
  const thrown=stub(()=>{throw new Error(secret+' /home/private/backend');});await staticFailure(await ready().proxyApi(req(),env,thrown),502);
  const broken=new ReadableStream<Uint8Array>({pull(){throw new Error(secret+' /home/private/backend');}});await staticFailure(await ready().proxyApi(req(),env,stub(()=>new Response(broken,{headers:{'Content-Type':'application/json'}}))),502);
  await staticFailure(await ready().proxyApi(req(),env,stub(()=>new Response('<html>'+secret+' /home/private</html>',{status:500,headers:{'Content-Type':'text/html'}}))),502);
  await staticFailure(await ready().proxyApi(req(),env,stub(()=>new Response(secret+' invalid-json',{status:500,headers:{'Content-Type':'application/json'}}))),502);
});

test('sanitized JSON application errors retain their status and exact body',async()=>{
  for(const status of [400,401,403,404,409,429,503]){
    const text='{"error":"Fictional sanitized application failure."}';const response=await ready().proxyApi(req(),env,stub(()=>new Response(text,{status,headers:{'Content-Type':'application/json','Retry-After':'5','WWW-Authenticate':'Bearer realm="fictional"'}})));
    assert.equal(response.status,status);assert.equal(await response.text(),text);assert.equal(response.headers.get('Retry-After'),'5');assert.equal(response.headers.get('WWW-Authenticate'),'Bearer realm="fictional"');
  }
});

test('response streams are cancelled at2MiB and oversized declared responses are rejected early',async()=>{
  let cancelled=false,pulls=0;const stream=new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new Uint8Array(800000));},cancel(){cancelled=true;}});
  await staticFailure(await ready().proxyApi(req(),env,stub(()=>new Response(stream,{headers:{'Content-Type':'application/json'}}))),502);assert.equal(cancelled,true);assert.ok(pulls<=5);
  let declaredCancelled=false;const declared=new ReadableStream<Uint8Array>({pull(controller){controller.enqueue(new Uint8Array(1));},cancel(){declaredCancelled=true;}});
  await staticFailure(await ready().proxyApi(req(),env,stub(()=>new Response(declared,{headers:{'Content-Length':String(2*1024*1024+1)}}))),502);assert.equal(declaredCancelled,true);
});

test('response exact-byte limit native amount strings and JSON content type are preserved',async()=>{
  const text='{"expectedAtomic":"12345678901234567890","amount":125,"currency":"CAD","mode":"live"}',response=await ready().proxyApi(req(),env,stub(()=>new Response(text,{headers:{'Content-Type':'application/json; charset=utf-8','Content-Length':String(text.length),'Content-Disposition':'attachment; filename="fictional.json"','Content-Encoding':'gzip','X-Backend-Diagnostic':secret}})));
  assert.equal(await response.text(),text);assert.equal(response.headers.get('Content-Type'),'application/json; charset=utf-8');assert.equal(response.headers.get('Content-Length'),null);assert.equal(response.headers.get('Content-Encoding'),null);assert.equal(response.headers.get('X-Backend-Diagnostic'),null);assert.equal(response.headers.get('Content-Disposition'),'attachment; filename="fictional.json"');
  const exact=new Uint8Array(2*1024*1024).fill(120),boundary=await ready().proxyApi(req(),env,stub(()=>new Response(exact.buffer,{headers:{'Content-Type':'application/octet-stream'}})));assert.equal(boundary.status,200);assert.equal((await boundary.arrayBuffer()).byteLength,exact.length);
});

test('multiple authentication cookies remain separate host-only secure and correctly path-scoped',async()=>{
  const headers=new Headers({'Content-Type':'application/json'});
  headers.append('Set-Cookie','ql_session=fictional-session; Domain=backend.example; Path=/; SameSite=None; Expires=Wed, 21 Oct 2037 07:28:00 GMT');
  headers.append('Set-Cookie','ql_auth=fictional-challenge; Domain=.example; Path=/api/auth; SameSite=Lax; Max-Age=120');
  headers.append('Set-Cookie','preference=fictional; Path=/; SameSite=Lax');
  const response=await ready().proxyApi(req(),env,stub(()=>new Response('{}',{headers}))),cookies=response.headers.getSetCookie();assert.equal(cookies.length,3);
  for(const cookie of cookies.slice(0,2)){assert.doesNotMatch(cookie,/Domain=/i);assert.match(cookie,/; Secure(?:;|$)/);assert.match(cookie,/; HttpOnly(?:;|$)/);assert.match(cookie,/; SameSite=Strict(?:;|$)/);}
  assert.match(cookies[0],/Path=\/(?:;|$)/);assert.match(cookies[0],/Expires=Wed, 21 Oct 2037/);assert.match(cookies[1],/Path=\/api\/auth(?:;|$)/);assert.match(cookies[1],/Max-Age=120/);assert.equal(cookies[2],'preference=fictional; Path=/; SameSite=Lax');
});

test('authentication cookie defaults or unexpected paths are fixed by cookie name',async()=>{
  const headers=new Headers();headers.append('Set-Cookie','ql_session=fictional; Path=/unexpected');headers.append('Set-Cookie','ql_auth=fictional; SameSite=None');
  const cookies=(await ready().proxyApi(req(),env,stub(()=>new Response('{}',{headers})))).headers.getSetCookie();assert.match(cookies[0],/Path=\/(?:;|$)/);assert.doesNotMatch(cookies[0],/unexpected/);assert.match(cookies[1],/Path=\/api\/auth(?:;|$)/);
});

test('Cloudflare getAll Set-Cookie fallback preserves separate values without comma parsing',async()=>{
  const upstream=json({}),values=['ql_session=fictional; Path=/','ql_auth=fictional; Path=/api/auth'];
  Object.defineProperty(upstream.headers,'getSetCookie',{value:undefined});Object.defineProperty(upstream.headers,'getAll',{value:(name:string)=>{assert.equal(name,'Set-Cookie');return values;}});
  const response=await ready().proxyApi(req(),env,stub(()=>upstream));assert.equal(response.headers.getSetCookie().length,2);
});

test('cookie-bearing responses fail closed when the runtime cannot expose separate Set-Cookie values',async()=>{
  const upstream=json({},200,{'Set-Cookie':'ql_auth=fictional; Expires=Wed, 21 Oct 2037 07:28:00 GMT'});Object.defineProperty(upstream.headers,'getSetCookie',{value:undefined});
  await staticFailure(await ready().proxyApi(req(),env,stub(()=>upstream)),502);
});

test('HEAD204 and304 responses have null bodies and preserve security headers',async()=>{
  for(const [method,status] of [['HEAD',200],['GET',204],['GET',304]] as const){
    const upstream=status===200?new Response('unneeded body'):new Response(null,{status});const response=await ready().proxyApi(req('/api/health',{method}),env,stub(()=>upstream));assert.equal(response.status,status);assert.equal(response.body,null);assert.equal(await response.text(),'');assert.match(response.headers.get('Cache-Control')??'',/no-store/);
  }
});

test('cancelled requests fail without contacting the upstream and Pages wrapper uses the same proxy',async()=>{
  const controller=new AbortController();controller.abort();let calls=0;await staticFailure(await ready().proxyApi(req('/api/health',{signal:controller.signal}),env,stub(()=>{calls++;return json({});})),502);assert.equal(calls,0);
  const original=globalThis.fetch;globalThis.fetch=stub((url)=>{calls++;assert.equal(url,env.SHC_API_ORIGIN+'/api/health');return json({ok:true});});
  try{const response=await ready().onRequest({request:req(),env});assert.equal(response.status,200);assert.deepEqual(await response.json(),{ok:true});assert.equal(calls,1);}finally{globalThis.fetch=original;}
});

test('the15second deadline aborts an unresponsive injected upstream without exposing diagnostics',async()=>{
  const set=globalThis.setTimeout,clear=globalThis.clearTimeout;let deadline:(()=>void)|undefined,signal:AbortSignal|undefined,entered!:()=>void;
  const started=new Promise<void>(resolve=>{entered=resolve;});
  globalThis.setTimeout=((callback:()=>void,milliseconds:number)=>{assert.equal(milliseconds,15000);deadline=callback;return 1 as any;}) as unknown as typeof setTimeout;
  globalThis.clearTimeout=(()=>{}) as typeof clearTimeout;
  try{
    const pending=ready().proxyApi(req(),env,stub((_url,init)=>{signal=init.signal!;entered();return new Promise<Response>(()=>{});}));
    await started;assert.ok(deadline);assert.equal(signal!.aborted,false);deadline();await staticFailure(await pending,502);assert.equal(signal!.aborted,true);
  }finally{globalThis.setTimeout=set;globalThis.clearTimeout=clear;}
});
