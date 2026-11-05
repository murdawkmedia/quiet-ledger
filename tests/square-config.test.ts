import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,chmodSync,rmSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSquareSandboxOptions } from '../server/square-config.js';

test('Square credentials load only from a private regular file and never from a browser field',()=>{
  const dir=mkdtempSync(join(tmpdir(),'square-config-'));const path=join(dir,'sandbox-token');
  try{
    assert.equal(loadSquareSandboxOptions({}),undefined);
    writeFileSync(path,'fixture-sandbox-token\n',{mode:0o600});
    const options=loadSquareSandboxOptions({SQUARE_SANDBOX_TOKEN_FILE:path});
    assert.equal(options?.token,'fixture-sandbox-token');
    chmodSync(path,0o644);assert.throws(()=>loadSquareSandboxOptions({SQUARE_SANDBOX_TOKEN_FILE:path}),/private regular file/);
    chmodSync(path,0o600);symlinkSync(path,join(dir,'alias'));
    assert.throws(()=>loadSquareSandboxOptions({SQUARE_SANDBOX_TOKEN_FILE:join(dir,'alias')}),/private regular file/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
