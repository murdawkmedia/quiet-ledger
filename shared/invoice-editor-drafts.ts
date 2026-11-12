import type {Currency,InvoiceBilling} from './contracts.js';
import type {MethodId,PaymentMethod} from './payment-methods.js';
import {PAYMENT_METHOD_IDS} from './payment-methods.js';
import type {FIAT_RULE_TARGET} from './method-pricing-types.js';

/**
 * Private server-side saved invoice editor drafts.
 *
 * The snapshot is a strict, versioned copy of the raw editor strings: incomplete
 * values (a half-typed price, an unfinished date) survive exactly as typed, and
 * strict invoice validation still happens only at issue time. Nothing here is
 * ever an invoice: saving allocates no invoice number, checkout token or
 * outbound action, and no plaintext financial autosave reaches the browser's
 * localStorage — records stay in the encrypted workspace store.
 */
export const INVOICE_EDITOR_DRAFTS_LIMITS={drafts:200,lines:40,rules:8,methods:32,bytes:16384} as const;

export type InvoiceEditorLineKind='service'|'expense';
export interface InvoiceEditorLine {id:string;description:string;quantity:string;price:string;kind:InvoiceEditorLineKind;adjustmentEligible:boolean}
/** Optional per-rule adjustment base in the raw editor row; absent keeps the legacy eligible default. */
export type InvoiceEditorRuleBasis='eligible'|'subtotal';
/** Raw method-rule editor row; the method may still be unselected while editing, and the all-fiat group is a rule target only. */
export interface InvoiceEditorRule {id:string;method:MethodId|typeof FIAT_RULE_TARGET|'';discount:string;premium:string;basis?:InvoiceEditorRuleBasis}
export type InvoiceEditorSchedule='calendar'|'0'|'30'|'60'|'90'|'custom';

export interface InvoiceEditorSnapshot {
  version:1;
  customerName:string;customerEmail:string;title:string;
  issueDate:string;dueDate:string;currency:Currency;
  tax:string;discount:string;premium:string;note:string;
  lines:InvoiceEditorLine[];
  schedule:InvoiceEditorSchedule;customDays:string;paymentTerms:string;
  allMethods:boolean;accepted:PaymentMethod[];
  methodRules:InvoiceEditorRule[];
  clientId:string;
  billing:Partial<InvoiceBilling>;
  /** Line ids whose expense content was copied from a template, recurring draft or issued invoice. */
  carriedLineIds:string[];
  /** Fingerprint of the carried expense content when the owner last acknowledged it. */
  carriedExpenseAck?:string;
}

export interface SavedInvoiceDraftSummary {
  id:string;revision:number;createdAt:string;updatedAt:string;
  status:'draft'|'issued';invoiceId?:string;
  title:string;customerName:string;currency:Currency;
}
export interface SavedInvoiceDraft extends SavedInvoiceDraftSummary {snapshot:InvoiceEditorSnapshot}

/** Deterministic sorted-key JSON used for exact content comparison and size bounds. */
export function canonicalSnapshot(value:unknown):string {
  if(Array.isArray(value))return '['+value.map(canonicalSnapshot).join(',')+']';
  if(value&&typeof value==='object')return '{'+Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>JSON.stringify(key)+':'+canonicalSnapshot(item)).join(',')+'}';
  return JSON.stringify(value)??'null';
}

const CURRENCIES=new Set<string>(['CAD','USD','EUR','GBP','KRW','SAT']);
const METHODS=new Set<string>(PAYMENT_METHOD_IDS);
const SCHEDULES=new Set<string>(['calendar','0','30','60','90','custom']);
const KINDS=new Set<string>(['service','expense']);
const LINE_FIELDS=new Set(['id','description','quantity','price','kind','adjustmentEligible']);
const RULE_FIELDS=new Set(['id','method','discount','premium','basis']);
/** The all-fiat group is a rule target only, never an accepted payment method. */
const RULE_TARGETS=new Set<string>([...PAYMENT_METHOD_IDS,'fiat']);
const RULE_BASES=new Set(['eligible','subtotal']);
const BILLING_FIELDS:{key:string,max:number}[]=[{key:'sellerName',max:120},{key:'sellerEmail',max:254},{key:'sellerAddress',max:1000},{key:'customerAddress',max:1000},{key:'sellerTaxId',max:80}];
const REQUIRED=['version','customerName','customerEmail','title','issueDate','dueDate','currency','tax','discount','premium','note','lines','schedule','customDays','paymentTerms','allMethods','accepted','methodRules','clientId','billing','carriedLineIds'];
const text=(value:unknown,max:number)=>typeof value==='string'&&value.length<=max;
const lineId=(value:unknown)=>typeof value==='string'&&value.length>=1&&value.length<=64;
const numberField=(value:unknown,max=32)=>typeof value==='string'&&value.length<=max;
const optional=(present:boolean,valid:boolean)=>!present||valid;

/**
 * Strict validation of the versioned snapshot. Returns a normalized typed
 * snapshot or a plain error message; used by the server before any write and
 * available to tests so the shape stays bounded and version-checked.
 */
export function validateInvoiceEditorSnapshot(value:unknown):{ok:true;snapshot:InvoiceEditorSnapshot}|{ok:false;error:string}{
  if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,error:'Send a saved invoice draft object.'};
  const raw=value as Record<string,unknown>;
  for(const key of Object.keys(raw))if(raw[key]!==undefined&&key!=='carriedExpenseAck'&&!REQUIRED.includes(key))return {ok:false,error:`Unknown saved-draft field “${key}”.`};
  for(const key of REQUIRED)if(raw[key]===undefined)return {ok:false,error:`Missing saved-draft field “${key}”.`};
  if(raw.version!==1)return {ok:false,error:'This saved draft version is not supported.'};
  if(!text(raw.customerName,120)||!text(raw.customerEmail,254)||!text(raw.title,160)||!text(raw.issueDate,10)||!text(raw.dueDate,10))return {ok:false,error:'The saved draft text fields are out of bounds.'};
  if(typeof raw.currency!=='string'||!CURRENCIES.has(raw.currency))return {ok:false,error:'Choose a supported invoice currency.'};
  if(!numberField(raw.tax)||!numberField(raw.discount)||!numberField(raw.premium)||!numberField(raw.note,2000)||!numberField(raw.paymentTerms,2000)||!numberField(raw.customDays,6)||!numberField(raw.clientId,64))return {ok:false,error:'The saved draft text fields are out of bounds.'};
  if(typeof raw.allMethods!=='boolean')return {ok:false,error:'The accepted-methods choice is invalid.'};
  if(typeof raw.schedule!=='string'||!SCHEDULES.has(raw.schedule))return {ok:false,error:'The payment schedule is invalid.'};
  if(!Array.isArray(raw.lines)||raw.lines.length<1||raw.lines.length>INVOICE_EDITOR_DRAFTS_LIMITS.lines)return {ok:false,error:'A saved draft keeps between 1 and 40 line items.'};
  for(const line of raw.lines){
    if(!line||typeof line!=='object'||Array.isArray(line))return {ok:false,error:'A saved line item is invalid.'};
    const entry=line as Record<string,unknown>;
    for(const key of Object.keys(entry))if(entry[key]!==undefined&&!LINE_FIELDS.has(key))return {ok:false,error:`Unknown saved line field “${key}”.`};
    for(const key of LINE_FIELDS)if(entry[key]===undefined)return {ok:false,error:`Missing saved line field “${key}”.`};
    if(!lineId(entry.id)||!text(entry.description,240)||!numberField(entry.quantity,12)||!numberField(entry.price,32))return {ok:false,error:'A saved line item is out of bounds.'};
    if(typeof entry.kind!=='string'||!KINDS.has(entry.kind))return {ok:false,error:'Choose service or expense for each line.'};
    if(typeof entry.adjustmentEligible!=='boolean')return {ok:false,error:'The discount-eligibility choice is invalid.'};
  }
  if(!Array.isArray(raw.accepted)||raw.accepted.length>INVOICE_EDITOR_DRAFTS_LIMITS.methods||raw.accepted.some(method=>typeof method!=='string'||!METHODS.has(method))||new Set(raw.accepted).size!==raw.accepted.length)return {ok:false,error:'The accepted payment methods are invalid.'};
  if(!Array.isArray(raw.methodRules)||raw.methodRules.length>INVOICE_EDITOR_DRAFTS_LIMITS.rules)return {ok:false,error:'A saved draft keeps at most 8 method price rules.'};
  for(const rule of raw.methodRules){
    if(!rule||typeof rule!=='object'||Array.isArray(rule))return {ok:false,error:'A saved method rule is invalid.'};
    const entry=rule as Record<string,unknown>;
    for(const key of Object.keys(entry))if(entry[key]!==undefined&&!RULE_FIELDS.has(key))return {ok:false,error:`Unknown saved rule field “${key}”.`};
    for(const key of RULE_FIELDS)if(key!=='basis'&&entry[key]===undefined)return {ok:false,error:`Missing saved rule field “${key}”.`};
    if(!lineId(entry.id)||!numberField(entry.discount)||!numberField(entry.premium))return {ok:false,error:'A saved method rule is out of bounds.'};
    if(entry.method!==''&&(typeof entry.method!=='string'||!RULE_TARGETS.has(entry.method)))return {ok:false,error:'Choose a supported payment method or the all-fiat target for each rule.'};
    if(entry.basis!==undefined&&(typeof entry.basis!=='string'||!RULE_BASES.has(entry.basis)))return {ok:false,error:'Choose an eligible or whole-invoice basis for each rule.'};
  }
  if(raw.currency==='SAT'&&raw.methodRules.some(rule=>rule&&typeof rule==='object'&&(rule as Record<string,unknown>).method==='fiat'))return {ok:false,error:'SAT invoices cannot use the all-fiat rule.'};
  if(!raw.billing||typeof raw.billing!=='object'||Array.isArray(raw.billing))return {ok:false,error:'The saved billing details are invalid.'};
  const billing=raw.billing as Record<string,unknown>;
  for(const key of Object.keys(billing))if(billing[key]!==undefined&&!BILLING_FIELDS.some(field=>field.key===key))return {ok:false,error:`Unknown saved billing field “${key}”.`};
  for(const field of BILLING_FIELDS)if(billing[field.key]!==undefined&&!text(billing[field.key],field.max))return {ok:false,error:'The saved billing details are out of bounds.'};
  if(!Array.isArray(raw.carriedLineIds)||raw.carriedLineIds.length>INVOICE_EDITOR_DRAFTS_LIMITS.lines||raw.carriedLineIds.some(id=>!lineId(id))||new Set(raw.carriedLineIds).size!==raw.carriedLineIds.length)return {ok:false,error:'The carried-expense markers are invalid.'};
  if(raw.carriedExpenseAck!==undefined&&(typeof raw.carriedExpenseAck!=='string'||!(/^[0-9a-f]{1,16}$/).test(raw.carriedExpenseAck)))return {ok:false,error:'The expense review record is invalid.'};
  if(canonicalSnapshot(raw).length>INVOICE_EDITOR_DRAFTS_LIMITS.bytes)return {ok:false,error:'This draft is too large to save. Remove unused lines or notes.'};
  return {ok:true,snapshot:raw as unknown as InvoiceEditorSnapshot};
}

/** Summary fields shown in the saved-drafts list without loading full snapshots. */
export function snapshotSummaryFields(snapshot:InvoiceEditorSnapshot):{title:string;customerName:string;currency:Currency}{
  return {title:snapshot.title.trim().slice(0,80)||'Untitled draft',customerName:snapshot.customerName.trim().slice(0,80)||'Unnamed customer',currency:snapshot.currency};
}

/**
 * Change-detection fingerprint over carried expense content (description,
 * quantity, price, kind, eligibility). Editing any carried expense line, or
 * removing one, changes the fingerprint and resets the required review. This is
 * a change detector, not a security boundary.
 */
export function expenseFingerprint(lines:InvoiceEditorLine[]):string{
  const content=lines.map(line=>[line.description,line.quantity,line.price,line.kind,line.adjustmentEligible]);
  const text=canonicalSnapshot(content);
  let hash=5381;
  for(let index=0;index<text.length;index++)hash=((hash*33)^text.charCodeAt(index))>>>0;
  return hash.toString(16).padStart(8,'0');
}
