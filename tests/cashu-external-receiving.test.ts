import test from 'node:test';
import assert from 'node:assert/strict';
import {createCashuExternalReceivingAdapter,isCashuSecretShaped,CASHU_EXTERNAL_MINTS,CASHU_EXTERNAL_WALLET_LABELS,CASHU_EXTERNAL_HOSTING_LABELS} from '../integrations/cashu-external-receiving.js';
import type {ReceivingContext,ReceivingIntent} from '../shared/receiving.js';

// Fixture-only coverage of the external-wallet Cashu receiving adapter. Every
// value here is fictional; no wallet, mint, provider or funded payment is
// contacted, and no funded acceptance is claimed or tested.
const config={id:'conn-fictional-cashu',mode:'live' as const,hosting:'Third-party wallet' as const,walletLabel:'Minibits' as const,mint:'https://mint.minibits.cash/Bitcoin' as const,instructions:'FICTIONAL channel: open the shared Minibits group and send to the merchant there.'};
function context(overrides:Partial<ReceivingContext>={}):ReceivingContext{
  return {requestId:'fictional-request-1',method:'cashu',amount:21,currency:'SAT',expectedAtomic:'21',idempotencyKey:'fictional-retry',createdAt:'2026-11-15T10:00:00.000Z',expiresAt:'2026-11-15T10:15:00.000Z',mode:'live',...overrides};
}

test('external Cashu adapter is live SAT-only manual receiving with no transport surface',async()=>{
  const adapter=createCashuExternalReceivingAdapter(config);
  assert.equal(adapter.id,config.id);assert.equal(adapter.mode,'live');
  assert.deepEqual(adapter.methods,['cashu']);assert.deepEqual(adapter.walletOptionIds,['cashu']);
  assert.deepEqual(adapter.supportedCurrencies,['SAT']);
  assert.equal(adapter.creationRetrySafe,true);
  assert.equal(adapter.label,undefined,'public provider name only; no private alias');
  // The adapter structurally has no fetcher; prove no global transport fires.
  const original=globalThis.fetch;
  globalThis.fetch=(()=>{throw new Error('FIXTURE: external Cashu receiving must never use the network');}) as typeof fetch;
  try{
    const intent=await adapter.create(context());
    const observation=await adapter.check(context(),intent);
    assert.equal(observation.status,'review');
  }finally{globalThis.fetch=original;}
});

test('payer instructions state the exact mint, wallet, net sats, fees and unique reference',async()=>{
  const adapter=createCashuExternalReceivingAdapter(config);
  const intent:ReceivingIntent=await adapter.create(context());
  assert.equal(intent.providerId,'fictional-request-1');
  assert.equal(intent.asset,'BTC');assert.equal(intent.network,'cashu-external (Third-party wallet)');
  const labels=intent.instructions!.map(row=>row.label),values=intent.instructions!.map(row=>row.value);
  assert.ok(labels.includes('Mint (send on this exact mint only)'));
  assert.ok(values.includes(config.mint));
  assert.ok(values.includes(config.walletLabel));
  assert.ok(labels.includes('Wallet hosting'),'public custody label is shown to the payer');
  assert.ok(values.some(value=>value.startsWith('Third-party wallet')&&/manual owner confirmation/i.test(value)),'hosting row carries the explicit manual verification level');
  assert.ok(values.some(value=>/21 sats net of fees/.test(value)),'exact SAT net amount with no FX');
  assert.ok(values.some(value=>/fees?/i.test(value)),'fee guidance is present');
  assert.ok(labels.includes('How to transfer'));
  assert.ok(values.includes('cashu-external:fictional-request-1'),'unique invoice-bound reference');
  assert.ok(values.some(value=>/never credits the invoice/i.test(value)));
  assert.ok(values.some(value=>/not automated mint verification/i.test(value)));
  for(const value of values)assert.equal(isCashuSecretShaped(value),false,'no token-shaped content in payer instructions');
});

test('each receiving request gets a unique allocation while idempotent retries keep one',async()=>{
  const adapter=createCashuExternalReceivingAdapter(config);
  const first=await adapter.create(context());
  const second=await adapter.create(context({requestId:'fictional-request-2'}));
  assert.notEqual(first.allocationKey,second.allocationKey,'generic static single-destination reuse is inappropriate here');
  assert.notEqual(first.providerId,second.providerId);
  const retry=await adapter.create(context());
  assert.equal(retry.allocationKey,first.allocationKey,'same request replays the same allocation');
});

test('bad context is rejected: mode, method, currency, unit, amount, expiry',async()=>{
  const adapter=createCashuExternalReceivingAdapter(config);
  await assert.rejects(adapter.create(context({mode:'test'})));
  await assert.rejects(adapter.create(context({method:'lightning' as ReceivingContext['method']})));
  await assert.rejects(adapter.create(context({currency:'USD' as ReceivingContext['currency']})));
  await assert.rejects(adapter.create(context({expectedAtomic:'2100'})),'FX-converted amounts are refused');
  await assert.rejects(adapter.create(context({amount:21.5})));
  await assert.rejects(adapter.create(context({amount:0})));
  await assert.rejects(adapter.create(context({amount:-21})));
  await assert.rejects(adapter.create(context({expiresAt:'2026-11-15T09:59:00.000Z'})));
  await assert.rejects(adapter.create(context({expiresAt:'not-a-date'})));
});

test('the check method always returns review and payer evidence never credits',async()=>{
  const adapter=createCashuExternalReceivingAdapter(config);
  const intent=await adapter.create(context());
  for(const evidence of [undefined,{},{transactionId:'fictional-payer-claim'}]){
    const observation=await adapter.check(context(),intent,evidence);
    assert.equal(observation.status,'review','check ALWAYS returns review');
    assert.equal(observation.status==='review'&&'paid'in observation,false);
  }
});

test('bearer Cashu tokens and secret-shaped values are refused in fields and references',async()=>{
  const adapter=createCashuExternalReceivingAdapter(config);
  const intent=await adapter.create(context());
  await assert.rejects(adapter.check(context(),intent,{transactionId:'cashuAeyJ0aXRsZSI6ImZpeHR1cmUifQ'}));
  await assert.rejects(adapter.check(context(),intent,{transactionId:'nsec1fictionalsecretvalue123456'}));
  await assert.rejects(adapter.check(context(),{...intent,providerId:'cashuB'+('A'.repeat(40))}));
  for(const bad of ['cashuAeyJ0aXRsZSI6ImZpeHR1cmUifQ','CashuBqx1Yebilc0dKtTtHJLn0hNN2aXTcKkpXaEVrfko','nsec1fictionalsecretvalue123456','xprv9s21ZrQH143K3QTtr4AtLibhK4bFjqM5oL'+''.padEnd(30,'x'),'-----BEGIN RSA PRIVATE KEY-----','a'.repeat(64)])
    assert.equal(isCashuSecretShaped(bad),true,bad.slice(0,24));
  for(const fine of ['Minibits','https://mint.coinos.io','Send within the fictional group chat.','cashu-external:fictional-request-1','ZEUS wallet is fine','123456'])
    assert.equal(isCashuSecretShaped(fine),false,fine);
});

test('the adapter factory enforces the approved mint, wallet-label and hosting allowlists',()=>{
  assert.deepEqual([...CASHU_EXTERNAL_MINTS],['https://mint.minibits.cash/Bitcoin','https://mint.coinos.io']);
  assert.deepEqual([...CASHU_EXTERNAL_WALLET_LABELS],['Minibits','Zeus','Other compatible Cashu wallet']);
  assert.deepEqual([...CASHU_EXTERNAL_HOSTING_LABELS],['Self-hosted wallet (user-run)','Third-party wallet']);
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,mint:'https://mint.attacker.example/Bitcoin' as never}));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,mint:'https://mint.minibits.cash/Bitcoin/'} as never));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,walletLabel:'Fake wallet' as never}));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,hosting:'Automatic receiver' as never}),'a self-hosting label never becomes an automatic receiver');
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,hosting:'Self-hosted wallet' as never}));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,mode:'test'} as never));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,instructions:'cashuAeyJ0aXRsZSI6ImZpeHR1cmUifQ'}));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,instructions:'   '}));
  assert.throws(()=>createCashuExternalReceivingAdapter({...config,id:'bad id!'}));
  assert.doesNotThrow(()=>createCashuExternalReceivingAdapter({...config,mint:'https://mint.coinos.io'}));
  assert.doesNotThrow(()=>createCashuExternalReceivingAdapter({...config,hosting:'Self-hosted wallet (user-run)'}));
});

test('both hosting choices are persisted connections with the same manual verification level',async()=>{
  // Self-hosted (user-run) and third-party wallets are both first-class saved
  // choices. The label changes public custody context only — never the
  // verification level, never an automatic paid flag.
  const selfHosted=createCashuExternalReceivingAdapter({...config,hosting:'Self-hosted wallet (user-run)'});
  const thirdParty=createCashuExternalReceivingAdapter(config);
  const first:ReceivingIntent=await selfHosted.create(context());
  const second:ReceivingIntent=await thirdParty.create(context());
  assert.equal(first.network,'cashu-external (Self-hosted wallet (user-run))');
  assert.equal(second.network,'cashu-external (Third-party wallet)');
  for(const intent of [first,second]){
    const hostingRow=intent.instructions!.find(row=>row.label==='Wallet hosting');
    assert.ok(hostingRow&&/verification level: manual owner confirmation/i.test(hostingRow.value));
    assert.equal((await selfHosted.check(context(),intent)).status,'review');
    assert.equal((await thirdParty.check(context(),intent)).status,'review');
  }
  // The reference is bound to the request, not to the hosting choice.
  assert.equal(first.allocationKey,second.allocationKey);
  assert.equal(first.providerId,second.providerId);
});
