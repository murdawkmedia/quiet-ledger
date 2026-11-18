import test from 'node:test';
import assert from 'node:assert/strict';
import {CONNECTION_PROVIDERS,normalizeConnection,verifyConnection,buildConnectionAdapter} from '../server/connection-providers.js';
import {walletReadinessLanes} from '../shared/wallet-readiness.js';
import {fictionalNwcWallet} from './fixtures/nwc-wallet.js';

test('NWC is a private live receiving provider, with wallet choice and no exposed secret',async()=>{
 const wallet=fictionalNwcWallet();const options={id:'conn-fictional-nwc',publicOrigin:'https://ledger.example.com',nwcTransport:wallet.transport};
 const provider=CONNECTION_PROVIDERS.find(p=>p.id==='nwc');assert.ok(provider,'NWC provider must be selectable');
 assert.equal(provider.fields.find(f=>f.key==='connectionUri')?.type,'password');assert.deepEqual(provider.methods,['lightning']);
 const saved=normalizeConnection({provider:'nwc',mode:'live',fields:{walletLabel:'Minibits',connectionUri:wallet.uri}},options);
 const checked=await verifyConnection(saved,options);assert.equal(checked.status,'connected');assert.deepEqual(wallet.calls,['get_info']);
 assert.ok(!JSON.stringify(checked).includes(wallet.clientSecret));assert.ok(!JSON.stringify(provider).includes(wallet.clientSecret));
 const adapter=buildConnectionAdapter(saved,options);assert.equal(adapter.mode,'live');assert.deepEqual(adapter.methods,['lightning']);
 const lanes=walletReadinessLanes({providers:CONNECTION_PROVIDERS,connections:[{id:options.id,provider:'nwc',label:'Fictional',mode:'live',status:'connected',detail:'Fictional receive methods verified',methods:['lightning'],createdAt:new Date().toISOString(),verifiedAt:new Date().toISOString()}]});
 assert.equal(lanes.find(l=>l.walletOptionId==='lightning')?.metadataVerified,true);assert.equal(lanes.find(l=>l.walletOptionId==='lightning')?.fundedReady,false);
 for(const input of [{provider:'nwc',mode:'test',fields:saved.fields},{provider:'nwc',mode:'live',fields:{...saved.fields,transport:'chosen'}},{provider:'nwc',mode:'live',fields:{...saved.fields,connectionUri:wallet.uri.replace('wss%3A%2F%2Frelay.example.com','ws%3A%2F%2Flocalhost')}}])assert.throws(()=>normalizeConnection(input,options));
});

test('NWC offline verification is redacted and never creates an invoice',async()=>{
 const wallet=fictionalNwcWallet();wallet.setOffline(true);const options={id:'conn-fictional-nwc',publicOrigin:'https://ledger.example.com',nwcTransport:wallet.transport};
 const saved=normalizeConnection({provider:'nwc',mode:'live',fields:{walletLabel:'Zeus',connectionUri:wallet.uri}},options);
 await assert.rejects(verifyConnection(saved,options),error=>!String(error).includes(wallet.clientSecret)&&!String(error).includes('PRIVATE_PROVIDER'));
 assert.deepEqual(wallet.calls,[]);
});
