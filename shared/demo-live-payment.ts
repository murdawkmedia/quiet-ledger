import type {ReceivingRecord} from './receiving.js';

/**
 * Public, sanitized per-visit real-payment sample. Only these fields ever cross
 * the API: no provider token, invoice number, adapter configuration, quote or
 * opaque context, and no client-supplied amount, receiver or workspace.
 */
export interface DemoLiveRequest {
  id:string;
  status:'creation_pending'|'awaiting_payment'|'paid';
  mode:'live';
  method:'lightning';
  amount:number;
  currency:'SAT';
  expectedAtomic:string;
  createdAt:string;
  expiresAt:string;
  intent?:{request:string;network:string;asset:string;expiresAt?:string;cashuWalletHandoff?:true};
  receipt?:{number:string;mode:'live'|'test';method:string;amount:number;currency:string;verifiedAt:string};
  reviewReason?:string;
  creationUncertain?:boolean;
}

export interface DemoLivePaymentView {
  enabled:boolean;
  receiver:string;
  amountSats:21;
  rail:'lightning';
  request?:DemoLiveRequest;
}

/** Structural subset a receiving view satisfies; invoiceId/quote/token stay optional. */
export type DemoLiveRequestSource=Pick<ReceivingRecord,'id'|'status'|'mode'|'method'|'amount'|'currency'|'expectedAtomic'|'createdAt'|'expiresAt'>
  &{intent?:ReceivingRecord['intent'];receipt?:ReceivingRecord['receipt'];reviewReason?:string;creationUncertain?:boolean};

/** Project a receiving record onto the strict public demo shape; unknown extras are dropped. */
export function sanitizeDemoLiveRequest(record:DemoLiveRequestSource|DemoLiveRequest):DemoLiveRequest {
  const invalid=()=>{throw new Error('The saved real-payment sample requires review.');};
  const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
  const date=(value:unknown)=>typeof value==='string'&&Number.isFinite(Date.parse(value));
  if(!record||record.mode!=='live'||record.method!=='lightning'||record.currency!=='SAT'||record.amount!==21||record.expectedAtomic!=='21'
    ||!text(record.id,128)||!['creation_pending','awaiting_payment','paid'].includes(record.status)
    ||!date(record.createdAt)||!date(record.expiresAt)||Date.parse(record.expiresAt)<=Date.parse(record.createdAt)
    ||(record.reviewReason!==undefined&&!text(record.reviewReason,4096))
    ||(record.creationUncertain!==undefined&&typeof record.creationUncertain!=='boolean'))return invalid();
  const intent=record.intent;
  if(intent&&(intent.network!=='mainnet'||intent.asset!=='BTC'||!/^lightning:lnbc[0-9a-z]{1,8192}$/.test(intent.request??'')
    ||(intent.expiresAt!==undefined&&(!date(intent.expiresAt)||Date.parse(intent.expiresAt)<=Date.parse(record.createdAt)||Date.parse(intent.expiresAt)>Date.parse(record.expiresAt)))))return invalid();
  if(record.status==='creation_pending'?Boolean(intent):!intent)return invalid();
  const receipt=record.receipt;
  if(record.status==='paid'){
    if(!receipt||receipt.number!==`PAY-${record.id}`||receipt.mode!=='live'||receipt.method!=='lightning'||receipt.amount!==21||receipt.currency!=='SAT'
      ||!date(receipt.verifiedAt)||Date.parse(receipt.verifiedAt)<Date.parse(record.createdAt)
      ||Date.parse(receipt.verifiedAt)>Math.min(Date.parse(record.expiresAt),Date.parse(intent?.expiresAt??record.expiresAt))
      ||record.creationUncertain||record.reviewReason)return invalid();
  }else if(receipt)return invalid();
  return {
    id:record.id,
    status:record.status,
    mode:record.mode,
    method:record.method,
    amount:record.amount,
    currency:'SAT',
    expectedAtomic:record.expectedAtomic,
    createdAt:record.createdAt,
    expiresAt:record.expiresAt,
    ...(intent?{intent:{
      request:intent.request??'',
      network:intent.network??'',
      asset:intent.asset??'',
      ...(intent.expiresAt?{expiresAt:intent.expiresAt}:{}),
      ...(intent.cashuWalletHandoff===true?{cashuWalletHandoff:true as const}:{}),
    }}:{}),
    ...(record.receipt?{receipt:{
      number:record.receipt.number,mode:record.receipt.mode,method:record.receipt.method,
      amount:record.receipt.amount,currency:record.receipt.currency,verifiedAt:record.receipt.verifiedAt,
    }}:{}),
    ...(record.reviewReason?{reviewReason:record.reviewReason}:{}),
    ...(record.creationUncertain?{creationUncertain:true}:{}),
  };
}
