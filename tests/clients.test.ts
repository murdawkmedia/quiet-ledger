import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {nip19} from 'nostr-tools';
import {createInvoice} from '../server/domain.js';
import {DomainError,Store} from '../server/store.js';

// Assert the missing feature explicitly during the initial test-first run.
const implementation=await import('../server/clients.js').catch(()=>undefined);
function ready(){assert.ok(implementation,'Saved client service is not implemented.');return implementation;}
const firstTime='2026-11-06T12:00:00.000Z',secondTime='2026-11-07T12:00:00.000Z';
const workspace='fictional-client-workspace',otherWorkspace='other-fictional-client-workspace';
const publicKey='ab'.repeat(32),key=Buffer.alloc(32,43);
const invalid=(fn:()=>unknown,status=400)=>assert.throws(fn,error=>error instanceof DomainError&&error.status===status);
function fixture(){
  const {Clients}=ready(),store=new Store(':memory:',{encryptionKey:key});
  let timestamp=firstTime;
  return {store,clients:new Clients(store,()=>new Date(timestamp)),advance(){timestamp=secondTime;},close(){store.close();}};
}

test('saving a client defaults to CAD and returns the normalized public record',()=>{
  const f=fixture();try{
    const client=f.clients.save(workspace,{name:'  Fictional Workshop  ',email:'  billing@fictional.example  ',billingAddress:'  123 Example Lane\nExample City  ',notes:'  Fictional billing contact  '});
    assert.match(client.id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(client,{id:client.id,name:'Fictional Workshop',email:'billing@fictional.example',billingAddress:'123 Example Lane\nExample City',notes:'Fictional billing contact',currency:'CAD',createdAt:firstTime,updatedAt:firstTime});
    assert.deepEqual(f.clients.get(workspace,client.id),client);
    assert.deepEqual(f.clients.list(workspace),[client]);
  }finally{f.close();}
});

test('save replaces editable fields while retaining creation time and clearing blank optionals',()=>{
  const f=fixture();try{
    const initial=f.clients.save(workspace,{name:'Fictional First',email:'first@fictional.example',marmotPubkey:publicKey,billingAddress:'Fictional address',notes:'Fictional note',currency:'USD'});
    f.advance();
    const updated=f.clients.save(workspace,{id:initial.id,name:'Fictional Second',email:'',marmotPubkey:' ',billingAddress:' ',notes:''});
    assert.deepEqual(updated,{id:initial.id,name:'Fictional Second',currency:'CAD',createdAt:firstTime,updatedAt:secondTime});
    assert.deepEqual(f.clients.list(workspace),[updated]);
    assert.deepEqual(f.clients.get(workspace,initial.id),updated);
  }finally{f.close();}
});

test('identical client labels remain distinct records and every supported currency is retained',()=>{
  const f=fixture();try{
    const currencies=['CAD','USD','EUR','GBP','KRW'] as const;
    const saved=currencies.map(currency=>f.clients.save(workspace,{name:'Fictional duplicate label',currency}));
    assert.equal(new Set(saved.map(client=>client.id)).size,currencies.length);
    assert.deepEqual(saved.map(client=>client.currency),currencies);
    assert.deepEqual(f.clients.list(workspace).map(client=>client.id),saved.map(client=>client.id).reverse());
  }finally{f.close();}
});

test('every client operation is scoped and foreign or unknown IDs cannot be saved or removed',()=>{
  const f=fixture();try{
    const original=f.clients.save(workspace,{name:'Fictional private client'}),missing=randomUUID();
    assert.deepEqual(f.clients.list(otherWorkspace),[]);
    assert.equal(f.clients.get(otherWorkspace,original.id),undefined);
    assert.equal(f.clients.get(workspace,missing),undefined);
    for(const id of [original.id,missing]){
      invalid(()=>f.clients.save(otherWorkspace,{id,name:'Fictional replacement'}),404);
      invalid(()=>f.clients.remove(otherWorkspace,id),404);
    }
    invalid(()=>f.clients.save(workspace,{id:missing,name:'Fictional unknown client'}),404);
    invalid(()=>f.clients.remove(workspace,missing),404);
    assert.deepEqual(f.clients.get(workspace,original.id),original);
    assert.deepEqual(f.clients.remove(workspace,original.id),{removed:true});
    assert.equal(f.clients.get(workspace,original.id),undefined);
    assert.deepEqual(f.clients.list(workspace),[]);
    invalid(()=>f.clients.remove(workspace,original.id),404);
  }finally{f.close();}
});

test('strict saved client inputs reject caller-selected identity, timestamps and relay fields without writing',()=>{
  const f=fixture();try{
    const original=f.clients.save(workspace,{name:'Fictional original'});
    const bodies=[null,undefined,[],42,'Fictional client',{},
      {name:'Fictional client',workspace:otherWorkspace},
      {name:'Fictional client',createdAt:firstTime},
      {name:'Fictional client',updatedAt:firstTime},
      {name:'Fictional client',relay:'wss://relay.fictional.example'},
      {name:'Fictional client',relays:['wss://relay.fictional.example']},
      {name:'Fictional client',nsec:'fictional-secret'},
      {name:'Fictional client',id:'invalid-id'},
      {id:original.id,name:'Fictional changed',workspace:workspace}];
    for(const body of bodies)invalid(()=>f.clients.save(workspace,body));
    assert.deepEqual(f.clients.list(workspace),[original]);
    assert.deepEqual(f.clients.list(otherWorkspace),[]);
  }finally{f.close();}
});

test('saved client field bounds reject invalid values and permit the exact supported lengths',()=>{
  const f=fixture();try{
    const maxEmail='a'.repeat(64)+'@'+'b'.repeat(63)+'.'+'c'.repeat(63)+'.'+'d'.repeat(61);
    assert.equal(maxEmail.length,254);
    const exact=f.clients.save(workspace,{name:'N'.repeat(120),email:maxEmail,billingAddress:'A'.repeat(1000),notes:'T'.repeat(2000)});
    assert.equal(exact.name.length,120);assert.equal(exact.email,maxEmail);
    assert.equal(exact.billingAddress?.length,1000);assert.equal(exact.notes?.length,2000);
    for(const input of [{name:''},{name:'   '},{name:'N'.repeat(121)},{name:27},{name:'Fictional',email:maxEmail+'x'},{name:'Fictional',email:12},{name:'Fictional',billingAddress:'A'.repeat(1001)},{name:'Fictional',billingAddress:[]},{name:'Fictional',notes:'T'.repeat(2001)},{name:'Fictional',notes:{}},{name:'Fictional',currency:'BTC'},{name:'Fictional',currency:'cad'},{name:'Fictional',currency:null}]){
      invalid(()=>f.clients.save(workspace,input));
    }
    assert.deepEqual(f.clients.list(workspace),[exact]);
  }finally{f.close();}
});

test('client email accepts one mailbox and rejects header injection or recipient lists',()=>{
  const f=fixture();try{
    for(const email of ['not-an-email','Display Name <billing@fictional.example>','a@fictional.example,b@fictional.example','a@fictional.example;b@fictional.example','a@fictional.example\r\nBcc:b@fictional.example','billing@fictional.example\n','\tbilling@fictional.example','bill\u0000ing@fictional.example']){
      invalid(()=>f.clients.save(workspace,{name:'Fictional email client',email}));
    }
    assert.deepEqual(f.clients.list(workspace),[]);
    assert.equal(f.clients.save(workspace,{name:'Fictional email client',email:'billing+invoices@fictional.example'}).email,'billing+invoices@fictional.example');
  }finally{f.close();}
});

test('Marmot identities normalize npub nprofile and hex without retaining relay hints',()=>{
  const f=fixture();try{
    const values=[publicKey.toUpperCase(),' '+nip19.npubEncode(publicKey)+' ',nip19.nprofileEncode({pubkey:publicKey,relays:['wss://uncontacted.fictional.example']})];
    for(const marmotPubkey of values){
      const client=f.clients.save(workspace,{name:'Fictional Marmot client',marmotPubkey});
      assert.equal(client.marmotPubkey,publicKey);
      assert.ok(!JSON.stringify(client).includes('relay'));
      assert.ok(!JSON.stringify(client).includes('uncontacted'));
    }
  }finally{f.close();}
});

test('secret keys malformed identities and other Nostr identifier types never write or echo input',()=>{
  const f=fixture();try{
    const secret=nip19.nsecEncode(new Uint8Array(32).fill(17));
    const values=[secret,nip19.noteEncode(publicKey),'nprofile1malformed','npub1malformed','f'.repeat(63),'f'.repeat(65),'g'.repeat(64),'https://fictional.example','x'.repeat(4097),17,{}];
    for(const marmotPubkey of values){
      assert.throws(()=>f.clients.save(workspace,{name:'Fictional identity client',marmotPubkey}),error=>error instanceof DomainError&&error.status===400&&!error.message.includes(secret));
    }
    assert.deepEqual(f.clients.list(workspace),[]);
  }finally{f.close();}
});

test('the workspace cap is atomic, leaves other workspaces available and still permits edits',()=>{
  const f=fixture();try{
    const first=f.clients.save(workspace,{name:'Fictional capped client 0'});
    for(let i=1;i<500;i++)f.clients.save(workspace,{name:'Fictional capped client '+i});
    invalid(()=>f.clients.save(workspace,{name:'Fictional over-cap client'}),429);
    assert.equal(f.clients.list(workspace).length,500);
    f.advance();
    const updated=f.clients.save(workspace,{id:first.id,name:'Fictional edited at capacity',currency:'KRW'});
    assert.equal(updated.updatedAt,secondTime);assert.equal(updated.currency,'KRW');
    assert.equal(f.clients.list(workspace).length,500);
    assert.equal(f.clients.save(otherWorkspace,{name:'Fictional independent client'}).currency,'CAD');
    f.clients.remove(workspace,first.id);
    f.clients.save(workspace,{name:'Fictional replacement capacity'});
    assert.equal(f.clients.list(workspace).length,500);
  }finally{f.close();}
});

test('client payloads stay encrypted in database and WAL files and recover after restart',()=>{
  const {Clients}=ready(),directory=mkdtempSync(join(tmpdir(),'ql-clients-fixture-')),path=join(directory,'clients.sqlite');
  let store=new Store(path,{encryptionKey:key});
  try{
    const client=new Clients(store,()=>new Date(firstTime)).save(workspace,{name:'FICTIONAL_PRIVATE_CLIENT_76831',email:'private76831@fictional.example',billingAddress:'FICTIONAL_PRIVATE_ADDRESS_76831',notes:'FICTIONAL_PRIVATE_NOTES_76831',marmotPubkey:publicKey,currency:'GBP'});
    const data=String(store.db.prepare('SELECT data FROM client_contacts WHERE id=? AND workspace=?').get(client.id,workspace)!.data);
    assert.match(data,/^qlr:v1:/);
    for(const suffix of ['','-wal'])if(existsSync(path+suffix)){
      const bytes=readFileSync(path+suffix);
      for(const value of [client.name,client.email!,client.billingAddress!,client.notes!,client.marmotPubkey!])assert.ok(!bytes.includes(Buffer.from(value)));
    }
    store.close();store=new Store(path,{encryptionKey:key});
    const restored=new Clients(store,()=>new Date(secondTime));
    assert.deepEqual(restored.get(workspace,client.id),client);
    assert.deepEqual(restored.list(workspace),[client]);
    assert.equal(restored.get(otherWorkspace,client.id),undefined);
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});

test('removing a client preserves issued invoices and financial audit history',()=>{
  const f=fixture();try{
    const client=f.clients.save(workspace,{name:'Fictional historical client'});
    const invoice=createInvoice(f.store,workspace,{customerName:client.name,title:'Fictional issued service',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:125}]},new Date(firstTime));
    const storedInvoice=f.store.getInvoice(invoice.id,workspace);
    const audits=f.store.audits(workspace,true);
    f.clients.remove(workspace,client.id);
    assert.deepEqual(f.store.getInvoice(invoice.id,workspace),storedInvoice);
    assert.deepEqual(f.store.audits(workspace,true),audits);
  }finally{f.close();}
});
