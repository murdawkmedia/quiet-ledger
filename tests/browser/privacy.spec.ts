import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {resolve,join} from 'node:path';

test('development server refuses private runtime files even through Vite filesystem routes',async({request})=>{
  const directory=resolve('.runtime/browser-tests');mkdirSync(directory,{recursive:true});
  const sentinel=join(directory,'privacy-probe.txt');
  writeFileSync(sentinel,'SYNTHETIC_PRIVATE_DATA_ONLY',{mode:0o600});
  const response=await request.get('/@fs'+sentinel);
  expect(await response.text()).not.toContain('SYNTHETIC_PRIVATE_DATA_ONLY');
  expect([403,404]).toContain(response.status());
});

test('development filesystem routes deny sandbox credential canaries outside the runtime directory',async({request})=>{
  const sentinel=resolve('tests/fixtures/sandbox-token-canary.txt');
  writeFileSync(sentinel,'SYNTHETIC_SANDBOX_CREDENTIAL_ONLY',{mode:0o600});
  try{
    const response=await request.get('/@fs'+sentinel);
    expect(await response.text()).not.toContain('SYNTHETIC_SANDBOX_CREDENTIAL_ONLY');
    expect([403,404]).toContain(response.status());
  }finally{unlinkSync(sentinel);}
});

test('unauthenticated users and demo sessions cannot read private owner scenarios',async({request})=>{
  expect((await request.get('/api/scenario')).status()).toBe(401);
  expect((await request.post('/api/session/demo',{data:{}})).status()).toBe(200);
  expect((await request.get('/api/scenario')).status()).toBe(403);
  const response=await request.get('/api/evidence/export');
  expect(response.status()).toBe(200);
  expect(await response.text()).not.toContain('876543');
});
