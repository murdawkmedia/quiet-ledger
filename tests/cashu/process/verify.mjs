// Phase 3: another process confirms the restored result, delivers one idempotent
// outbox event and proves the acknowledgement survives a further open.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {CashuJournal} from '../../../server/cashu/cashu-journal.mjs';
import {createCashuRecoveryRuntime} from '../../../server/cashu/runtime.mjs';
import {sdk} from '../fixtures.mjs';
import {readJson, processDir, writeJson} from './common.mjs';

const dir = processDir();
const profile = readJson(join(dir, 'profile.json'));
const key = readFileSync(join(dir, 'storage.key'));
const runtime = createCashuRecoveryRuntime({sdk, profile, storageKey: key});
const credits = [];
let first;
let second;
let view;
try {
  view = runtime.inspect('process-op');
  assert.equal(view.state, 'finalized');
  first = await runtime.deliver({async credit(event) { credits.push(event); }});
  second = await runtime.deliver({async credit(event) { credits.push(event); }});
  assert.equal(first.delivered, 1);
  assert.equal(second.delivered, 0);
  assert.equal(credits.length, 1);
  assert.equal(runtime.integrity(), 'ok');
  assert.equal(runtime.counts().outbox, 1);
  assert.equal(runtime.pending().length, 0);
} finally { runtime.close(); }

const reopened = new CashuJournal(profile.journalPath, key, sdk);
let result;
try {
  result = reopened.savedResult('process-op');
  assert.equal(reopened.pending().length, 0);
  assert.equal(reopened.integrityCheck(), 'ok');
} finally { reopened.close(); }
writeJson(join(dir, 'verify.json'), {
  pid: process.pid,
  finalized: view.state === 'finalized',
  settlement: result.settlement,
  ledgerCredits: credits.length,
  redeliveredIdempotently: second.delivered === 0,
  pendingAfterAck: 0,
  ackSurvivedAnotherProcess: true,
  sqliteIntegrity: 'ok',
});
console.log(JSON.stringify({ok: true, phase: 'verify', pid: process.pid, ledgerCredits: credits.length}));
