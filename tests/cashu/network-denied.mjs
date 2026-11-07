// Network- and subprocess-denied probe. The orchestrator runs this file with
// Node's permission model and without --allow-net/--allow-child-process.
import {spawnSync} from 'node:child_process';
import {createBoundedHttpsTransport} from '../../server/cashu/transport.mjs';

let childDenied = false;
try { spawnSync('true'); }
catch (error) { childDenied = error?.code === 'ERR_ACCESS_DENIED'; }

let networkCode = null;
try {
  const transport = createBoundedHttpsTransport({mintUrl: 'https://quiet-ledger.invalid', timeoutMs: 2000});
  await transport({
    method: 'POST',
    endpoint: 'https://quiet-ledger.invalid/v1/checkstate',
    requestBody: {Ys: []},
  });
} catch (error) { networkCode = error?.code ?? 'UNKNOWN'; }

const ok = childDenied && networkCode === 'NETWORK_ERROR';
console.log(JSON.stringify({ok, childDenied, networkCode}));
if (!ok) process.exitCode = 1;
