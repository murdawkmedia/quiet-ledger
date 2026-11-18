import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../ops/pages-entry.js';

test('browser ecash transport permits only the explicit mint origins in Pages CSP',async()=>{
 const env={PUBLIC_ORIGIN:'https://ledger.example',SHC_API_ORIGIN:'https://backend.example',PROXY_SHARED_SECRET:'x'.repeat(43),ASSETS:{fetch:async()=>new Response('<html>fictional</html>')}};
 const response=await worker.fetch(new Request(env.PUBLIC_ORIGIN),env);
 const connect=(response.headers.get('content-security-policy')??'').split(';').find(v=>v.trim().startsWith('connect-src'))??'';
 const https=connect.split(/\s+/).filter(v=>v.startsWith('https:'));
 assert.deepEqual(https,['https://mint.minibits.cash','https://mint.coinos.io']);
 assert(!connect.split(/\s+/).includes('https:'));assert(!connect.includes('*'));
});
