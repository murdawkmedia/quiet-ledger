import {invoiceAllowsMethod} from '../shared/invoice-options.js';
import {randomUUID} from 'node:crypto';
import type {PaymentMethod} from '../shared/payment-methods.js';
import {settleInvoice} from './domain.js';
import {Store,DomainError} from './store.js';

export interface PaymentReport {id:string;invoiceId:string;invoiceNumber:string;method:PaymentMethod;amount:number;currency:string;status:'reported'|'confirmed';createdAt:string}
export class PaymentReports {
  constructor(private store:Store){store.db.exec('CREATE TABLE IF NOT EXISTS payment_reports(id TEXT PRIMARY KEY,workspace TEXT NOT NULL,invoice_id TEXT NOT NULL,method TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(invoice_id,method))');}
  list(workspace:string){return this.store.db.prepare('SELECT id,workspace,data FROM payment_reports WHERE workspace=? ORDER BY rowid DESC LIMIT 100').all(workspace).map(row=>this.store.decode<PaymentReport>(row.data,'payment_reports',String(row.id),String(row.workspace)));}
  forInvoice(invoiceId:string){const row=this.store.db.prepare('SELECT id,workspace,data FROM payment_reports WHERE invoice_id=? ORDER BY rowid DESC LIMIT 1').get(invoiceId);return row?this.store.decode<PaymentReport>(row.data,'payment_reports',String(row.id),String(row.workspace)):undefined;}
  report(workspace:string,invoiceId:string,method:PaymentMethod,now:Date){
    const invoice=this.store.getInvoice(invoiceId,workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');
    if(!invoiceAllowsMethod(invoice,method))throw new DomainError(400,'This payment method is not accepted for this invoice.');
    const existing=this.store.db.prepare('SELECT id,data FROM payment_reports WHERE workspace=? AND invoice_id=? AND method=?').get(workspace,invoiceId,method);if(existing)return this.store.decode<PaymentReport>(existing.data,'payment_reports',String(existing.id),workspace);
    const report:PaymentReport={id:randomUUID(),invoiceId,invoiceNumber:invoice.number,method,amount:invoice.total,currency:invoice.currency,status:'reported',createdAt:now.toISOString()};
    this.store.db.prepare('INSERT INTO payment_reports(id,workspace,invoice_id,method,data) VALUES(?,?,?,?,?)').run(report.id,workspace,invoiceId,method,this.store.encode(report,'payment_reports',report.id,workspace));
    this.store.audit(workspace,'payment.reported',`${invoice.number}: a ${method} report awaits workspace confirmation.`,now.toISOString());return report;
  }
  confirm(workspace:string,id:string,now:Date){
    const row=this.store.db.prepare('SELECT id,workspace,data FROM payment_reports WHERE id=? AND workspace=?').get(id,workspace);if(!row)throw new DomainError(404,'Payment report not found.');
    const report=this.store.decode<PaymentReport>(row.data,'payment_reports',String(row.id),workspace);const invoice=this.store.getInvoice(report.invoiceId,workspace);if(!invoice)throw new DomainError(404,'Invoice not found.');
    const settled=settleInvoice(this.store,workspace,invoice,report.method,now);report.status='confirmed';this.store.db.prepare('UPDATE payment_reports SET data=? WHERE id=?').run(this.store.encode(report,'payment_reports',id,workspace),id);return settled;
  }
}
