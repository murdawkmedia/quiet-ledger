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
