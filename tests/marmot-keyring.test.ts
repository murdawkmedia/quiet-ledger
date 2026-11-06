import test from 'node:test';
import assert from 'node:assert/strict';
import {InMemoryKeyValueStore} from '@internet-privacy/marmot-ts/extra';
import * as module from '../client/marmot-keyring.js';
const passphrase='fictional twelve word passphrase';
test('keyring encrypts secret and structured SDK state, reopens safely and isolates namespaces',async()=>{
 assert.equal(typeof module.openMarmotKeyring,'function','Production keyring is missing.');
 const raw=new InMemoryKeyValueStore<unknown>();let ring=await module.openMarmotKeyring({namespace:'fictional-a',passphrase,storage:raw});
 const secret=new Uint8Array(ring.secretKey),state={bytes:new Uint8Array([4,5,6]),epoch:71n,tree:new Map([[1,new Uint8Array([7])]]),optional:undefined,text:'Private fictional history'};
 await ring.storage.setItem('sdk-state',state);const values=JSON.stringify(await Promise.all((await raw.keys()).map(key=>raw.getItem(key))));
 assert.equal(values.includes('Private fictional history'),false);assert.equal(values.includes(Array.from(secret).join(',')),false);
 await ring.dispose();assert.ok(ring.secretKey.every((byte:number)=>byte===0));await assert.rejects(ring.storage.getItem('sdk-state'),/locked|closed/i);
 ring=await module.openMarmotKeyring({namespace:'fictional-a',passphrase,storage:raw});assert.deepEqual(ring.secretKey,secret);assert.deepEqual(await ring.storage.getItem('sdk-state'),state);
 const second=await module.openMarmotKeyring({namespace:'fictional-b',passphrase,storage:raw});assert.notDeepEqual(second.secretKey,secret);assert.equal(await second.storage.getItem('sdk-state'),null);await second.dispose();await ring.dispose();
});
test('wrong passwords, modified ciphertext, swapped records and unsafe structured objects are rejected',async()=>{
 assert.equal(typeof module.openMarmotKeyring,'function','Production keyring is missing.');
 const raw=new InMemoryKeyValueStore<unknown>();let ring=await module.openMarmotKeyring({namespace:'tamper',passphrase,storage:raw});
 await ring.storage.setItem('first',{text:'one'});await ring.storage.setItem('second',{text:'two'});
 const keys=await raw.keys(),first=keys.find(key=>key.endsWith(':first'))!,second=keys.find(key=>key.endsWith(':second'))!;
 await raw.setItem(first,await raw.getItem(second));await assert.rejects(ring.storage.getItem('first'),/unlock|private|decrypt|storage/i);
 await assert.rejects(ring.storage.setItem('pollution',JSON.parse('{"__proto__":{"polluted":true}}')),/unsupported|structured|unsafe/i);assert.equal(({} as any).polluted,undefined);
 await ring.dispose();await assert.rejects(module.openMarmotKeyring({namespace:'tamper',passphrase:'a different wrong passphrase',storage:raw}),/unlock|private|decrypt/i);
 ring=await module.openMarmotKeyring({namespace:'tamper',passphrase,storage:raw});const headerKey=(await raw.keys()).find(key=>key.endsWith(':header'))!;const header=await raw.getItem(headerKey) as any;header.check=header.check.slice(0,-2)+'aa';await raw.setItem(headerKey,header);await ring.dispose();await assert.rejects(module.openMarmotKeyring({namespace:'tamper',passphrase,storage:raw}),/unlock|private|decrypt/i);
});
test('encrypted identity backups require stopped writer and deliberate fresh membership instead of restoring an MLS ratchet',async()=>{
 assert.equal(typeof module.openMarmotKeyring,'function','Production keyring is missing.');
 const raw=new InMemoryKeyValueStore<unknown>(),ring=await module.openMarmotKeyring({namespace:'backup-source',passphrase,storage:raw});
 await ring.storage.setItem('sdk-ratchet',{epoch:900n});const secret=new Uint8Array(ring.secretKey);
 const release=await module.reserveProductionMarmotWriter('backup-source');await assert.rejects(ring.exportBackup(),/open|writer|active/i);release();
 const backup=await ring.exportBackup();assert.equal(backup.includes('sdk-ratchet'),false);
 const destination=new InMemoryKeyValueStore<unknown>();await assert.rejects(module.restoreMarmotKeyring({namespace:'backup-destination',passphrase,backup,storage:destination} as any),/confirm|rejoin|stopped/i);
 const restored=await module.restoreMarmotKeyring({namespace:'backup-destination',passphrase,backup,storage:destination,confirmSourceStopped:true,mode:'identity-only-rejoin'});
 assert.deepEqual(restored.secretKey,secret);assert.equal(await restored.storage.getItem('sdk-ratchet'),null);
 await assert.rejects(module.restoreMarmotKeyring({namespace:'backup-destination',passphrase,backup,storage:destination,confirmSourceStopped:true,mode:'identity-only-rejoin'}),/open|exists|empty/i);
 await restored.dispose();await ring.dispose();
});

test('missing keyring metadata never overwrites encrypted records or silently creates another identity',async()=>{
 const raw=new InMemoryKeyValueStore<unknown>(),ring=await module.openMarmotKeyring({namespace:'missing-header',passphrase,storage:raw});await ring.storage.setItem('state',{epoch:99n});await ring.dispose();
 const headerKey=(await raw.keys()).find(key=>key.endsWith(':header'))!;await raw.removeItem(headerKey);const before=await raw.keys();
 await assert.rejects(module.openMarmotKeyring({namespace:'missing-header',passphrase,storage:raw}),/header|incomplete|metadata/i);assert.deepEqual(await raw.keys(),before);
});
