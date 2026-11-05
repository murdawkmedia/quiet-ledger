import {DEMO_REPLY_INTENTS,type DemoCase,type DemoInference,type DemoReplyIntent,type DemoRole} from '../shared/demo-agents.js';
import {assertCase} from './demo-agent-case.js';

// Free prose can discuss the fictional business, never assert financial facts.
// Keep these guards aligned with agents/demo/worker.py. Financial intents bypass
// prose entirely and are rendered from the case re-read immediately before send.
const financialWords=/\b(?:paid|unpaid|pay(?:ment|ments|ing)?|receipts?|funds?|money|cash|cashu|bitcoin|btc|sats?|satoshis?|cad|usd|krw|eur|gbp|dollars?|cents?|won|euros?|pounds?|rates?|prices?|pric(?:ed|ing)|costs?|fees?|charges?|charg(?:ed|ing)|tax(?:es)?|totals?|subtotals?|discounts?|premiums?|amounts?|balances?|owes?|owed|owing|due|settled|settlement|cleared|credited|debited|refunded|refunds?|deposits?|transfers?|transactions?)\b/iu;
// Creative verbs are safe on their own; a financial object or status makes
// a claim authoritative, so those combinations stay with the fact renderer.
const financialActions=String.raw`(?:receiv(?:e|ed|ing)|approv(?:e|ed|ing)|authoriz(?:e|ed|ing)|authoris(?:e|ed|ing)|updat(?:e|ed|ing)|chang(?:e|ed|ing)|record(?:ed|ing)?|mark(?:ed|ing)?|set|delet(?:e|ed|ing)|remov(?:e|ed|ing)|modif(?:y|ied|ying)|sav(?:e|ed|ing)|edit(?:ed|ing)?|creat(?:e|ed|ing))`;
const financialTargets=String.raw`(?:invoices?(?:\s+status)?|ledger(?:\s+(?:status|entries?))?|bills?(?:\s+status)?|accounts?(?:\s+(?:status|records?))?|records?|status)`;
const financialModifiers=String.raw`(?:(?:the|a|an|your|my|our|this|that|these|those|current|fictional|demo|latest|new|existing|simulated|is|are|was|were|has|have|had|been|being|now|already|just|successfully|fully|newly|still|not|never|it|in|on|as|all)\s+)`;
const financialStatuses=String.raw`(?:open|closed|complete|completed|done|sorted|final|void|voided|cancelled|canceled|outstanding|okay|ok|square)`;
const financialRecordClaim=new RegExp(String.raw`\b${financialActions}\s+${financialModifiers}{0,6}${financialTargets}\b|\b${financialTargets}\s*(?::|\s)\s*${financialModifiers}{0,6}(?:${financialActions}|${financialStatuses})\b`,'iu');
const implicitRecordClaim=new RegExp(String.raw`\b(?:I|we)(?:['’]ve| have)?\s+(?:just\s+|already\s+)?${financialActions}\s+(?:it|that|this|them)(?:\s+as requested)?(?=\s*[.!?]|$)`,'iu');
function assertProse(reply:string){
 const text=reply.normalize('NFKC');
 if(/[\p{N}\p{Sc}]/u.test(text)||financialWords.test(text)||financialRecordClaim.test(text)||implicitRecordClaim.test(text))throw new Error('Model prose cannot assert financial facts.');
 if(/^(?:Riley|Jordan)\s*(?::|[-—–]|here\b)|\b(?:I am|I'm|I’m|as) an? (?:AI|language model|demo client|demo accountant)\b|\bdemo snapshot\b/iu.test(text))throw new Error('The demo reply includes sender boilerplate.');
}
export function validateDemoInference(value:unknown):DemoInference{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid Hermes reply.');
 const row=value as Record<string,unknown>;
 if(Object.keys(row).some(key=>!['runtime','model','intent','reply'].includes(key))||row.runtime!=='hermes'||typeof row.model!=='string'||!/^[A-Za-z0-9._:/-]{1,128}$/.test(row.model)||!DEMO_REPLY_INTENTS.includes(row.intent as DemoReplyIntent))throw new Error('Invalid Hermes reply.');
 if(row.reply!==undefined&&(typeof row.reply!=='string'||!row.reply.trim()||row.reply!==row.reply.trim()||Array.from(row.reply).length>1000||Buffer.byteLength(row.reply)>3000||/[\p{Cc}\p{Cf}]/u.test(row.reply.replace(/\n/g,''))||(row.reply.match(/\?/g)?.length??0)>1))throw new Error('Invalid Hermes reply text.');
 if(typeof row.reply==='string'&&!['check-total','explain-recorded-status'].includes(row.intent as string))assertProse(row.reply);
 return {runtime:'hermes',model:row.model,intent:row.intent as DemoReplyIntent,...(typeof row.reply==='string'?{reply:row.reply}:{})};
}

export function renderDemoReply(role:DemoRole,intentOrInference:DemoReplyIntent|DemoInference,context:DemoCase):string{
 assertCase(context);
 const inference=typeof intentOrInference==='string'?undefined:validateDemoInference(intentOrInference);
 const intent=inference?.intent??intentOrInference as DemoReplyIntent;
 if(!DEMO_REPLY_INTENTS.includes(intent))throw new Error('Unknown demo reply intent.');
 const amount=(n:number)=>context.currency+' '+new Intl.NumberFormat('en-CA',{minimumFractionDigits:context.currency==='KRW'?0:2,maximumFractionDigits:context.currency==='KRW'?0:2}).format(n/(context.currency==='KRW'?1:100));
 const reference=context.invoiceNumber?`${context.invoiceNumber}: `:'';
 if(intent==='check-total')return `${reference}Subtotal ${amount(context.lineAmount)}, discount ${amount(context.discountAmount??0)}, premium ${amount(context.premiumAmount??0)}, tax ${amount(context.tax)}. The total is ${amount(context.total)}.`;
 if(intent==='explain-recorded-status')return context.status==='paid'?`${reference}The ledger records a simulated ${amount(context.total)} receipt. No real funds moved.`:`${reference}No payment is recorded on this fictional invoice. A chat message cannot confirm it; the merchant can record a simulated receipt.`;
 if(inference?.reply)return inference.reply;
 // Compatibility for old injected typed fixtures. The HTTP adapter requires
 // model-composed prose, so these are never a provider-failure fallback.
 if(intent==='explain-marmot')return 'Marmot uses Nostr identities and MLS encryption for this chat. Relays carry ciphertext and metadata. Participating agents and their model provider can read decrypted messages; the ledger operator can read invoice records.';
 if(intent==='request-review')return role==='client'?'We can review the scope together. What wording would you like to change?':'I can flag the wording for the merchant to review. What needs correcting?';
 if(intent==='explain-scope'&&context.title)return `The current work is “${context.title}”. What would you like to clarify?`;
 return role==='client'?'We run hands-on private-messaging workshops. Clear filmed demos and captioned walkthroughs would help people follow along. What kind of work would you like to help with?':'We run private-messaging workshops. I help keep the scope, approvals and invoice wording clear. What would you like to work through?';
}
