/** Public demo contracts. No connector credential or signing material belongs here. */
export type DemoRole='client'|'accountant';
export type DemoChannel=DemoRole|'group';
export const DEMO_CHANNELS=['client','accountant','group'] as const;
export interface DemoRoom {groupId:string;nostrGroupId:string}
export interface DemoConversationMessage {speaker:'human'|DemoRole;text:string}
export const DEMO_MAX_ROUNDS=12;
export function demoRooms(lease:{rooms?:Partial<Record<DemoChannel,DemoRoom>>;groupId?:string;nostrGroupId?:string}){
 return {...(lease.groupId&&lease.nostrGroupId?{group:{groupId:lease.groupId,nostrGroupId:lease.nostrGroupId}}:{}),...lease.rooms} as Partial<Record<DemoChannel,DemoRoom>>;
}

export const DEMO_ROLE_NAMES:Record<DemoRole,string>={client:'Riley',accountant:'Jordan'};
export const DEMO_REPLY_INTENTS=['conversation','explain-scope','check-total','request-review','explain-recorded-status','explain-marmot'] as const;
export type DemoReplyIntent=typeof DEMO_REPLY_INTENTS[number];
export interface DemoCase {fictional:true;currency:'CAD'|'USD'|'KRW'|'EUR'|'GBP';lineAmount:number;tax:number;total:number;discountAmount?:number;premiumAmount?:number;invoiceNumber?:string;title?:string;status:'open'|'paid';settlementMode:'simulation';receiptRecorded:boolean;version:number;asOf:string}
export interface DemoMember {role:DemoRole;name:string;pubkey:string}
export interface DemoTurnIssue {messageId:string;role:DemoRole;channel:DemoChannel}
export interface DemoAgentProvider {runtime:'hermes'|'codex';model?:string;reasoningEffort?:'max'}
export type DemoTeamState='idle'|'preparing'|'waiting'|'ready'|'paused'|'offline'|'expired';
export interface DemoTeamView {available:boolean;runtime:'hermes'|'mixed';providers?:Partial<Record<DemoRole,DemoAgentProvider>>;state:DemoTeamState;relayPath:string;members:DemoMember[];leaseId?:string;generation?:number;expiresAt?:string;roundsRemaining:number;humanPubkey?:string;groupId?:string;nostrGroupId?:string;model?:string;issue?:string;turnIssues?:DemoTurnIssue[];rooms?:Partial<Record<DemoChannel,DemoRoom>>;whiteNoiseAvailable:false}
export interface DemoInference {intent:DemoReplyIntent;model:string;runtime:'hermes'|'codex';reply?:string}
export interface DemoTeamLease {id:string;workspace:string;generation:number;humanPubkey:string;relayToken?:string;members:DemoMember[];state:DemoTeamState;createdAt:string;expiresAt:string;roundsRemaining:number;groupId?:string;nostrGroupId?:string;model?:string;issue?:string;turnIssues?:DemoTurnIssue[];rooms?:Partial<Record<DemoChannel,DemoRoom>>}
