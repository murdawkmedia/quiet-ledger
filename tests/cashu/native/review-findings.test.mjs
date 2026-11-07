import assert from 'node:assert/strict';import {test} from 'node:test';
import {CashuJournal} from '../../../server/cashu/cashu-journal.mjs';
import {sdk,invoiceId,makeKeyset,makePayerProofs,makeOutputs,createRecovery,createControlledMint} from '../fixtures.mjs';
let sequence=0;
function fixture(){const path=`${process.env.FIXTURE_RUN_DIR}/review-${++sequence}.sqlite`,key=Buffer.alloc(32,91),keyset=makeKeyset(),journal=new CashuJournal(path,key,sdk),mint=createControlledMint(keyset),recovery=createRecovery(journal,keyset);return{path,key,keyset,journal,mint,recovery};}
async function lost(f){await f.recovery.prepare({operationId:'fictional-reviewed-op',invoiceId,inputs:makePayerProofs(f.keyset,[1,2]),outputs:makeOutputs(f.keyset,[2,1]),expectedAmount:3});await assert.rejects(f.recovery.submit('fictional-reviewed-op',async args=>{f.mint.swap(args);throw new Error('Fictional lost response');}));}

test('operator can explicitly raise the bounded restore budget without resetting original commitments',async()=>{
 const f=fixture();let reopened;try{await lost(f);for(let n=0;n<3;n++)await assert.rejects(f.recovery.restore('fictional-reviewed-op',async()=>{throw new Error('Fictional timeout');}));const original=f.journal.requestOf('fictional-reviewed-op');f.recovery.close();reopened=new CashuJournal(f.path,f.key,sdk,{restoreAttemptLimit:4});const recovery=createRecovery(reopened,f.keyset);const result=await recovery.restore('fictional-reviewed-op',args=>f.mint.restore(args));assert.equal(result.amount,'3');assert.equal(reopened.restoreAttempts('fictional-reviewed-op').length,4);assert.equal(reopened.requestOf('fictional-reviewed-op'),original);assert.equal(reopened.pending().length,1);}finally{reopened?.close();f.recovery.close();}
});

test('two recovery objects sharing a journal cannot perform concurrent restores',async()=>{
 const f=fixture();let release,entered,first;try{await lost(f);const second=createRecovery(f.journal,f.keyset),ready=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);let calls=0;first=f.recovery.restore('fictional-reviewed-op',async args=>{calls++;entered();await barrier;return f.mint.restore(args);});await ready;await assert.rejects(second.restore('fictional-reviewed-op',async args=>{calls++;return f.mint.restore(args);}),error=>error.code==='ATTEMPT_IN_PROGRESS');assert.equal(calls,1);}finally{release?.();if(first)await first;f.recovery.close();}
});

test('an invalid first restore payload cannot poison the valid persisted outputs',async()=>{
 const f=fixture();try{await lost(f);assert.throws(()=>f.journal.beginRestoreAttempt('fictional-reviewed-op',JSON.stringify({outputs:[1,2,3]})),error=>error.code==='INVALID_RESTORE_REQUEST');assert.equal(f.journal.restoreAttempts('fictional-reviewed-op').length,0);const result=await f.recovery.restore('fictional-reviewed-op',args=>f.mint.restore(args));assert.equal(result.amount,'3');}finally{f.recovery.close();}
});

test('check-state witness is bounded and cannot create an observation of payment',async()=>{
 const f=fixture();try{await lost(f);await assert.rejects(f.recovery.checkInputStates('fictional-reviewed-op',args=>{const response=f.mint.check(args);response.states[0].witness='x'.repeat(8193);return response;}),error=>error.code==='INVALID_CHECK_RESPONSE');assert.equal(f.journal.observation('fictional-reviewed-op').outcome,'INVALID_RESPONSE');assert.equal(f.journal.pending().length,0);}finally{f.recovery.close();}
});

test('SDK-rejected check response is audited as invalid data rather than a failed network',async()=>{
 const f=fixture();try{await lost(f);await assert.rejects(f.recovery.checkInputStates('fictional-reviewed-op',async()=>({states:{malformed:true}})));assert.equal(f.journal.observation('fictional-reviewed-op').outcome,'INVALID_RESPONSE');assert.equal(f.journal.pending().length,0);}finally{f.recovery.close();}
});

test('SDK-rejected restore response records invalid data instead of mint unavailability',async()=>{
 const f=fixture();try{await lost(f);await assert.rejects(f.recovery.restore('fictional-reviewed-op',async()=>({outputs:'no'})));assert.equal(f.journal.observation('fictional-reviewed-op').outcome,'INVALID_RESPONSE');assert.equal(f.journal.pending().length,0);}finally{f.recovery.close();}
});

test('journal guard covers explicit swap replay across recovery objects',async()=>{
 const f=fixture();let release,entered,first;try{await lost(f);const a=createRecovery(f.journal,f.keyset,{swapReplayPolicy:'byte-identical-single-request'}),b=createRecovery(f.journal,f.keyset,{swapReplayPolicy:'byte-identical-single-request'}),ready=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);let calls=0;first=a.recover('fictional-reviewed-op',async args=>{calls++;entered();await barrier;return f.mint.swap(args);});await ready;await assert.rejects(b.recover('fictional-reviewed-op',async args=>{calls++;return f.mint.swap(args);}),error=>error.code==='ATTEMPT_IN_PROGRESS');assert.equal(calls,1);}finally{release?.();if(first)await first;f.recovery.close();}
});

test('operator retry budget remains a bounded integer policy',()=>{
 const f=fixture();try{for(const value of [0,101,1.5,'4',null])assert.throws(()=>new CashuJournal(f.path,f.key,sdk,{restoreAttemptLimit:value}),error=>error.code==='INVALID_RESTORE_LIMIT');}finally{f.recovery.close();}
});
