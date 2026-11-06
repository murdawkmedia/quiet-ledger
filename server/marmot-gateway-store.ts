import {randomUUID} from 'node:crypto';
import {generateSecretKey} from 'nostr-tools';
import type {GenericKeyValueStore} from '@internet-privacy/marmot-ts';
import {Store,DomainError,hash} from './store.js';

const stateTable='marmot_gateway_state',identityTable='marmot_gateway_identities';
const forbidden=new Set(['__proto__','prototype','constructor']);
const arrays={Uint8Array,Uint8ClampedArray,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array};
const validScope=(value:string)=>{if(typeof value!=='string'||!value.length||value.length>512||/[\u0000-\u001f\u007f]/.test(value))throw new DomainError(400,'Invalid gateway storage scope.');return value;};
function liveWriter(owner:string):boolean|undefined{
 const match=owner.match(/^pid:([1-9][0-9]{0,9}):/);if(!match)return undefined;
 try{process.kill(Number(match[1]),0);return true;}catch(error){return(error as NodeJS.ErrnoException).code!=='ESRCH';}
}

/** An explicitly tagged tree avoids ambiguous JSON revivers and reconstructing arbitrary constructors. */
function encodeValue(value:unknown,seen=new Set<object>(),depth=0,budget={nodes:0}):unknown {
 if(depth>64||++budget.nodes>100000)throw new DomainError(400,'Gateway state exceeds supported complexity.');
 if(value===undefined)return['undefined'];
 if(value===null||typeof value==='string'||typeof value==='boolean')return['scalar',value];
 if(typeof value==='number'){if(!Number.isFinite(value))throw new DomainError(400,'Invalid gateway state number.');return['scalar',value];}
 if(typeof value==='bigint')return['bigint',String(value)];
 if(typeof value!=='object'||seen.has(value))throw new DomainError(400,'Unsupported gateway state.');
 seen.add(value);const visit=(item:unknown)=>encodeValue(item,seen,depth+1,budget);
 try{
  if(value instanceof ArrayBuffer)return['buffer',Buffer.from(value).toString('base64')];
  if(ArrayBuffer.isView(value)){
   const type=value instanceof Uint8Array?'Uint8Array':value.constructor.name;
   if(!Object.hasOwn(arrays,type))throw new DomainError(400,'Unsupported gateway typed array.');
   return['typed',type,Buffer.from(value.buffer,value.byteOffset,value.byteLength).toString('base64')];
  }
  if(Array.isArray(value))return['array',value.map(visit)];
  if(value instanceof Map)return['map',[...value].map(([key,item])=>[visit(key),visit(item)])];
  if(value instanceof Set)return['set',[...value].map(visit)];
  if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw new DomainError(400,'Unsupported gateway state object.');
  return['object',Object.entries(value).map(([key,item])=>{if(forbidden.has(key))throw new DomainError(400,'Unsafe gateway state key.');return[key,visit(item)];})];
 }finally{seen.delete(value);}
}
function decodeValue(value:any,depth=0):unknown {
 if(depth>64||!Array.isArray(value))throw new Error('Invalid gateway state.');
 const visit=(item:any)=>decodeValue(item,depth+1);
 switch(value[0]){
  case'undefined':return undefined;
  case'scalar':return value[1];
  case'bigint':return BigInt(value[1]);
  case'buffer':return Uint8Array.from(Buffer.from(value[1],'base64')).buffer;
  case'typed':{if(!Object.hasOwn(arrays,value[1]))throw new Error('Invalid gateway array.');const bytes=Uint8Array.from(Buffer.from(value[2],'base64'));const Type=arrays[value[1]as keyof typeof arrays];return new Type(bytes.buffer);}
  case'array':return value[1].map(visit);
  case'map':return new Map(value[1].map(([key,item]:any[])=>[visit(key),visit(item)]));
  case'set':return new Set(value[1].map(visit));
  case'object':return Object.fromEntries(value[1].map(([key,item]:any[])=>{if(typeof key!=='string'||forbidden.has(key))throw new Error('Unsafe gateway state key.');return[key,visit(item)];}));
  default:throw new Error('Invalid gateway state.');
 }
}

/** Server-only, encrypted SDK storage. Each workspace gets a separate generated Nostr secret. */
export class MarmotGatewayStore {
 constructor(private store:Store){
  if(!store.encrypted)throw new DomainError(503,'The persistent gateway requires encrypted private storage.');
  store.db.exec(`
   CREATE TABLE IF NOT EXISTS ${identityTable}(workspace TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS ${stateTable}(workspace TEXT NOT NULL,key_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(workspace,key_hash));
   CREATE TABLE IF NOT EXISTS marmot_gateway_writers(workspace TEXT PRIMARY KEY,owner TEXT NOT NULL,expires INTEGER NOT NULL);
  `);
 }
 secretKey(workspace:string):Uint8Array {
  validScope(workspace);
  return this.store.transaction(()=>{
   const row=this.store.db.prepare(`SELECT data FROM ${identityTable} WHERE workspace=?`).get(workspace);
   if(row)return Uint8Array.from(Buffer.from(this.store.decode<{secret:string}>(row.data,identityTable,hash(workspace),workspace).secret,'hex'));
   this.store.assertWriteBudget();const secret=generateSecretKey();
   this.store.db.prepare(`INSERT INTO ${identityTable}(workspace,data) VALUES(?,?)`).run(workspace,this.store.encode({secret:Buffer.from(secret).toString('hex')},identityTable,hash(workspace),workspace));return secret;
  });
 }
 storage(workspace:string):GenericKeyValueStore<unknown> {
  validScope(workspace);
  const index=(key:string)=>this.store.indexValue('gateway-sdk-key',hash(validScope(key)));
  return{
   getItem:async key=>{const id=index(key),row=this.store.db.prepare(`SELECT data FROM ${stateTable} WHERE workspace=? AND key_hash=?`).get(workspace,id);return row?decodeValue(this.store.decode<{value:unknown}>(row.data,stateTable,id,workspace).value):null;},
   setItem:async(key,value)=>{
    const id=index(key),encoded=encodeValue(value),record={key,value:encoded};
    if(Buffer.byteLength(JSON.stringify(record),'utf8')>1024*1024)throw new DomainError(413,'Gateway SDK state exceeds its record limit.');
    this.store.transaction(()=>{if(!this.store.db.prepare(`SELECT 1 FROM ${stateTable} WHERE workspace=? AND key_hash=?`).get(workspace,id)&&Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${stateTable} WHERE workspace=?`).get(workspace)!.n)>=10000)throw new DomainError(429,'Gateway SDK state capacity reached.');this.store.assertWriteBudget();this.store.db.prepare(`INSERT INTO ${stateTable}(workspace,key_hash,data) VALUES(?,?,?) ON CONFLICT(workspace,key_hash) DO UPDATE SET data=excluded.data`).run(workspace,id,this.store.encode(record,stateTable,id,workspace));});return value;
   },
   removeItem:async key=>{this.store.db.prepare(`DELETE FROM ${stateTable} WHERE workspace=? AND key_hash=?`).run(workspace,index(key));},
   clear:async()=>{this.store.db.prepare(`DELETE FROM ${stateTable} WHERE workspace=?`).run(workspace);},
   keys:async()=>this.store.db.prepare(`SELECT key_hash,data FROM ${stateTable} WHERE workspace=? ORDER BY rowid`).all(workspace).map(row=>this.store.decode<{key:string}>(row.data,stateTable,String(row.key_hash),workspace).key),
  };
 }
 /** Device-local process lock. A live writer is never replaced on timer expiry; PID reuse fails closed. */
 async runExclusive<T>(workspace:string,operation:()=>Promise<T>):Promise<T>{
  validScope(workspace);const owner=`pid:${process.pid}:${randomUUID()}`,leaseMs=120000;
  this.store.transaction(()=>{const now=Date.now(),row=this.store.db.prepare('SELECT owner,expires FROM marmot_gateway_writers WHERE workspace=?').get(workspace);if(row){const live=liveWriter(String(row.owner));if(live===true||(live===undefined&&Number(row.expires)>now))throw new DomainError(409,'This workspace gateway is already processing on this device.');}this.store.db.prepare('INSERT INTO marmot_gateway_writers(workspace,owner,expires) VALUES(?,?,?) ON CONFLICT(workspace) DO UPDATE SET owner=excluded.owner,expires=excluded.expires').run(workspace,owner,now+leaseMs);});
  const heartbeat=setInterval(()=>{try{this.store.db.prepare('UPDATE marmot_gateway_writers SET expires=? WHERE workspace=? AND owner=?').run(Date.now()+leaseMs,workspace,owner);}catch{/* A closed storage connection cannot dispatch further work. */}},30000);heartbeat.unref();
  try{return await operation();}finally{clearInterval(heartbeat);this.store.db.prepare('DELETE FROM marmot_gateway_writers WHERE workspace=? AND owner=?').run(workspace,owner);}
 }
}
