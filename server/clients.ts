import {randomUUID} from 'node:crypto';
import {nip19} from 'nostr-tools';
import {z} from 'zod';
import type {ClientRecord} from '../shared/clients.js';
import {parse} from './domain.js';
import {DomainError,Store} from './store.js';

const table='client_contacts',limit=500;
const optionalText=(max:number)=>z.string().trim().max(max).transform(value=>value||undefined).optional();
const email=z.string().max(254)
  .refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use a single email address without control characters.')
  .transform(value=>value.trim())
  .pipe(z.union([z.email(),z.literal('')]))
  .transform(value=>value||undefined).optional();
const marmotPubkey=z.string().max(4096).trim().transform((value,context)=>{
  if(!value)return undefined;
  if(/^[0-9a-f]{64}$/i.test(value))return value.toLowerCase();
  try{
    const decoded=nip19.decode(value);
    const pubkey=decoded.type==='npub'?decoded.data:decoded.type==='nprofile'?decoded.data.pubkey:undefined;
    if(pubkey&&/^[0-9a-f]{64}$/i.test(pubkey))return pubkey.toLowerCase();
  }catch{}
  context.addIssue({code:'custom',message:'Enter an npub, nprofile or 64-character public key. Never use a secret key.'});
  return z.NEVER;
}).optional();
const inputSchema=z.object({
  id:z.string().uuid().optional(),
  name:z.string().trim().min(1).max(120),
  email,
  marmotPubkey,
  billingAddress:optionalText(1000),
  currency:z.enum(['CAD','USD','EUR','GBP','KRW','SAT']).default('CAD'),
  notes:optionalText(2000),
}).strict();

export class Clients {
  constructor(private store:Store,private now:()=>Date){
    store.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS client_contacts_workspace ON ${table}(workspace);`);
  }

  list(workspace:string):ClientRecord[]{
    return this.store.db.prepare(`SELECT id,data FROM ${table} WHERE workspace=? ORDER BY rowid DESC LIMIT ${limit}`)
      .all(workspace).map(row=>this.store.decode<ClientRecord>(row.data,table,String(row.id),workspace));
  }

  get(workspace:string,id:string):ClientRecord|undefined{
    const row=this.store.db.prepare(`SELECT data FROM ${table} WHERE id=? AND workspace=?`).get(id,workspace);
    return row?this.store.decode<ClientRecord>(row.data,table,id,workspace):undefined;
  }

  save(workspace:string,body:unknown):ClientRecord{
    const input=parse(inputSchema,body);
    return this.store.transaction(()=>{
      const previous=input.id?this.get(workspace,input.id):undefined;
      if(input.id&&!previous)throw new DomainError(404,'Client not found.');
      if(!input.id&&Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace=?`).get(workspace)!.n)>=limit)
        throw new DomainError(429,'This workspace has reached its saved client limit.');
      this.store.assertWriteBudget();
      const timestamp=this.now().toISOString();
      const client:ClientRecord={
        id:input.id??randomUUID(),name:input.name,currency:input.currency,
        ...(input.email?{email:input.email}:{}),
        ...(input.marmotPubkey?{marmotPubkey:input.marmotPubkey}:{}),
        ...(input.billingAddress?{billingAddress:input.billingAddress}:{}),
        ...(input.notes?{notes:input.notes}:{}),
        createdAt:previous?.createdAt??timestamp,updatedAt:timestamp,
      };
      this.store.db.prepare(`INSERT INTO ${table}(id,workspace,data) VALUES(?,?,?)
        ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE workspace=excluded.workspace`)
        .run(client.id,workspace,this.store.encode(client,table,client.id,workspace));
      return client;
    });
  }

  remove(workspace:string,id:string):{removed:true}{
    const result=this.store.db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace=?`).run(id,workspace);
    if(!result.changes)throw new DomainError(404,'Client not found.');
    return {removed:true};
  }
}
