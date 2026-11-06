import type {Currency} from './contracts.js';

export interface InvoiceEmailRecipient {label:string;email:string}
export interface InvoiceEmailSettings {savedRecipients:InvoiceEmailRecipient[];selfCopyEmail?:string;senderEmail?:string;gmailConfigured?:boolean;gmailVerifiedAt?:string}
export interface InvoiceEmailSettingsInput {savedRecipients:InvoiceEmailRecipient[];selfCopyEmail?:string;senderEmail?:string;appPassword?:string;disconnectGmail?:boolean}
export interface InvoiceEmailContext {
 invoice:{id:string;number:string;title:string;customerName:string;customerEmail?:string;total:number;currency:Currency};
 settings:InvoiceEmailSettings;recipients:InvoiceEmailRecipient[];mailAppAvailable:boolean;demo:boolean;deliveries:InvoiceEmailResult[];
}
export interface InvoiceEmailRequest {action:'preview'|'draft'|'send';to:string[];copyToSelf:boolean;message?:string}
export interface InvoiceEmailResolutionInput {outcome:'confirmed_sent'|'confirmed_not_sent';note:string}
export interface InvoiceEmailResult {
 state:'preview'|'draft_ready'|'sending'|'provider_accepted'|'partial_rejection'|'unknown'|'not_sent';to:string[];cc:string[];subject:string;text:string;checkoutUrl:string;mailtoUrl?:string;
 senderEmail?:string;deliveryId?:string;messageId?:string;requestedMessageId?:string;createdAt?:string;accepted?:string[];rejected?:string[];
 resolvedAt?:string;resolutionOutcome?:InvoiceEmailResolutionInput['outcome'];resolutionNote?:string;
 kind?:'thread_reply';replyContextId?:string;replyTo?:string;inReplyTo?:string;references?:string[];
}
