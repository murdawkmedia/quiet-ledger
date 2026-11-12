import type {MethodId} from './payment-methods.js';
import type {ConnectionProviderDefinition,ConnectionSummary} from './connections.js';

export type ReadinessPhase='setup'|'metadata'|'manual-check'|'funded-acceptance';
export type ReadinessStepState='done'|'todo'|'attention';
export type ReadinessLaneId='bitcoin'|'lightning'|'ark'|'cashu';
/** Funded acceptance is never measured here; the value is fixed so no code path can claim it. */
export type FundedAcceptanceState='not_tracked';
export interface ReadinessStep{id:string;phase:ReadinessPhase;label:string;detail:string;state:ReadinessStepState}
export interface WalletLaneReadiness{
  walletOptionId:ReadinessLaneId;
  name:string;
  category:string;
  providerIds:string[];
  savedCount:number;
  bestStatus:'none'|'connected'|'manual'|'unavailable';
  unavailableCount:number;
  metadataVerified:boolean;
  requiresManualConfirmation:boolean;
  fundedAcceptance:FundedAcceptanceState;
  fundedReady:false;
  steps:ReadinessStep[];
}
export type WalletReadinessInput={
  providers:Pick<ConnectionProviderDefinition,'id'|'name'|'verification'|'walletOptionIds'|'methods'|'fields'>[];
  connections:ConnectionSummary[];
};

interface LaneSpec{walletOptionId:ReadinessLaneId;name:string;category:string;method?:MethodId;providerIds:string[];manualDetail?:(connectedProviders:string[])=>string}

const LNURL_FAMILY=['lightning-address','lnurl'];
/** Fixed lane order and membership. Only real provider ids belong here; unknown rows are ignored. */
const LANES:LaneSpec[]=[
  {walletOptionId:'bitcoin',name:'Bitcoin on-chain',category:'Bitcoin',method:'bitcoin',providerIds:['bitcoin-core','watch-only','static-crypto'],
    manualDetail:()=> 'Saved receiving instructions have no automatic metadata check and never pass one. Confirm each received transaction yourself; a saved address is a single dedicated allocation, not an address pool.'},
  {walletOptionId:'lightning',name:'Lightning',category:'Lightning',method:'lightning',providerIds:['lightning-address','lnurl','lnd'],
    manualDetail:connected=>connected.some(id=>LNURL_FAMILY.includes(id))
      ?'Lightning Address and LNURL need settlement-proof support for automatic verification. If your receiver does not provide it, review the payment in your owner workspace. LND checks exact invoice settlement automatically.'
      :'Use the invoice payment check to verify exact LND settlement.'},
  {walletOptionId:'ark',name:'Ark via Bark',category:'Ark',method:'ark',providerIds:['bark'],
    manualDetail:()=> 'Ark VTXO observations need manual invoice attribution and no address pool is created. The saved Bark connection checks only the pinned server public key and your existing indexed address; confirm the allocation for every payment yourself, even after a successful metadata check.'},
  {walletOptionId:'cashu',name:'Cashu ecash',category:'Ecash',providerIds:[]},
];

const FUNDED_LABEL='Funded acceptance: not recorded by this connection check';
const FUNDED_DETAIL='Receive and confirm a real payment yourself through your invoices and receipts. This screen never records funded acceptance, and a green connection label is not proof of payment.';

function rowsForLane(spec:LaneSpec,input:WalletReadinessInput,definitions:Map<string,WalletReadinessInput['providers'][number]>){
  const method=spec.method;
  if(!method)return [] as {connection:ConnectionSummary;automatic:boolean}[];
  return input.connections.filter(connection=>{
    const definition=definitions.get(connection.provider);
    return Boolean(definition&&spec.providerIds.includes(connection.provider)&&Array.isArray(connection.methods)&&connection.methods.includes(method));
  }).map(connection=>({connection,automatic:definitions.get(connection.provider)!.verification==='automatic'}));
}

/** Pure derivation from public definitions and connection summaries. No fetch, no clock, no field values, no secrets. */
export function walletReadinessLanes(input:WalletReadinessInput):WalletLaneReadiness[]{
  const definitions=new Map(input.providers.map(provider=>[provider.id,provider]));
  return LANES.map(spec=>{
    const rows=rowsForLane(spec,input,definitions);
    const savedCount=rows.length;
    const unavailableCount=rows.filter(entry=>entry.connection.status==='unavailable').length;
    const connected=rows.filter(entry=>entry.connection.status==='connected');
    const bestStatus=savedCount===0?'none':connected.length>0?'connected':rows.some(entry=>entry.connection.status==='manual')?'manual':'unavailable';
    // Metadata claims come only from a live connection whose served method matches the lane.
    const metadataVerified=rows.some(entry=>entry.automatic&&entry.connection.status==='connected'&&entry.connection.mode==='live'&&typeof entry.connection.verifiedAt==='string'&&entry.connection.verifiedAt.length>0);
    const active=rows.filter(entry=>entry.connection.status==='connected'||entry.connection.status==='manual');
    const onlyManualActive=active.length>0&&active.every(entry=>!entry.automatic);
    const requiresManualConfirmation=spec.walletOptionId==='ark'||(spec.walletOptionId==='lightning'&&active.some(entry=>LNURL_FAMILY.includes(entry.connection.provider)))||(spec.walletOptionId==='bitcoin'&&onlyManualActive);
    const steps:ReadinessStep[]=[];
    if(spec.walletOptionId==='cashu'){
      steps.push({id:'cashu-setup',phase:'setup',state:'todo',label:'Cashu receiving is not configured in Connections',
        detail:'Customers can currently pay a verified Lightning invoice from their Cashu wallet. Wallet and mint fees may apply; your receipt records Lightning. Native Cashu receiving needs a merchant wallet setup.'});
    }else{
      steps.push({id:`${spec.walletOptionId}-setup`,phase:'setup',state:savedCount>0?'done':'todo',label:savedCount>0?'Connection saved':'Save a provider connection',
        detail:savedCount>0?`${savedCount} saved connection row${savedCount===1?'':'s'} ${savedCount===1?'holds':'hold'} the details for this lane.`:'Connect one of this lane\'s providers below to save its receiving details.'});
      const hasAutomatic=rows.some(entry=>entry.automatic);
      const mixed=metadataVerified&&unavailableCount>0;
      const metadataState:ReadinessStepState=metadataVerified?(mixed?'attention':'done'):unavailableCount>0||bestStatus==='manual'?'attention':'todo';
      const metadataDetail=metadataVerified
        ?mixed?`${unavailableCount} saved row${unavailableCount===1?'':'s'} in this lane failed the last check. A success never hides a failure; recheck the failed rows before relying on this lane.`
          :'The latest automatic check on a live connection read the provider metadata. Exact settlement is checked through the invoice and receipt; this connection check creates no payment request.'
        :unavailableCount>0?'The latest metadata check failed for a saved row. Your settings are kept; recheck the connection when provider access is restored.'
          :bestStatus==='manual'?'These saved instructions have no automatic metadata check and never pass one; confirm each received payment yourself.'
            :'After saving a connection, its automatic check reads provider metadata only. A metadata check never creates an invoice and never proves a payment.';
      steps.push({id:`${spec.walletOptionId}-metadata`,phase:'metadata',state:metadataState,
        label:metadataVerified?(mixed?'Metadata check passed with failed rows':'Metadata check passed'):metadataState==='attention'?(unavailableCount>0?'Last metadata check failed':'Manual instructions only'):'Run a metadata check',
        detail:metadataDetail});
      if(requiresManualConfirmation){
        const connectedProviders=active.map(entry=>entry.connection.provider);
        steps.push({id:`${spec.walletOptionId}-manual-check`,phase:'manual-check',state:'attention',label:'Needs your confirmation',
          detail:spec.manualDetail?spec.manualDetail(connectedProviders):'Confirm each payment yourself.'});
      }
    }
    steps.push({id:`${spec.walletOptionId}-funded-acceptance`,phase:'funded-acceptance',state:'todo',label:FUNDED_LABEL,detail:FUNDED_DETAIL});
    return {
      walletOptionId:spec.walletOptionId,name:spec.name,category:spec.category,providerIds:[...spec.providerIds],
      savedCount,bestStatus,unavailableCount,metadataVerified,requiresManualConfirmation,
      fundedAcceptance:'not_tracked',fundedReady:false as const,steps,
    };
  });
}
