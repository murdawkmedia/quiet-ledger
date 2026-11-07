import assert from 'node:assert/strict';import {test} from 'node:test';import {join} from 'node:path';import {readFileSync,existsSync} from 'node:fs';
import {validateProfile,redactedProfileMetadata} from '../../server/cashu/profile.mjs';
import {createCashuRecoveryRuntime} from '../../server/cashu/runtime.mjs';
import {sdk} from './fixtures.mjs';import {newDir,writePrivate,profileObject,storageKey,makeKeyset,prepareUncertain} from './helpers.mjs';

test('protected profile keeps an explicit bounded restore budget',()=>{
 const dir=newDir('review-profile'),base=profileObject({journalPath:join(dir,'journal.sqlite')});assert.equal(validateProfile(base).restoreAttemptLimit,3);
 const profile=validateProfile({...base,restoreAttemptLimit:4});assert.equal(profile.restoreAttemptLimit,4);assert.equal(redactedProfileMetadata(profile).restoreAttemptLimit,4);
 for(const value of [0,101,1.5,'4',null])assert.throws(()=>validateProfile({...base,restoreAttemptLimit:value}),error=>error.code==='INVALID_RESTORE_LIMIT');
});

test('operator mint profile canonicalizes HTTPS host and default port',()=>{
 const dir=newDir('review-mint'),profile=validateProfile(profileObject({journalPath:join(dir,'journal.sqlite'),mint:'https://EXAMPLE.invalid:443/'}));assert.equal(profile.mint,'https://example.invalid');
});

test('inspection refuses an uninitialized file without creating journal state',()=>{
 const dir=newDir('review-empty'),journalPath=join(dir,'journal.sqlite');writePrivate(journalPath,Buffer.alloc(0));let runtime;
 try{assert.throws(()=>runtime=createCashuRecoveryRuntime({sdk,profile:profileObject({journalPath}),storageKey:storageKey()}),error=>error.code==='JOURNAL_NOT_INITIALIZED');assert.equal(readFileSync(journalPath).length,0);assert.equal(existsSync(journalPath+'.writer-lock'),false);}finally{runtime?.close();}
});

async function exhausted(){const dir=newDir('review-budget'),journalPath=join(dir,'journal.sqlite'),key=storageKey(),keyset=makeKeyset(),prepared=await prepareUncertain({journalPath,key,keyset});const runtime=createCashuRecoveryRuntime({sdk,profile:profileObject({journalPath,keyset}),storageKey:key});for(let index=0;index<3;index++)await assert.rejects(runtime.restore('fictional-recovery-op',{apply:true,transport:async()=>{throw new Error('Fictional temporary outage');}}));return{runtime,journalPath,key,keyset,mint:prepared.mint};}

test('preflight reports exhausted budget before attempting transport',async()=>{
 const f=await exhausted();try{const preflight=f.runtime.preflight('fictional-recovery-op','restore');assert.equal(preflight.eligible,false);assert.equal(preflight.reason,'RESTORE_ATTEMPTS_EXHAUSTED');}finally{f.runtime.close();}
});

test('explicit protected budget increase recovers the existing result after transient failures',async()=>{
 const f=await exhausted();f.runtime.close();const runtime=createCashuRecoveryRuntime({sdk,profile:{...profileObject({journalPath:f.journalPath,keyset:f.keyset}),restoreAttemptLimit:4},storageKey:f.key});try{assert.equal(runtime.preflight('fictional-recovery-op','restore').eligible,true);const result=await runtime.restore('fictional-recovery-op',{apply:true,transport:args=>f.mint.restore(args)});assert.equal(result.applied,true);assert.equal(result.operation.amount,'3');assert.equal(runtime.pending().length,1);assert.equal(runtime.inspect('fictional-recovery-op').restoreAttemptCount,4);}finally{runtime.close();}
});
