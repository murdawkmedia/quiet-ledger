// Independent encoder for the documented backup authentication format.
import {createHmac,hkdfSync} from 'node:crypto';
export function authentication(manifest,key) {
  const derived=Buffer.from(hkdfSync('sha256',key,Buffer.alloc(0),'quiet-ledger-cashu-backup-auth-v1',32));
  try { return createHmac('sha256',derived).update(JSON.stringify([
    manifest.format,manifest.createdAt,manifest.sha256,manifest.bytes,
    ...['operations','reservations','merchantProofs','results','outbox','observations'].map(name=>manifest.counts[name]),
  ])).digest('hex'); } finally { derived.fill(0); }
}
