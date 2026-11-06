import type {GenericKeyValueStore} from '@internet-privacy/marmot-ts';
import {generateSecretKey,getPublicKey} from 'nostr-tools';

const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});
const ITERATIONS=600000,MAX_BYTES=8*1024*1024;
const writers=new Set<string>();
const forbidden=new Set(['__proto__','constructor','prototype']);
function base64(bytes:Uint8Array):string {let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(binary);}
function unbase64(value:string):Uint8Array<ArrayBuffer>{if(typeof value!=='string'||value.length>MAX_BYTES*2||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new Error('Invalid private storage encoding.');return Uint8Array.from(atob(value),char=>char.charCodeAt(0));}
async function digest(value:string):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(byte=>byte.toString(16).padStart(2,'0')).join('');}

/** Tagged values cannot confuse application objects with serializer metadata. */
export function serializeMarmotValue(value:unknown):string {
 const ancestors=new Set<object>();
 const visit=(item:unknown,depth:number):unknown=>{
  if(depth>64)throw new Error('Unsupported structured storage depth.');
  if(item===undefined)return['undefined'];
  if(item===null||typeof item==='string'||typeof item==='boolean'||typeof item==='number'&&Number.isFinite(item))return['value',item];
  if(typeof item==='bigint')return['bigint',item.toString()];
  if(!item||typeof item!=='object'||ancestors.has(item))throw new Error('Unsupported structured storage value.');
  ancestors.add(item);try{
   if(item instanceof ArrayBuffer)return['buffer',base64(new Uint8Array(item))];
   if(ArrayBuffer.isView(item)){
    const names=['Uint8Array','Uint8ClampedArray','Int8Array','Uint16Array','Int16Array','Uint32Array','Int32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','DataView'];
    if(!names.includes(item.constructor.name))throw new Error('Unsupported structured typed array.');
    return['typed',item.constructor.name,base64(new Uint8Array(item.buffer,item.byteOffset,item.byteLength))];
   }
   if(Array.isArray(item))return['array',item.map(value=>visit(value,depth+1))];
   if(item instanceof Map)return['map',[...item].map(([key,value])=>[visit(key,depth+1),visit(value,depth+1)])];
   if(item instanceof Set)return['set',[...item].map(value=>visit(value,depth+1))];
   if(Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null)throw new Error('Unsupported structured storage class.');
   return['object',Object.entries(item).map(([key,value])=>{if(forbidden.has(key))throw new Error('Unsafe structured storage key.');return[key,visit(value,depth+1)];})];
  }finally{ancestors.delete(item);}
 };
 const result=JSON.stringify(visit(value,0));if(encoder.encode(result).length>MAX_BYTES)throw new Error('Private storage record is too large.');return result;
}
export function deserializeMarmotValue(text:string):unknown {
 if(typeof text!=='string'||encoder.encode(text).length>MAX_BYTES)throw new Error('Private storage record is too large.');
 const visit=(node:any,depth:number):any=>{
  if(depth>64||!Array.isArray(node)||typeof node[0]!=='string')throw new Error('Invalid structured storage.');
  switch(node[0]){
   case'undefined':if(node.length===1)return undefined;break;
   case'value':if(node.length===2&&(node[1]===null||['string','boolean'].includes(typeof node[1])||typeof node[1]==='number'&&Number.isFinite(node[1])))return node[1];break;
   case'bigint':if(node.length===2&&typeof node[1]==='string'&&/^-?[0-9]{1,256}$/.test(node[1]))return BigInt(node[1]);break;
   case'buffer':if(node.length===2)return unbase64(node[1]).buffer;break;
   case'typed':{
    if(node.length!==3)break;
    const constructors={Uint8Array,Uint8ClampedArray,Int8Array,Uint16Array,Int16Array,Uint32Array,Int32Array,Float32Array,Float64Array,BigInt64Array,BigUint64Array,DataView};
    if(!Object.hasOwn(constructors,node[1]))break;
    const Constructor=constructors[node[1] as keyof typeof constructors] as {new(buffer:ArrayBuffer):ArrayBufferView};return new Constructor(unbase64(node[2]).buffer);
   }
   case'array':if(node.length===2&&Array.isArray(node[1]))return node[1].map((value:unknown)=>visit(value,depth+1));break;
   case'map':if(node.length===2&&Array.isArray(node[1]))return new Map(node[1].map((pair:any)=>{if(!Array.isArray(pair)||pair.length!==2)throw new Error('Invalid structured map.');return[visit(pair[0],depth+1),visit(pair[1],depth+1)];}));break;
   case'set':if(node.length===2&&Array.isArray(node[1]))return new Set(node[1].map((value:unknown)=>visit(value,depth+1)));break;
   case'object':{
    if(node.length!==2||!Array.isArray(node[1]))break;const result:Record<string,unknown>={};
    for(const pair of node[1]){if(!Array.isArray(pair)||pair.length!==2||typeof pair[0]!=='string'||forbidden.has(pair[0])||Object.hasOwn(result,pair[0]))throw new Error('Unsafe structured storage key.');Object.defineProperty(result,pair[0],{value:visit(pair[1],depth+1),enumerable:true,writable:true,configurable:true});}return result;
   }
  }
  throw new Error('Invalid structured storage.');
 };
 return visit(JSON.parse(text),0);
}

/** Fail closed in browsers without cross-tab Web Locks. Node fixtures use the same-process reservation. */
export async function reserveProductionMarmotWriter(namespace:string):Promise<()=>void>{
 if(typeof namespace!=='string'||namespace.length<1||namespace.length>512||/[\u0000-\u001f\u007f]/.test(namespace))throw new Error('A bounded messaging namespace is required.');
 const scope=await digest(namespace);if(writers.has(scope))throw new Error('This messaging writer is already open.');writers.add(scope);
 let unlock:(()=>void)|undefined;
 try{
  if(typeof navigator!=='undefined'&&navigator.locks)unlock=await new Promise<()=>void>((resolve,reject)=>{void navigator.locks.request('quiet-ledger-native:'+scope,{ifAvailable:true},async lock=>{if(!lock){reject(new Error('This messaging writer is already open in another tab.'));return;}await new Promise<void>(release=>resolve(release));}).catch(reject);});
  else if(typeof window!=='undefined')throw new Error('This browser cannot safely reserve a messaging writer.');
  let released=false;return()=>{if(released)return;released=true;writers.delete(scope);unlock?.();};
 }catch(error){writers.delete(scope);throw error;}
}
async function browserStore():Promise<GenericKeyValueStore<unknown>&{close():void}>{
 if(!globalThis.indexedDB)throw new Error('Encrypted messaging requires IndexedDB.');
 const database=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('quiet-ledger-native-encrypted-v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('entries');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(new Error('Private storage could not open.'));});
 const run=<T>(mode:IDBTransactionMode,operation:(store:IDBObjectStore)=>IDBRequest<T>)=>new Promise<T>((resolve,reject)=>{const transaction=database.transaction('entries',mode),request=operation(transaction.objectStore('entries'));transaction.oncomplete=()=>resolve(request.result);transaction.onerror=transaction.onabort=()=>reject(new Error('Private storage operation failed.'));});
 return{async getItem(key){return await run('readonly',store=>store.get(key))??null;},async setItem(key,value){await run('readwrite',store=>store.put(value,key));return value;},async removeItem(key){await run('readwrite',store=>store.delete(key));},async clear(){await run('readwrite',store=>store.clear());},async keys(){return(await run('readonly',store=>store.getAllKeys())).map(String);},close(){database.close();}};
}
interface Header {version:1;iterations:number;salt:string;check:string}
export interface MarmotKeyringOptions {namespace:string;passphrase:string;storage?:GenericKeyValueStore<unknown>}
export interface MarmotKeyring {secretKey:Uint8Array;storage:GenericKeyValueStore<unknown>;exportBackup():Promise<string>;dispose():Promise<void>}
async function derive(passphrase:string,salt:Uint8Array<ArrayBuffer>):Promise<CryptoKey>{const material=await crypto.subtle.importKey('raw',encoder.encode(passphrase),'PBKDF2',false,['deriveKey']);return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations:ITERATIONS},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);}
async function seal(key:CryptoKey,plain:string,aad:string):Promise<string>{const nonce=crypto.getRandomValues(new Uint8Array(12)),cipher=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:encoder.encode(aad),tagLength:128},key,encoder.encode(plain)));return JSON.stringify([base64(nonce),base64(cipher)]);}
async function unseal(key:CryptoKey,value:unknown,aad:string):Promise<string>{try{if(typeof value!=='string'||value.length>MAX_BYTES*2)throw new Error();const pair=JSON.parse(value);if(!Array.isArray(pair)||pair.length!==2)throw new Error();const nonce=unbase64(pair[0]),cipher=unbase64(pair[1]);if(nonce.length!==12||cipher.length<16)throw new Error();return decoder.decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,additionalData:encoder.encode(aad),tagLength:128},key,cipher));}catch{throw new Error('Private storage could not decrypt or unlock.');}}
async function open(options:MarmotKeyringOptions,restored?:Uint8Array):Promise<MarmotKeyring>{
 if(typeof options.passphrase!=='string'||options.passphrase.length<12||options.passphrase.length>1024)throw new Error('Use a messaging passphrase of twelve to 1024 characters.');
 if(typeof options.namespace!=='string'||!options.namespace.length||options.namespace.length>512||/[\u0000-\u001f\u007f]/.test(options.namespace))throw new Error('A bounded messaging namespace is required.');
 const release=await reserveProductionMarmotWriter('keyring:'+await digest(options.namespace));let owned:Awaited<ReturnType<typeof browserStore>>|undefined,secretKey:Uint8Array|undefined,key:CryptoKey|undefined;let closed=false;
 try{
  owned=options.storage?undefined:await browserStore();const raw=options.storage??owned!,prefix='ql-native-keyring:v1:'+await digest(options.namespace)+':',headerKey=prefix+'header';
  const prior=await raw.getItem(headerKey);if(restored&&prior!==null)throw new Error('Restore requires an empty destination keyring.');
  if(prior===null&&(await raw.keys()).some(address=>address.startsWith(prefix)))throw new Error('Private storage header metadata is missing; preserve the encrypted records for recovery.');
  let header=prior as Header|null;
  if(header!==null&&(typeof header!=='object'||header.version!==1||header.iterations!==ITERATIONS||typeof header.salt!=='string'||typeof header.check!=='string'||Object.keys(header).some(key=>!['version','iterations','salt','check'].includes(key))))throw new Error('Private storage header could not unlock.');
  const salt=header?unbase64(header.salt):crypto.getRandomValues(new Uint8Array(16));if(salt.length!==16)throw new Error('Private storage salt could not unlock.');key=await derive(options.passphrase,salt);
  if(header){if(await unseal(key,header.check,prefix+'header')!=='quiet-ledger-native-keyring-v1')throw new Error('Private storage could not unlock.');}
  else{header={version:1,iterations:ITERATIONS,salt:base64(salt),check:await seal(key,'quiet-ledger-native-keyring-v1',prefix+'header')};await raw.setItem(headerKey,header);}
  const assertOpen=()=>{if(closed||!key)throw new Error('Messaging keyring is closed and locked.');};
  const itemKey=(name:string)=>{if(typeof name!=='string'||name.length<1||name.length>2048||name==='header'||/[\u0000-\u001f\u007f]/.test(name))throw new Error('Invalid private storage key.');return prefix+name;};
  const storage:GenericKeyValueStore<unknown>={
   async getItem(name){assertOpen();const address=itemKey(name),value=await raw.getItem(address);return value===null?null:deserializeMarmotValue(await unseal(key!,value,address));},
   async setItem(name,value){assertOpen();const address=itemKey(name),plain=serializeMarmotValue(value),sealed=await seal(key!,plain,address);assertOpen();await raw.setItem(address,sealed);return value;},
   async removeItem(name){assertOpen();await raw.removeItem(itemKey(name));},
   async keys(){assertOpen();return(await raw.keys()).filter(address=>address.startsWith(prefix)&&address!==headerKey).map(address=>address.slice(prefix.length));},
   async clear(){assertOpen();for(const name of await this.keys())await this.removeItem(name);},
  };
  const identity=await storage.getItem('identity') as {secretKey:Uint8Array}|null;
  if(identity&&(!(identity.secretKey instanceof Uint8Array)||identity.secretKey.length!==32))throw new Error('Private messaging identity is invalid.');
  secretKey=new Uint8Array(identity?.secretKey??restored??generateSecretKey());getPublicKey(secretKey);if(!identity)await storage.setItem('identity',{secretKey});else identity.secretKey.fill(0);
  const heldSecret=secretKey;
  return{secretKey,storage,async exportBackup(){assertOpen();const unlock=await reserveProductionMarmotWriter(options.namespace);try{return JSON.stringify({version:1,iterations:ITERATIONS,salt:header!.salt,payload:await seal(key!,serializeMarmotValue({secretKey:heldSecret,mode:'identity-only-rejoin'}),'quiet-ledger-native-identity-backup-v1')});}finally{unlock();}},async dispose(){if(closed)return;closed=true;heldSecret.fill(0);key=undefined;owned?.close();release();}};
 }catch(error){secretKey?.fill(0);key=undefined;owned?.close();release();throw error;}
}
export function openMarmotKeyring(options:MarmotKeyringOptions):Promise<MarmotKeyring>{return open(options);}
export async function restoreMarmotKeyring(options:MarmotKeyringOptions&{backup:string;confirmSourceStopped:true;mode:'identity-only-rejoin'}):Promise<MarmotKeyring>{
 if(options.confirmSourceStopped!==true||options.mode!=='identity-only-rejoin')throw new Error('Confirm the source writer is stopped and fresh membership/rejoin is required.');
 try{
  if(typeof options.backup!=='string'||options.backup.length>8192)throw new Error();const backup=JSON.parse(options.backup);if(backup.version!==1||backup.iterations!==ITERATIONS||typeof backup.salt!=='string')throw new Error();
  const salt=unbase64(backup.salt);if(salt.length!==16)throw new Error();const key=await derive(options.passphrase,salt),value=deserializeMarmotValue(await unseal(key,backup.payload,'quiet-ledger-native-identity-backup-v1')) as {secretKey:Uint8Array;mode:string};
  if(value.mode!=='identity-only-rejoin'||!(value.secretKey instanceof Uint8Array)||value.secretKey.length!==32)throw new Error();
  try{return await open(options,value.secretKey);}finally{value.secretKey.fill(0);}
 }catch(error){if(error instanceof Error&&/empty|already open/.test(error.message))throw error;throw new Error('Private identity backup could not decrypt or unlock.');}
}
