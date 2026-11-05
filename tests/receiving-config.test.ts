import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,chmodSync,linkSync,symlinkSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {loadReceivingConnections} from '../server/receiving-config.js';
test('private receiving configuration preserves explicit wallet options and defaults to live',()=>{
  const dir=mkdtempSync(join(tmpdir(),'receiving-config-'));const path=join(dir,'receiving-connections.json');
  try{writeFileSync(path,JSON.stringify({connections:[{type:'lnurl',options:{id:'synthetic-lnurl',lightningAddress:'fixture@wallet.example'}}]}),{mode:0o600});
    const config=loadReceivingConnections(path);assert.equal(config.adapters.length,2);assert.deepEqual(config.adapters[1].walletOptionIds,['lnurl']);assert.equal(config.adapters[1].mode,'live');
    writeFileSync(path,JSON.stringify({manualReceiving:false,connections:[]}));assert.equal(loadReceivingConnections(path).adapters.length,0);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('receiving configuration rejects linked or exposed files without leaking configuration contents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'receiving-config-'));const path=join(dir,'receiving-connections.json');
  const refuses=(candidate:string)=>assert.throws(()=>loadReceivingConnections(candidate),error=>error instanceof Error&&!error.message.includes('SYNTHETIC_SECRET')&&!error.message.includes(dir));
  try{writeFileSync(path,JSON.stringify({connections:[],privateMarker:'SYNTHETIC_SECRET'}),{mode:0o600});
    chmodSync(path,0o644);refuses(path);chmodSync(path,0o600);
    symlinkSync(path,join(dir,'symbolic'));refuses(join(dir,'symbolic'));
    linkSync(path,join(dir,'hard'));refuses(path);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
