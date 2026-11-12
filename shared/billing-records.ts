import {z} from 'zod';
import type {Currency} from './contracts.js';
import type {InvoiceBalance} from './invoice-ledger.js';

/** Persistent owner planning bounds; the router fails closed with 429 and never evicts. */
export const BILLING_LIMITS={projectsPerWorkspace:100,milestonesPerWorkspace:500,deliverablesPerInvoice:20,deliverablesPerWorkspace:1000} as const;
export const BILLING_LABEL_MAX=240;
export const BILLING_URL_MAX=2000;

/**
 * Owner-supplied delivery destinations. Quiet Ledger never fetches, proxies, iframes
 * or renders them; they are only displayed as plain links after the paid gate opens.
 * https-only, parseable host, no userinfo, no control characters, bounded length.
 */
export function deliverableUrlIssue(value:string):string|undefined{
  const trimmed=value.trim();
  if(!trimmed)return 'A delivery link is required.';
  if(trimmed.length>BILLING_URL_MAX)return `Delivery links are limited to ${BILLING_URL_MAX} characters.`;
  if(/[\u0000-\u001f\u007f]/.test(trimmed))return 'Delivery links cannot contain control characters.';
  let parsed:URL;
  try{parsed=new URL(trimmed);}catch{return 'Enter a valid https:// delivery link.';}
  if(parsed.protocol!=='https:')return 'Only https:// delivery links are accepted.';
  if(!parsed.hostname)return 'The delivery link needs a valid host.';
  if(parsed.username||parsed.password)return 'Delivery links cannot contain user credentials.';
  return undefined;
}

const labelSchema=z.string().trim().min(1).max(BILLING_LABEL_MAX).refine(value=>!/[\u0000-\u001f\u007f]/.test(value),'Use plain text without control characters.');
const urlSchema=z.string().trim().min(1).max(BILLING_URL_MAX).refine(value=>deliverableUrlIssue(value)===undefined,'Enter a valid https:// delivery link without credentials.');
/** Same integer minor-unit bounds as invoice amounts; planned values never gate anything. */
const plannedAmountSchema=z.number().int().min(1).max(1_000_000_000);
const currencySchema=z.enum(['CAD','USD','KRW','EUR','GBP','SAT']);

export const createProjectSchema=z.object({name:labelSchema}).strict();
export const renameProjectSchema=createProjectSchema;
export const createMilestoneSchema=z.object({label:labelSchema,amount:plannedAmountSchema,currency:currencySchema,projectId:z.string().uuid().optional(),invoiceId:z.string().uuid().optional()}).strict();
export const updateMilestoneSchema=z.object({label:labelSchema.optional(),invoiceId:z.string().uuid().nullable().optional()}).strict();
export const createDeliverableSchema=z.object({invoiceId:z.string().uuid(),label:labelSchema,url:urlSchema}).strict();
export const updateDeliverableSchema=z.object({label:labelSchema.optional(),url:urlSchema.optional()}).strict().refine(value=>value.label!==undefined||value.url!==undefined,'Choose a new label or delivery link.');
export const emptyActionSchema=z.object({}).strict();

/** Authoritative invoice facts read live from the ledger; planned amounts never override these. */
export interface BillingInvoiceSummary {
  id:string;number:string;currency:Currency;total:number;effectiveTotal:number;paid:number;due:number;
  state:InvoiceBalance['state'];mode:InvoiceBalance['mode'];priceAgreementId?:string;
}
export interface BillingDeliverableView {
  id:string;invoiceId:string;invoiceNumber?:string;label:string;released:boolean;releaseReady:boolean;
  createdAt:string;updatedAt:string;
}
export interface BillingMilestoneView {
  id:string;projectId:string|null;label:string;amount:number;currency:Currency;
  createdAt:string;updatedAt:string;invoice?:BillingInvoiceSummary;deliverables:BillingDeliverableView[];
}
export interface BillingProjectView {id:string;name:string;createdAt:string;milestones:BillingMilestoneView[]}
/** Owner browser projection of the whole planning surface. */
export interface BillingOverview {projects:BillingProjectView[];looseMilestones:BillingMilestoneView[];deliverables:BillingDeliverableView[]}
/** The only payer-visible projection: label and URL, nothing else. */
export interface PublicDeliverable {label:string;url:string}
