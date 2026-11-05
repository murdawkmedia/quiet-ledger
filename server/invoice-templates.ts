import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {InvoiceTemplate} from '../shared/invoice-options.js';
import {Store,DomainError} from './store.js';
import {invoiceSchema,parse} from './domain.js';
const table='invoice_templates';
export class InvoiceTemplates {
 constructor(private store:Store){store.db.exec(`CREATE TABLE IF NOT EXISTS ${table}(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,data TEXT NOT NULL);CREATE INDEX IF NOT EXISTS invoice_templates_workspace ON ${table}(workspace);`);}
 list(workspace:string):InvoiceTemplate[]{return this.store.db.prepare(`SELECT id,data FROM ${table} WHERE workspace=? ORDER BY rowid DESC LIMIT 32`).all(workspace).map(row=>this.store.decode(row.data,table,String(row.id),workspace));}
 save(workspace:string,body:unknown):InvoiceTemplate{const input=parse(z.object({id:z.string().uuid().optional(),label:z.string().trim().min(1).max(80),draft:invoiceSchema}).strict(),body);return this.store.transaction(()=>{if(input.id&&!this.store.db.prepare(`SELECT 1 FROM ${table} WHERE id=? AND workspace=?`).get(input.id,workspace))throw new DomainError(404,'Invoice template not found.');if(!input.id&&Number(this.store.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE workspace=?`).get(workspace)!.n)>=32)throw new DomainError(429,'This workspace has reached its invoice template limit.');this.store.assertWriteBudget();const value:InvoiceTemplate={id:input.id??randomUUID(),label:input.label,draft:input.draft};this.store.db.prepare(`INSERT INTO ${table}(id,workspace,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE workspace=excluded.workspace`).run(value.id,workspace,this.store.encode(value,table,value.id,workspace));return value;});}
 remove(workspace:string,id:string){const result=this.store.db.prepare(`DELETE FROM ${table} WHERE id=? AND workspace=?`).run(id,workspace);if(!result.changes)throw new DomainError(404,'Invoice template not found.');return {deleted:true};}
}
