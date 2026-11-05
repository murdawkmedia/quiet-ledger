/** Deterministic transport fixture for UI behavior only; real crypto is tested separately. */
import type {MarmotMessage,MarmotMessageKind,MarmotParticipantOptions,MarmotParticipant} from '../../client/marmot-engine';
const text={update:'A private update is available. Review it in Quiet Ledger.',acknowledge:'I acknowledge the private update.',review:'Please review the details in Quiet Ledger.','receipt-notice':'A receipt is ready. Open it in Quiet Ledger.'};
const control={participants:0,disposed:0,failSend:false,created:false,namespaces:[] as string[],sent:[] as string[]};
(window as Window&{__marmotTest?:typeof control}).__marmotTest=control;
let messages:MarmotMessage[]=[];
let sequence=0;
export const getMarmotDeviceId=async()=> 'fictional-device';
export async function createMarmotParticipant(options:MarmotParticipantOptions):Promise<MarmotParticipant>{
  control.participants++;control.namespaces.push(options.namespace);
  const pubkey=(options.role==='merchant'?'a':'b').repeat(64);let ready=false;let history:MarmotMessage[]=[];let peer:string|undefined;
  async function event(kind:number){await options.network.publish({id:String(++sequence).padStart(64,'0'),pubkey,created_at:Math.floor(Date.now()/1000),kind,tags:[],content:'fictional-encrypted-test-envelope',sig:'0'.repeat(128)});}
  return {pubkey,async ensureKeyPackage(){await event(30443);},async createConversation(value){peer=value;control.created=true;ready=true;},async acceptInvitation(value){peer=value;if(control.created)ready=true;return ready;},async sync(){await options.network.query([{kinds:[445],limit:10}]);history=[...messages];},async send(kind:MarmotMessageKind){if(control.failSend){control.failSend=false;throw new Error('DO-NOT-RENDER-sensitive-error');}if(!ready)throw new Error('Not ready');await event(445);control.sent.push(kind);const message={id:String(++sequence),kind,text:text[kind],sender:pubkey,createdAt:Math.floor(Date.now()/1000)};messages=[...messages,message];history=[...messages];},messages:()=>history,conversation:()=>({ready,peerPubkey:peer}),async dispose(){control.disposed++;}};
}
