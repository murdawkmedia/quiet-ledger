export type ThreadChannel='dashboard'|'email'|'marmot';

export interface InvoiceThread {
 id:string;
 invoiceId:string;
 createdAt:string;
 updatedAt:string;
}

export interface ThreadMessage {
 id:string;
 threadId:string;
 channel:ThreadChannel;
 direction:'inbound'|'outbound'|'internal';
 author:string;
 text:string;
 createdAt:string;
 parentId?:string;
 state:'recorded'|'pending'|'sent'|'failed'|'unknown';
 sourceId?:string;
}

export interface ThreadPage {
 thread:InvoiceThread;
 messages:ThreadMessage[];
 nextCursor?:string;
}
