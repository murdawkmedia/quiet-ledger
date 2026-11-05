import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadHostedRuntime} from '../server/hosted-runtime.js';
test('hosted startup requires explicit external private keys and cannot inherit local configuration',()=>{
  assert.equal(loadHostedRuntime({}),undefined);assert.throws(()=>loadHostedRuntime({HOSTED_ACCOUNTS:'true'}));
  const dir=mkdtempSync(join(tmpdir(),'ql-hosted-runtime-')),storage=join(dir,'storage-key'),proxy=join(dir,'proxy-secret');
  try{writeFileSync(storage,Buffer.alloc(32,7).toString('base64url')+'\n',{mode:0o600});writeFileSync(proxy,'synthetic-hosted-proxy-secret-at-least32\n',{mode:0o600});
    const env={HOSTED_ACCOUNTS:'true',PUBLIC_ORIGIN:'https://example.test',STORAGE_KEY_FILE:storage,PROXY_SHARED_SECRET_FILE:proxy};const loaded=loadHostedRuntime(env)!;assert.deepEqual(loaded.encryptionKey,Buffer.alloc(32,7));assert.equal(loaded.hosted.publicOrigin,env.PUBLIC_ORIGIN);
    for(const extra of [{PRIVATE_SCENARIO_PATH:'fictional'},{OWNER_TOKEN:'fictional'},{RECEIVING_CONNECTIONS_FILE:'fictional'},{SQUARE_SANDBOX_TOKEN_FILE:'fictional'},{PUBLIC_ORIGIN:'http://localhost:4317'}])assert.throws(()=>loadHostedRuntime({...env,...extra}));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
