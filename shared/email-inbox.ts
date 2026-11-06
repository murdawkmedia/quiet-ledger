export type EmailInboxError='sync_failed'|'timed_out'|'uid_validity_changed';
export interface EmailInboxSettings {
 enabled:boolean;folder:string;mailboxId?:string;senderEmail?:string;lastSyncedAt?:string;lastError?:EmailInboxError;retentionNotice:string;
}
export interface EmailInboxConfigureInput {enabled:boolean;folder:string}
export interface EmailOutboundBinding {
 id:string;mailboxId:string;invoiceId:string;threadId:string;deliveryId:string;requestedMessageId:string;providerMessageId?:string;
 senderEmail:string;to:string[];cc:string[];subject:string;createdAt:string;
 references?:string[];
}
export type EmailInboxReason='unverified_sender'|'ambiguous_references'|'recipient_mismatch'|'provider_id_collision'|'rfc_id_collision'|'malformed_headers'|'automated_message'|'no_plain_text'|'oversize_body';
export interface EmailInboxItem {
 id:string;mailboxId:string;providerId:string;uid:number;uidValidity:string;sourceId:string;messageId?:string;
 invoiceId?:string;threadId?:string;threadMessageId?:string;bindingId?:string;
 from:string[];to:string[];cc:string[];replyTo:string[];subject?:string;text?:string;hasAttachments:boolean;
 authentication:'unverified';status:'requires_review'|'quarantined'|'approved'|'rejected';reason:EmailInboxReason;createdAt:string;reviewedAt?:string;
}
export interface EmailInboxSyncResult {
 status:'disabled'|'initialized'|'synced'|'reset'|'disconnected'|'cancelled'|'failed'|'busy';
 imported:number;quarantined:number;skipped:number;error?:EmailInboxError;
}
export interface EmailApprovedReplyContext {item:EmailInboxItem;binding:EmailOutboundBinding}
