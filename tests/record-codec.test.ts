import test from 'node:test';
import assert from 'node:assert/strict';

// Dynamic loading keeps the initial missing-feature run an assertion failure.
const implementation=await import('../server/record-codec.js').catch(()=>undefined);
const ready=()=>{assert.ok(implementation,'Record encryption module is not implemented.');return implementation;};
const key=()=>Buffer.alloc(32,7);
const context={table:'invoices',id:'fictional-record',workspace:'fictional-account'};
const sentinel='FICTIONAL_PRIVATE_SENTINEL_FOR_ENCRYPTION_TESTS';
const safeFailure=(fn:()=>unknown)=>assert.throws(fn,error=>error instanceof Error&&error.message==='Private storage could not be processed.');

test('record codec API exposes record and separate binary backup helpers',()=>{
  const api=ready();assert.equal(typeof api.createRecordCodec,'function');
  assert.equal(typeof api.encryptBackup,'function');assert.equal(typeof api.decryptBackup,'function');
});

test('local mode retains JSON serialization including arrays primitives and Unicode',()=>{
  const codec=ready().createRecordCodec();
  for(const value of [null,true,7,'한글 ♥',[1,{label:'fictional'}],{a:1,absent:undefined}]){
    const encoded=codec.encode(value,context);assert.equal(encoded,JSON.stringify(value));
    assert.deepEqual(codec.decode(encoded,context),JSON.parse(JSON.stringify(value)));
  }
});

test('local decode refuses malformed or encrypted data through a generic error',()=>{
  const codec=ready().createRecordCodec();
  for(const value of ['{','qlr:v1:AAAA',null,12,Buffer.from('{}')])safeFailure(()=>codec.decode(value,context));
});

test('encrypted records round trip without plaintext fields or values in the envelope',()=>{
  const codec=ready().createRecordCodec(key()),value={customer:sentinel,note:'Fictional private invoice',amount:125,items:[{description:'한글',quantity:1}]};
  const encoded=codec.encode(value,context);assert.match(encoded,/^qlr:v1:[A-Za-z0-9_-]+$/);
  assert.ok(!encoded.includes(sentinel));assert.ok(!encoded.includes('customer'));assert.deepEqual(codec.decode(encoded,context),value);
});

test('identical records receive independent random nonces',()=>{
  const codec=ready().createRecordCodec(key()),values=Array.from({length:32},()=>codec.encode({note:sentinel},context));
  assert.equal(new Set(values).size,32);
  const nonces=values.map(value=>Buffer.from(value.slice('qlr:v1:'.length),'base64url').subarray(0,12).toString('hex'));
  assert.equal(new Set(nonces).size,32);
});

test('the same external key restores records in a new codec instance',()=>{
  const {createRecordCodec}=ready(),encoded=createRecordCodec(key()).encode({value:sentinel},context);
  assert.deepEqual(createRecordCodec(key()).decode(encoded,context),{value:sentinel});
});

test('the codec snapshots its input key rather than retaining caller-mutable memory',()=>{
  const rootKey=key(),codec=ready().createRecordCodec(rootKey),encoded=codec.encode({value:sentinel},context);
  rootKey.fill(99);assert.deepEqual(codec.decode(encoded,context),{value:sentinel});
});

test('wrong account table or record identity cannot decrypt a record',()=>{
  const codec=ready().createRecordCodec(key()),encoded=codec.encode({value:sentinel},context);
  for(const changed of [{...context,workspace:'different-account'},{...context,table:'receipts'},{...context,id:'other-record'}])safeFailure(()=>codec.decode(encoded,changed));
});

test('context serialization cannot be confused by delimiter-shaped identifiers',()=>{
  const codec=ready().createRecordCodec(key()),first={table:'a',id:'b:c',workspace:'d'},second={table:'a:b',id:'c',workspace:'d'};
  const encoded=codec.encode({value:sentinel},first);safeFailure(()=>codec.decode(encoded,second));
});

test('wrong master keys and nonce tag or ciphertext tampering are rejected',()=>{
  const {createRecordCodec}=ready(),codec=createRecordCodec(key()),encoded=codec.encode({value:sentinel},context);
  safeFailure(()=>createRecordCodec(Buffer.alloc(32,9)).decode(encoded,context));
  const binary=Buffer.from(encoded.slice('qlr:v1:'.length),'base64url');
  for(const index of [0,12,binary.length-1]){const mutated=Buffer.from(binary);mutated[index]^=1;safeFailure(()=>codec.decode('qlr:v1:'+mutated.toString('base64url'),context));}
});

test('encrypted record parsing requires strict canonical versioned base64url',()=>{
  const codec=ready().createRecordCodec(key()),encoded=codec.encode({value:sentinel},context);
  for(const value of [encoded+'=',encoded+'\n',encoded.replace('v1','v2'),encoded.replace('qlr','qlb'),'qlr:v1:++//','qlr:v1:A','qlr:v1:'+Buffer.alloc(28).toString('base64url'),encoded.slice(0,-1),null,12])safeFailure(()=>codec.decode(value,context));
});

test('encrypted mode never silently accepts stored plaintext',()=>{
  const codec=ready().createRecordCodec(key());safeFailure(()=>codec.decode(JSON.stringify({value:sentinel}),context));
});

test('record size bounds are measured in UTF8 bytes before and after encryption',()=>{
  const {createRecordCodec,MAX_RECORD_BYTES}=ready();assert.equal(MAX_RECORD_BYTES,2*1024*1024);
  const exact='x'.repeat(MAX_RECORD_BYTES-2),codec=createRecordCodec(key()),encoded=codec.encode(exact,context);
  assert.equal(codec.decode(encoded,context),exact);
  for(const current of [codec,createRecordCodec()]){
    safeFailure(()=>current.encode(exact+'x',context));
    safeFailure(()=>current.encode('한'.repeat(Math.floor(MAX_RECORD_BYTES/3)+1),context));
    safeFailure(()=>current.decode('x'.repeat(MAX_RECORD_BYTES*2),context));
  }
});

test('serialization errors never echo record content or internal exception details',()=>{
  const cyclic:any={private:sentinel};cyclic.self=cyclic;
  for(const codec of [ready().createRecordCodec(),ready().createRecordCodec(key())]){
    for(const value of [undefined,1n,cyclic,()=>sentinel,Symbol(sentinel),{toJSON(){throw new Error(sentinel);}}])safeFailure(()=>codec.encode(value,context));
  }
});

test('contexts are explicit bounded strings and invalid keys fail closed',()=>{
  const api=ready(),codec=api.createRecordCodec(key());
  for(const current of [undefined,null,{}, {...context,id:''},{...context,workspace:'x'.repeat(513)},{...context,table:'x'.repeat(129)},{...context,id:'bad\nidentity'}]){
    safeFailure(()=>codec.encode({value:sentinel},current as any));safeFailure(()=>codec.decode('{}',current as any));
  }
  for(const value of [null,'0'.repeat(32),new Uint8Array(32),Buffer.alloc(0),Buffer.alloc(31),Buffer.alloc(33)])safeFailure(()=>api.createRecordCodec(value as any));
});

test('binary backups round trip arbitrary bytes and empty archives independently of record JSON',()=>{
  const {encryptBackup,decryptBackup}=ready();
  for(const bytes of [Buffer.alloc(0),Buffer.concat([Buffer.from(sentinel),Buffer.from([0,255,128,192])])]){
    const encrypted=encryptBackup(bytes,key(),'fictional-database');assert.ok(!encrypted.includes(Buffer.from(sentinel)));
    assert.deepEqual(decryptBackup(encrypted,key(),'fictional-database'),bytes);
  }
});

test('binary backups use random nonces and require original key and backup context',()=>{
  const {encryptBackup,decryptBackup}=ready(),plain=Buffer.from(sentinel),first=encryptBackup(plain,key(),'fictional-database'),second=encryptBackup(plain,key(),'fictional-database');
  assert.notDeepEqual(first,second);safeFailure(()=>decryptBackup(first,Buffer.alloc(32,8),'fictional-database'));
  safeFailure(()=>decryptBackup(first,key(),'other-database'));
});

test('backup header nonce tag ciphertext and truncation changes all fail authentication',()=>{
  const {encryptBackup,decryptBackup}=ready(),encrypted=encryptBackup(Buffer.from(sentinel),key(),'fictional-database');
  for(const index of [0,3,4,16,encrypted.length-1]){const mutated=Buffer.from(encrypted);mutated[index]^=1;safeFailure(()=>decryptBackup(mutated,key(),'fictional-database'));}
  for(const value of [encrypted.subarray(0,encrypted.length-1),Buffer.alloc(0),Buffer.alloc(31),Buffer.from('{}'),'not-a-buffer',null])safeFailure(()=>decryptBackup(value as any,key(),'fictional-database'));
});

test('record and backup payloads cannot be substituted across purposes',()=>{
  const api=ready(),codec=api.createRecordCodec(key()),encoded=codec.encode({value:sentinel},context),backup=api.encryptBackup(Buffer.from(JSON.stringify({value:sentinel})),key(),'fictional-database');
  safeFailure(()=>api.decryptBackup(Buffer.from(encoded),key(),'fictional-database'));
  safeFailure(()=>codec.decode('qlr:v1:'+backup.subarray(4).toString('base64url'),context));
});

test('backup helpers reject over-limit archives invalid keys and missing context',()=>{
  const api=ready();assert.equal(api.MAX_BACKUP_BYTES,64*1024*1024);
  safeFailure(()=>api.encryptBackup(Buffer.alloc(api.MAX_BACKUP_BYTES+1),key(),'fictional-database'));
  for(const current of ['', 'x'.repeat(1025),null,undefined])safeFailure(()=>api.encryptBackup(Buffer.from(sentinel),key(),current as any));
  for(const current of [Buffer.alloc(31),Buffer.alloc(33),new Uint8Array(32),null])safeFailure(()=>api.encryptBackup(Buffer.from(sentinel),current as any,'fictional-database'));
  safeFailure(()=>api.encryptBackup(sentinel as any,key(),'fictional-database'));
});
