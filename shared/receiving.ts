import type {MethodId} from './payment-methods.js';
export type AdapterCurrency='CAD'|'USD'|'EUR'|'GBP'|'KRW';
export interface ReceivingContext {
  requestId:string;method:MethodId;amount:number;currency:AdapterCurrency;
  expectedAtomic:string;idempotencyKey:string;createdAt:string;expiresAt:string;
  mode:'live'|'test';
  /** Server-generated customer return link; never accepted from a payer/provider config. */
  returnUrl?:string;
}
export interface ReceivingIntent {
  providerId:string;url?:string;request?:string;network?:string;asset?:string;
  /** Validated mainnet BOLT11 with independent provider verification; guidance only. */
  cashuWalletHandoff?:true;
  /** Provider-validated payment request expiry; may precede the outer receiving window. */
  expiresAt?:string;
  allocationKey?:string;instructions?:{label:string;value:string}[];
  opaque?:Record<string,unknown>;
}
export type ReceivingObservation=
  | {status:'pending'|'review';reason?:string}
  | {status:'paid';paymentId:string;amount:number;currency:AdapterCurrency;reference:string};
export interface ReceivingAdapter {
  id:string;methods:MethodId[];mode:'live'|'test';walletOptionIds?:string[];
  /** Optional pricing currencies this adapter supports; omission leaves validation to the adapter. */
  supportedCurrencies?:AdapterCurrency[];
  /** Local payment rails may support a narrower currency set than their adapter. */
  supportedCurrenciesByMethod?:Partial<Record<MethodId,AdapterCurrency[]>>;
  /** Public provider name only; never a private connection alias or credential. */
  label?:string;
  /** Replay after interruption requires explicit provider idempotency or a side-effect-free operation. */
  creationRetrySafe?:boolean;
  create(context:ReceivingContext):Promise<ReceivingIntent>;
  check(context:ReceivingContext,intent:ReceivingIntent,evidence?:{transactionId?:string}):Promise<ReceivingObservation>;
  recover?(context:ReceivingContext):Promise<ReceivingIntent>;
}
export interface ReceivingRecord {
  id:string;token:string;invoiceId:string;invoiceNumber:string;method:MethodId;adapterId:string;
  mode:'live'|'test';status:'creation_pending'|'awaiting_payment'|'paid';
  amount:number;currency:AdapterCurrency;expectedAtomic:string;createdAt:string;expiresAt:string;
  intent?:ReceivingIntent;receipt?:{number:string;mode:'live'|'test';method:MethodId;amount:number;currency:AdapterCurrency;verifiedAt:string};
  creationUncertain?:boolean;reviewReason?:string;
}

export function receivingRequestExpiry(request:Pick<ReceivingRecord,'expiresAt'|'intent'>){
  return Math.min(Date.parse(request.expiresAt),Date.parse(request.intent?.expiresAt??request.expiresAt));
}

/** Intersect provider-wide and payment-method currency constraints before allocation. */
export function receivingAdapterSupportsCurrency(adapter:{supportedCurrencies?:readonly string[];supportedCurrenciesByMethod?:Partial<Record<MethodId,readonly string[]>>},currency:string,method:string){
 const currencies=adapter.supportedCurrenciesByMethod?.[method as MethodId];
 return (!adapter.supportedCurrencies||adapter.supportedCurrencies.includes(currency))&&(!currencies||currencies.includes(currency));
}
export const MANUAL_RAIL_CURRENCIES:Partial<Record<MethodId,AdapterCurrency[]>>={interac:['CAD'],ach:['USD'],sepa:['EUR']};
