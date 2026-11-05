import {createCipheriv,createDecipheriv,hkdfSync,randomBytes} from 'node:crypto';

export const MAX_RECORD_BYTES=2*1024*1024;
export const MAX_BACKUP_BYTES=64*1024*1024;
const RECORD_PREFIX='qlr:v1:';
const BACKUP_HEADER=Buffer.from([0x51,0x4c,0x42,0x01]);
const NONCE_BYTES=12;
const TAG_BYTES=16;
const OVERHEAD=NONCE_BYTES+TAG_BYTES;
const HKDF_SALT=Buffer.from('quiet-ledger/private-storage/hkdf/v1','utf8');
const FAILURE='Private storage could not be processed.';

export interface RecordContext {table:string;id:string;workspace:string}
export interface RecordCodec {
  encode(value:unknown,context:RecordContext):string;
  decode<T=any>(value:unknown,context:RecordContext):T;
}

function protect<T>(operation:()=>T):T {
  try{return operation();}catch{throw new Error(FAILURE);}
}
function checkedKey(value:unknown):Buffer {
  if(!Buffer.isBuffer(value)||value.length!==32)throw new Error(FAILURE);
  return Buffer.from(value);
}
function checkedText(value:unknown,max:number):string {
  if(typeof value!=='string'||value.length<1||value.length>max||Buffer.byteLength(value,'utf8')>max||/[\u0000-\u001f\u007f]/.test(value))throw new Error(FAILURE);
  return value;
}
function recordContext(value:RecordContext):RecordContext {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error(FAILURE);
  return {table:checkedText(value.table,128),id:checkedText(value.id,512),workspace:checkedText(value.workspace,512)};
}
function derivedKey(master:Buffer,purpose:'record'|'backup',scope:string):Buffer {
  return Buffer.from(hkdfSync('sha256',master,HKDF_SALT,Buffer.from(JSON.stringify(['quiet-ledger',purpose,'v1',scope]),'utf8'),32));
}
function recordAad(context:RecordContext):Buffer {
  return Buffer.from(JSON.stringify(['quiet-ledger','record','v1',context.workspace,context.table,context.id]),'utf8');
}
function backupAad(context:string):Buffer {
  return Buffer.from(JSON.stringify(['quiet-ledger','backup','v1',context]),'utf8');
}
function seal(plain:Buffer,master:Buffer,purpose:'record'|'backup',scope:string,aad:Buffer):Buffer {
  const nonce=randomBytes(NONCE_BYTES),key=derivedKey(master,purpose,scope);
  try{
    const cipher=createCipheriv('aes-256-gcm',key,nonce,{authTagLength:TAG_BYTES});
    cipher.setAAD(aad);
    const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);
    return Buffer.concat([nonce,cipher.getAuthTag(),ciphertext]);
  }finally{key.fill(0);}
}
function unseal(value:Buffer,master:Buffer,purpose:'record'|'backup',scope:string,aad:Buffer,maxBytes:number):Buffer {
  if(value.length<OVERHEAD||value.length>maxBytes+OVERHEAD)throw new Error(FAILURE);
  const key=derivedKey(master,purpose,scope);
  try{
    const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,NONCE_BYTES),{authTagLength:TAG_BYTES});
    cipher.setAAD(aad);cipher.setAuthTag(value.subarray(NONCE_BYTES,OVERHEAD));
    return Buffer.concat([cipher.update(value.subarray(OVERHEAD)),cipher.final()]);
  }finally{key.fill(0);}
}
function serialize(value:unknown):Buffer {
  const text=JSON.stringify(value);
  if(typeof text!=='string'||Buffer.byteLength(text,'utf8')>MAX_RECORD_BYTES)throw new Error(FAILURE);
  return Buffer.from(text,'utf8');
}
function parse<T>(bytes:Buffer):T {
  // Reject invalid UTF8 instead of silently replacing malformed byte sequences.
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)) as T;
}

/** Authenticated at-rest encryption. The backend holding the external key can decrypt. */
export function createRecordCodec(key?:Buffer):RecordCodec {
  return protect(()=>{
    const master=key===undefined?undefined:checkedKey(key);
    return {
      encode(value,rawContext){return protect(()=>{
        const context=recordContext(rawContext),plain=serialize(value);
        try{
          if(!master)return plain.toString('utf8');
          return RECORD_PREFIX+seal(plain,master,'record',context.workspace,recordAad(context)).toString('base64url');
        }finally{plain.fill(0);}
      });},
      decode<T=any>(value:unknown,rawContext:RecordContext):T{return protect(()=>{
        const context=recordContext(rawContext);
        if(typeof value!=='string')throw new Error(FAILURE);
        if(!master){
          if(Buffer.byteLength(value,'utf8')>MAX_RECORD_BYTES)throw new Error(FAILURE);
          return JSON.parse(value) as T;
        }
        if(!value.startsWith(RECORD_PREFIX)||value.length>RECORD_PREFIX.length+Math.ceil((MAX_RECORD_BYTES+OVERHEAD)*4/3))throw new Error(FAILURE);
        const text=value.slice(RECORD_PREFIX.length);
        if(!/^[A-Za-z0-9_-]+$/.test(text))throw new Error(FAILURE);
        const encoded=Buffer.from(text,'base64url');
        if(encoded.toString('base64url')!==text)throw new Error(FAILURE);
        const plain=unseal(encoded,master,'record',context.workspace,recordAad(context),MAX_RECORD_BYTES);
        try{return parse<T>(plain);}finally{plain.fill(0);}
      });},
    };
  });
}

/** Binary archive format: QLB + version1, then nonce12, tag16 and ciphertext. */
export function encryptBackup(data:Buffer,key:Buffer,rawContext:string):Buffer {
  return protect(()=>{
    const context=checkedText(rawContext,1024);
    if(!Buffer.isBuffer(data)||data.length>MAX_BACKUP_BYTES)throw new Error(FAILURE);
    const master=checkedKey(key);
    try{return Buffer.concat([BACKUP_HEADER,seal(data,master,'backup',context,backupAad(context))]);}
    finally{master.fill(0);}
  });
}

export function decryptBackup(data:Buffer,key:Buffer,rawContext:string):Buffer {
  return protect(()=>{
    const context=checkedText(rawContext,1024);
    if(!Buffer.isBuffer(data)||data.length<BACKUP_HEADER.length+OVERHEAD||data.length>BACKUP_HEADER.length+OVERHEAD+MAX_BACKUP_BYTES||!data.subarray(0,BACKUP_HEADER.length).equals(BACKUP_HEADER))throw new Error(FAILURE);
    const master=checkedKey(key);
    try{return unseal(data.subarray(BACKUP_HEADER.length),master,'backup',context,backupAad(context),MAX_BACKUP_BYTES);}
    finally{master.fill(0);}
  });
}
