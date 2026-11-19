/**
 * Opt-in smoke test against a real, independently built Amy CLI.
 * Use a network namespace with only loopback. See docs/AMY-INTEROP.md.
 */
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {Agent, createServer} from 'node:https';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {promisify} from 'node:util';
import {InMemoryKeyValueStore} from '@internet-privacy/marmot-ts/extra';
import {generateSecretKey, matchFilters, verifyEvent, type Event, type Filter} from 'nostr-tools';
import {WebSocket as Ws, WebSocketServer} from 'ws';
import {createMarmotRelayNetwork} from '../client/marmot-relay.js';
import {createProductionMarmot} from '../integrations/marmot-client.js';

const exec = promisify(execFile);
// Quartz rejects public-looking hostnames that resolve to 127/8. This
// documentation address is bound to lo only inside the test namespace.
const address = '192.0.2.55';
const host = 'marmot.ql.example';
const relay = `wss://${host}/`;
const timestampOrder = (a: Event, b: Event) => b.created_at - a.created_at || a.id.localeCompare(b.id);

function installRelay(server: WebSocketServer) {
  const events = new Map<string, Event>();
  const subscriptions = new Map<Ws, Map<string, Filter[]>>();
  server.on('connection', socket => {
    const active = new Map<string, Filter[]>();
    subscriptions.set(socket, active);
    socket.on('close', () => subscriptions.delete(socket));
    const send = (...data: unknown[]) => socket.send(JSON.stringify(data));
    socket.on('message', raw => {
      const [verb, first, ...rest] = JSON.parse(raw.toString());
      if (verb === 'CLOSE') {
        active.delete(first);
        return;
      }
      if (verb === 'REQ') {
        const filters = rest as Filter[];
        active.set(first, filters);
        const sorted = [...events.values()].sort(timestampOrder);
        const matches = new Map(filters.flatMap(filter =>
          sorted.filter(event => matchFilters([filter], event))
            .slice(0, filter.limit ?? 500).map(event => [event.id, event] as const),
        ));
        for (const event of matches.values()) send('EVENT', first, event);
        send('EOSE', first);
        return;
      }
      if (verb !== 'EVENT') return;
      const event = first as Event;
      if (!verifyEvent(event)) {
        send('OK', event.id, false, 'invalid: signature');
        return;
      }
      if (events.has(event.id)) {
        send('OK', event.id, true, 'duplicate: already stored');
        return;
      }
      if (event.kind === 0 || event.kind >= 10000 && event.kind < 20000 || event.kind >= 30000 && event.kind < 40000) {
        const dTag = (item: Event) => item.tags.find(([tag]) => tag === 'd')?.[1];
        for (const previous of events.values()) {
          if (previous.kind !== event.kind || previous.pubkey !== event.pubkey) continue;
          if (event.kind >= 30000 && dTag(previous) !== dTag(event)) continue;
          if (timestampOrder(event, previous) > 0) {
            send('OK', event.id, true, 'superseded: newer event already stored');
            return;
          }
          events.delete(previous.id);
        }
      }
      events.set(event.id, event);
      send('OK', event.id, true, '');
      for (const [subscriber, filtersById] of subscriptions) {
        if (subscriber.readyState !== Ws.OPEN) continue;
        for (const [id, filters] of filtersById) {
          if (matchFilters(filters, event)) subscriber.send(JSON.stringify(['EVENT', id, event]));
        }
      }
    });
  });
  return events;
}

async function main() {
  const amyPath = process.env.QUIET_LEDGER_AMY_BIN;
  assert.ok(amyPath && isAbsolute(amyPath), 'Set QUIET_LEDGER_AMY_BIN to the absolute Amy launcher path.');
  const interfaceTable = await readFile('/proc/net/dev', 'utf8');
  const interfaces = [...interfaceTable.matchAll(/^\s*([^\s:]+):/gm)].map(match => match[1]);
  assert.deepEqual(interfaces, ['lo'], 'Run Amy verification in a fresh Linux network namespace with only loopback.');
  const directory = await mkdtemp(join(tmpdir(), 'ql-amy-interop-'));
  try {
    const certificate = join(directory, 'certificate.pem');
    const key = join(directory, 'key.pem');
    const hosts = join(directory, 'hosts');
    const truststore = join(directory, 'truststore.p12');
    const keytool = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', 'keytool') : 'keytool';
    await writeFile(hosts, `127.0.0.1 localhost\n${address} ${host}\n`);
    await exec('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', `/CN=${host}`, '-addext', `subjectAltName=DNS:${host}`, '-keyout', key, '-out', certificate]);
    await exec(keytool, ['-importcert', '-noprompt', '-alias', host, '-file', certificate,
      '-keystore', truststore, '-storetype', 'PKCS12', '-storepass', 'changeit']);
    const cert = await readFile(certificate);
    const https = createServer({key: await readFile(key), cert}, (_request, response) => {
      response.setHeader('Content-Type', 'application/nostr+json');
      response.end(JSON.stringify({name: 'Quiet Ledger fictional test relay', supported_nips: [1, 11]}));
    });
    const relayActivity = {connections: 0, lastTlsError: ''};
    https.on('connection', () => relayActivity.connections++);
    https.on('tlsClientError', error => {relayActivity.lastTlsError = error.message;});
    const wss = new WebSocketServer({server: https, maxPayload: 131072});
    const storedEvents = installRelay(wss);
    try {
      https.listen(443, address);
      await once(https, 'listening');
      const properties = [
        `-Djava.io.tmpdir=${directory}`, `-Damy.home=${directory}`,
        `-Djdk.net.hosts.file=${hosts}`, `-Djavax.net.ssl.trustStore=${truststore}`,
        '-Djavax.net.ssl.trustStorePassword=changeit',
      ];
      class TestSocket extends Ws {
        constructor(url: string) {
          assert.equal(url, relay);
          super(`wss://${address}/`, {agent: new Agent({ca: cert, servername: host})});
        }
      }
      const network = createMarmotRelayNetwork({
        relays: [relay], reviewedRelays: [relay], WebSocket: TestSocket as unknown as typeof WebSocket,
      });
      const secret = generateSecretKey();
      try {
        const ledger = await createProductionMarmot({
          namespace: 'amy-interop', secretKey: secret, storage: new InMemoryKeyValueStore(),
          network, relays: [relay], reviewedRelays: [relay],
        });
        try {
          const amy = async (...args: string[]) => {
            const command = args.slice(0, 3).join(' ');
            try {
              const result = await exec(amyPath, ['--account', 'fictional', '--secret-backend', 'plaintext', '--json', ...args], {
                env: {PATH: process.env.PATH, JAVA_HOME: process.env.JAVA_HOME,
                  JAVA_OPTS: properties.map(value => JSON.stringify(value)).join(' '),
                  AMY_BOOTSTRAP_RELAYS: relay},
                timeout: 45_000, maxBuffer: 64 * 1024,
              });
              return JSON.parse(result.stdout.trim());
            } catch (error) {
              const failure = error as Error & {stdout?: string; stderr?: string; killed?: boolean};
              throw new Error(`Amy command failed (${command}): ${failure.killed ? 'timed out' : failure.stdout || failure.stderr || failure.message} (relay received ${relayActivity.connections} connections and stored ${storedEvents.size} events, last TLS error: ${relayActivity.lastTlsError || 'none'})`);
            }
          };
          const profile = await amy('init');
          assert.match(profile.hex, /^[0-9a-f]{64}$/);
          assert.match(profile.npub, /^npub1/);
          await amy('relay', 'outbox', 'set', relay);
          await amy('relay', 'inbox', 'set', relay);
          await amy('relay', 'dm', 'set', relay);
          await amy('relay', 'key-package', 'set', relay);
          await amy('relay', 'publish-lists');
          await amy('marmot', 'key-package', 'publish');
          await ledger.ensurePublished();
          for (const pubkey of [ledger.pubkey, profile.hex]) {
            assert.ok([...storedEvents.values()].some(event => event.kind === 30443 && event.pubkey === pubkey),
              'Both peers must publish distinct, signed KeyPackages to the local relay.');
          }
          console.log('Both peers published signed KeyPackages.');

          const exchange = async (ledgerGroup: string, amyGroup: string, label: string) => {
            const outgoing = `Fictional invoice note — 안녕하세요 (${label})`;
            const incoming = `Fictional customer reply — c'est reçu (${label})`;
            assert.equal((await ledger.send(ledgerGroup, outgoing)).state, 'sent');
            const received = await amy('marmot', 'await', 'message', amyGroup, '--match', outgoing, '--timeout', '20');
            assert.equal(received.content, outgoing);
            assert.equal(received.author, ledger.pubkey);
            await amy('marmot', 'message', 'send', amyGroup, incoming);
            await ledger.sync();
            assert.deepEqual(ledger.messages(ledgerGroup).filter(message => message.text === incoming).map(message => message.sender), [profile.hex]);
            for (const event of storedEvents.values()) {
              assert.ok(!JSON.stringify(event).includes(outgoing) && !JSON.stringify(event).includes(incoming),
                'The relay must never see the fixture message bodies.');
            }
            console.log(`${label} completed. Both peers decrypted each other's messages.`);
          };

          const ledgerGroup = await ledger.invite(profile.hex);
          const amyJoin = await amy('marmot', 'await', 'group', '--name', 'Private conversation', '--timeout', '20');
          await exchange(ledgerGroup.id, amyJoin.group_id, 'Quiet Ledger invited Amy');

          await ledger.ensurePublished();
          const amyRoom = await amy('marmot', 'group', 'create', '--name', 'Fictional Amy invoice room');
          await amy('marmot', 'group', 'add', amyRoom.group_id, ledger.pubkey);
          const invitations = await ledger.invitations();
          const invitation = invitations.find(item => item.peerPubkey === profile.hex);
          assert.ok(invitation, 'Quiet Ledger must find an actual gift-wrapped Welcome from Amy.');
          const joined = await ledger.accept(invitation.id, profile.hex);
          assert.notEqual(joined.id, ledgerGroup.id);
          assert.deepEqual(new Set(ledger.members(joined.id)), new Set([ledger.pubkey, profile.hex]));
          await exchange(joined.id, amyRoom.group_id, 'Amy invited Quiet Ledger');
          assert.ok([...storedEvents.values()].some(event => event.kind === 1059));
          assert.ok([...storedEvents.values()].some(event => event.kind === 445));
        } finally {
          await ledger.dispose();
        }
      } finally {
        secret.fill(0);
        network.dispose();
      }
    } finally {
      for (const socket of wss.clients) socket.terminate();
      wss.close();
      https.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

try {
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
