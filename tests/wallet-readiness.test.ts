import test from 'node:test';
import assert from 'node:assert/strict';
import {walletReadinessLanes,type ReadinessPhase,type WalletReadinessInput} from '../shared/wallet-readiness.js';

const PHASE_ORDER:ReadinessPhase[]=['setup','metadata','manual-check','funded-acceptance'];

// Fictional definitions only. Field lists stay empty: readiness never sees values.
const automatic=(id:string,methods:WalletReadinessInput['providers'][number]['methods'])=>({id,name:`Fictional ${id}`,description:'Fictional fixture provider.',fields:[],walletOptionIds:[id],modes:['live'] as const,verification:'automatic' as const,methods});
const manualProvider=(id:string,methods:WalletReadinessInput['providers'][number]['methods'],modes:('live'|'test')[]=['live'])=>({id,name:`Fictional ${id}`,description:'Fictional fixture provider.',fields:[],walletOptionIds:[id],modes:modes as ('live'|'test')[],verification:'manual' as const,methods});
const row=(overrides:Partial<WalletReadinessInput['connections'][number]>&{provider:string;methods:string[]}):WalletReadinessInput['connections'][number]=>({
  id:overrides.id??`row-${overrides.provider}-${overrides.methods.join('-')}-${overrides.mode??'live'}-${overrides.status??'connected'}`,
  label:'Fictional connection',mode:'live',status:'connected',detail:'Fictional summary only.',
  createdAt:'2026-11-01T00:00:00.000Z',...overrides});

const laneProviders=():WalletReadinessInput['providers']=>[
  automatic('bitcoin-core',['bitcoin']),automatic('watch-only',['bitcoin']),
  manualProvider('static-crypto',['bitcoin','liquid','usdt','usdc'],['live','test']),
  automatic('lightning-address',['lightning']),automatic('lnurl',['lightning']),automatic('lnd',['lightning']),
  automatic('bark',['ark']),
];

function lanes(input:Partial<WalletReadinessInput>={}){return walletReadinessLanes({providers:input.providers??laneProviders(),connections:input.connections??[]});}
function byLane(result:ReturnType<typeof walletReadinessLanes>,id:string){const lane=result.find(row=>row.walletOptionId===id);assert.ok(lane);return lane;}
function deepFreeze<T>(value:T):T{
  if(value&&typeof value==='object'){for(const key of Object.getOwnPropertyNames(value as object))deepFreeze((value as Record<string,unknown>)[key]);Object.freeze(value);}
  return value;
}

test('four lanes render in fixed order and an empty account stays honest about funded acceptance',()=>{
  const result=lanes();
  assert.deepEqual(result.map(lane=>lane.walletOptionId),['bitcoin','lightning','ark','cashu']);
  for(const lane of result){
    assert.equal(lane.savedCount,0);
    assert.equal(lane.bestStatus,'none');
    assert.equal(lane.metadataVerified,false);
    assert.equal(lane.fundedReady,false,'no code path can claim funded readiness');
    assert.equal(lane.fundedAcceptance,'not_tracked');
    const phaseIndexes=lane.steps.map(step=>PHASE_ORDER.indexOf(step.phase));
    assert.deepEqual([...phaseIndexes].sort((a,b)=>a-b),phaseIndexes,'steps are ordered by phase');
    const funded=lane.steps.find(step=>step.phase==='funded-acceptance');
    assert.ok(funded);
    assert.equal(funded.state,'todo');
    assert.match(funded.label,/not recorded by this connection check/i);
    const copy=lane.steps.map(step=>`${step.label} ${step.detail}`).join(' ');
    assert.doesNotMatch(copy,/funded-ready|ready to be paid|ready to receive/i);
  }
  const cashu=byLane(result,'cashu');
  assert.deepEqual(cashu.providerIds,[],'no Cashu connection provider exists');
  const cashuCopy=cashu.steps.map(step=>`${step.label} ${step.detail}`).join(' ');
  assert.match(cashuCopy,/not configured in Connections/i);
  assert.match(cashuCopy,/Lightning/i,'the payer handoff path is referenced');
  assert.doesNotMatch(cashuCopy,/Zeus|Bark interoperat|mint URL/i);
});

test('a verified LND row distinguishes automatic invoice checks from untracked funded acceptance',()=>{
  const result=lanes({connections:[row({provider:'lnd',methods:['lightning'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z'})]});
  const lightning=byLane(result,'lightning');
  assert.equal(lightning.savedCount,1);
  assert.equal(lightning.bestStatus,'connected');
  assert.equal(lightning.metadataVerified,true);
  const metadata=lightning.steps.find(step=>step.phase==='metadata');
  assert.ok(metadata);assert.equal(metadata.state,'done');
  const manual=lightning.steps.find(step=>step.phase==='manual-check');
  assert.equal(manual,undefined,'LND supports automatic invoice settlement checks; do not invent a manual confirmation requirement');
  assert.equal(lightning.requiresManualConfirmation,false);
  const funded=lightning.steps.find(step=>step.phase==='funded-acceptance');
  assert.ok(funded);assert.equal(funded.state,'todo');
});

test('a missing verifiedAt or a test-mode row can never complete a metadata claim',()=>{
  const unverified=lanes({connections:[row({provider:'lnd',methods:['lightning'],status:'connected'})]});
  assert.equal(byLane(unverified,'lightning').metadataVerified,false);
  const mixed=lanes({connections:[row({provider:'static-crypto',methods:['bitcoin'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z',mode:'test'})]});
  const bitcoin=byLane(mixed,'bitcoin');
  assert.equal(bitcoin.savedCount,1,'the test row is still saved configuration');
  assert.equal(bitcoin.metadataVerified,false,'test-mode configurations cannot imply mainnet setup');
  const metadata=bitcoin.steps.find(step=>step.phase==='metadata');
  assert.ok(metadata);assert.notEqual(metadata.state,'done');
});

test('manual instructions are saved configuration with a visible confirmation obligation, not a failed automated check',()=>{
  const result=lanes({connections:[row({provider:'static-crypto',methods:['bitcoin'],status:'manual'})]});
  const bitcoin=byLane(result,'bitcoin');
  assert.equal(bitcoin.bestStatus,'manual');
  assert.equal(bitcoin.metadataVerified,false);
  assert.equal(bitcoin.requiresManualConfirmation,true);
  const metadata=bitcoin.steps.find(step=>step.phase==='metadata');
  assert.ok(metadata);assert.equal(metadata.state,'attention');
  assert.match(metadata.detail,/no automatic metadata check/i);
  const manual=bitcoin.steps.find(step=>step.phase==='manual-check');
  assert.ok(manual);assert.match(manual.detail,/confirm/i);
});

test('a USDT-only static connection never populates the Bitcoin lane',()=>{
  const result=lanes({connections:[row({provider:'static-crypto',methods:['usdt'],status:'manual'})]});
  const bitcoin=byLane(result,'bitcoin');
  assert.equal(bitcoin.savedCount,0);
  assert.equal(bitcoin.bestStatus,'none');
  assert.equal(byLane(result,'lightning').savedCount,0);
  assert.equal(byLane(result,'ark').savedCount,0);
});

test('a Bark row keeps invoice attribution manual even after a successful metadata check',()=>{
  const result=lanes({connections:[row({provider:'bark',methods:['ark'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z'})]});
  const ark=byLane(result,'ark');
  assert.equal(ark.metadataVerified,true);
  assert.equal(ark.requiresManualConfirmation,true);
  const manual=ark.steps.find(step=>step.phase==='manual-check');
  assert.ok(manual);assert.equal(manual.state,'attention');
  const copy=`${manual.label} ${manual.detail}`;
  assert.match(copy,/attribution/i);
  assert.match(copy,/pinned/i);
});

test('a verified success never hides a failed row in the same lane',()=>{
  const result=lanes({connections:[
    row({id:'ok-row',provider:'bitcoin-core',methods:['bitcoin'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z'}),
    row({id:'failed-row',provider:'bitcoin-core',methods:['bitcoin'],status:'unavailable'}),
  ]});
  const bitcoin=byLane(result,'bitcoin');
  assert.equal(bitcoin.savedCount,2);
  assert.equal(bitcoin.bestStatus,'connected');
  assert.equal(bitcoin.unavailableCount,1);
  assert.equal(bitcoin.metadataVerified,true,'the successful live row still counts');
  const metadata=bitcoin.steps.find(step=>step.phase==='metadata');
  assert.ok(metadata);assert.equal(metadata.state,'attention','mixed rows are visible, not collapsed');
  assert.match(metadata.detail,/failed/i);
});

test('orphan rows and invented wallet ids are ignored instead of trusted',()=>{
  const invented={id:'fictional-orphan',name:'Fictional orphan',description:'Invented provider.',fields:[],walletOptionIds:['invented-wallet'],modes:['live'] as const,verification:'automatic' as const,methods:['bitcoin'] as ('bitcoin')[]};
  const result=lanes({providers:[...laneProviders(),invented],connections:[row({provider:'fictional-orphan',methods:['bitcoin'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z'})]});
  assert.equal(byLane(result,'bitcoin').savedCount,0);
  assert.equal(byLane(result,'bitcoin').metadataVerified,false);
  const unknownRow=lanes({connections:[row({provider:'not-a-real-provider',methods:['bitcoin'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z'})]});
  assert.equal(byLane(unknownRow,'bitcoin').savedCount,0);
});

test('derivation is pure: inputs are neither mutated nor observed by a clock, and output is deterministic',()=>{
  const connections=[row({provider:'lnd',methods:['lightning'],status:'connected',verifiedAt:'2026-11-02T00:00:00.000Z'}),row({provider:'static-crypto',methods:['usdt'],status:'manual'})];
  const frozen=deepFreeze({providers:laneProviders(),connections});
  const first=walletReadinessLanes(frozen);
  const second=walletReadinessLanes(frozen);
  assert.deepEqual(first,second);
  assert.equal(JSON.stringify(frozen.connections).length>0,true);
});


test('LNURL guidance keeps proof-dependent review conditional and does not overstate LND requirements',()=>{
 const lightning=byLane(lanes({connections:[row({provider:'lnurl',methods:['lightning'],verifiedAt:'2026-11-02T00:00:00.000Z'})]}),'lightning');
 assert.equal(lightning.requiresManualConfirmation,true);
 const detail=lightning.steps.find(step=>step.phase==='manual-check')!.detail;
 assert.match(detail,/automatic verification/i);assert.match(detail,/if|without/i);
 assert.doesNotMatch(detail,/LND.*independent confirmation/i);
});
