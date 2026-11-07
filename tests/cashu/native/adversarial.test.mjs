import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,statSync} from 'node:fs';
import {CashuJournal} from '../../../server/cashu/cashu-journal.mjs';
import {sdk,makeKeyset,makePayerProofs,makeOutputs,signSwapRequest,createRecovery} from '../fixtures.mjs';
const data=process.env.FIXTURE_RUN_DIR;
let sequence=0;
function open(){const path=`${data}/adversarial-${++sequence}.sqlite`,keyset=makeKeyset(),journal=new CashuJournal(path,Buffer.alloc(32,94),sdk),recovery=createRecovery(journal,keyset);return{path,keyset,journal,recovery};}
async function prepare(f){await f.recovery.prepare({operationId:'fictional-parent-operation',invoiceId:'fictional-parent-invoice',inputs:makePayerProofs(f.keyset,[1]),outputs:makeOutputs(f.keyset,[1]),expectedAmount:1});}

test('overlapping attempts reject before a second transport effect',async()=>{
 const f=open();let release,entered;const ready=new Promise(resolve=>entered=resolve),barrier=new Promise(resolve=>release=resolve);let calls=0,first;
 try{await prepare(f);first=f.recovery.submit('fictional-parent-operation',async args=>{calls++;entered();await barrier;return signSwapRequest(args,f.keyset);});await ready;
  await assert.rejects(f.recovery.submit('fictional-parent-operation',async args=>{calls++;return signSwapRequest(args,f.keyset);}),error=>error.code==='ATTEMPT_IN_PROGRESS');
 }finally{release();if(first)await first.catch(()=>{});f.recovery.close();}
 assert.equal(calls,1);
});

test('spent observation cannot be downgraded to permit automatic replay',async()=>{
 const f=open();try{await prepare(f);await assert.rejects(f.recovery.submit('fictional-parent-operation',async()=>{throw new Error('Fictional lost response');}));f.recovery.observe('fictional-parent-operation','SPENT');f.recovery.observe('fictional-parent-operation','UNSPENT');let calls=0;await assert.rejects(f.recovery.recover('fictional-parent-operation',async args=>{calls++;return signSwapRequest(args,f.keyset);}),error=>error.code==='INPUT_SPENT');assert.equal(calls,0);assert.equal(f.journal.get('fictional-parent-operation').state,'uncertain');}finally{f.recovery.close();}
});

test('journal and lock files protect their permissions regardless of caller umask',()=>{
 const previous=process.umask(0o022);let f;try{f=open();assert.equal(statSync(f.path).mode&0o777,0o600);assert.equal(statSync(f.path+'.writer-lock').mode&0o777,0o600);}finally{f?.recovery.close();process.umask(previous);}
});

test('symlink journal targets reject before creating or modifying storage',()=>{
 const target=`${data}/fictional-target.txt`,link=`${data}/fictional-linked.sqlite`;let opened;try{assert.throws(()=>opened=new CashuJournal(link,Buffer.alloc(32,94),sdk),error=>error.code==='UNSAFE_PATH');assert.equal(readFileSync(target,'utf8'),'fictional file preserved');}finally{opened?.close();}
});

test('a saved operation cannot replay through a different configured mint scope',async()=>{
 const f=open();try{await prepare(f);const {CashuReceiveRecovery}=await import('../../../server/cashu/cashu-recovery.mjs');const other=new CashuReceiveRecovery({journal:f.journal,sdk,mintUrl:'https://other-quiet-ledger.invalid',unit:'sat',keyset:f.keyset,mintInfo:{name:'Controlled other fixture mint',nuts:{}},requireInputDleq:true});let calls=0;await assert.rejects(other.submit('fictional-parent-operation',async()=>{calls++;throw new Error('Fictional wrong mint reached');}),error=>error.code==='OPERATION_SCOPE_MISMATCH');assert.equal(calls,0);assert.equal(f.journal.get('fictional-parent-operation').state,'prepared');}finally{f.recovery.close();}
});

test('journal cannot treat an input proof as a new merchant output',async()=>{
 const f=open();try{await prepare(f);const op=f.journal.get('fictional-parent-operation');f.journal.beginAttempt(op.opId,JSON.stringify({fixture:'controlled request'}));assert.throws(()=>f.journal.complete(op.opId,[op.inputs[0]]),error=>error.code==='ECHOED_INPUT_PROOF');assert.equal(f.journal.get(op.opId).state,'uncertain');assert.equal(f.journal.pending().length,0);}finally{f.recovery.close();}
});

test('mint metadata is explicit rather than silently fixture-labelled',async()=>{
 const f=open();try{const {CashuReceiveRecovery}=await import('../../../server/cashu/cashu-recovery.mjs');assert.throws(()=>new CashuReceiveRecovery({journal:f.journal,sdk,mintUrl:'https://quiet-ledger.invalid',unit:'sat',keyset:f.keyset}),error=>error.code==='INVALID_MINT_INFO');}finally{f.recovery.close();}
});

test('SDK-internal replay is blocked before a second transport effect',async()=>{
 const f=open();try{await prepare(f);const original=f.recovery.wallet.completeSwap.bind(f.recovery.wallet);f.recovery.wallet.completeSwap=async preview=>{await original(preview);return original(preview);};let calls=0;await assert.rejects(f.recovery.submit('fictional-parent-operation',async args=>{calls++;return signSwapRequest(args,f.keyset);}),error=>error.code==='UNEXPECTED_TRANSPORT_REPLAY');assert.equal(calls,1);assert.equal(f.journal.get('fictional-parent-operation').state,'uncertain');assert.equal(f.journal.pending().length,0);}finally{f.recovery.close();}
});
