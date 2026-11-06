/** The persistent email bridge uses its own identity; authentication/wallet keys never enter this API. */
export interface GatewayEmailPayload {to:string[];cc:string[];subject:string;text:string;replyContextId?:string}
export interface GatewayEmailOutcome {state:'sent'|'unknown'|'failed';messageId?:string}
export interface GatewayMarmotMessage {id:string;groupId:string;sender:string;text:string;createdAt:number}
/** Implementations authenticate MLS senders and reject messages outside current group membership. */
export interface GatewayMarmotPort {
 readonly pubkey:string;
 invite(peerHex:string,options?:{context?:string}):Promise<{id:string}>;
 send(groupId:string,text:string):Promise<{id:string}>;
 messages(groupId:string):GatewayMarmotMessage[];
 sync():Promise<void>;
 /** Production adapters verify current MLS membership is exactly this gateway and the expected owner. */
 isAuthorized?(groupId:string,expectedOwner:string):boolean|Promise<boolean>;
 dispose?():Promise<void>;
}
export interface GatewayEmailPort {
 /** Changes whenever mailbox consent or connected credentials change. Never a raw credential. */
 authority(workspace:string):string|undefined|Promise<string|undefined>;
 active(workspace:string):boolean|Promise<boolean>;
 preview(workspace:string,invoiceId:string,text:string):GatewayEmailPayload|Promise<GatewayEmailPayload>;
 send(workspace:string,invoiceId:string,payload:GatewayEmailPayload,intentKey:string,dispatch?:{assertCurrent:()=>void|Promise<void>}):Promise<GatewayEmailOutcome>;
 review?(workspace:string,invoiceId:string,inboxItemId:string,action:'approve'|'reject'):void|Promise<void>;
}
export interface EmailGatewaySettings {
 enabled:boolean;status:'disabled'|'pending'|'paired';
 gatewayPubkey?:string;ownerPubkey?:string;groupId?:string;
 /** Returned only by an explicit configure action, never retained in plaintext storage. */
 pairCode?:string;pairExpiresAt?:string;
 lastSyncAt?:string;lastError?:'sync-unavailable'|'capacity-reached'|'authority-revoked';
}
export interface ApprovedGatewayEmail {sourceId:string;from:string;text:string}
export interface ReviewGatewayEmail extends ApprovedGatewayEmail {inboxItemId:string}
export interface GatewayForwardResult {state:'forwarded'|'duplicate'|'unknown';messageId?:string}
