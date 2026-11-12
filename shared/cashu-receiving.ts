/**
 * Pure Cashu intake decision contract (v1), shared by server and client.
 *
 * A decision classifies one Cashu journal operation against one frozen
 * application binding plus facts read through the trusted journal. It is pure
 * data: `accepted_locked` only means the operation matches its binding
 * exactly enough for the authorized internal intake service to consider a
 * single ledger allocation. No classification ever states that an invoice is
 * paid, and no decision grants checkout, receipt, refund or owner capability.
 * Allocation itself is a separate server-only action inside one application
 * transaction, and only the trusted journal reader may supply the facts.
 */

/** The three intake outcomes. None of them implies paid. */
export type CashuIntakeClassification='accepted_locked'|'rejected'|'unknown';

export const CASHU_INTAKE_CLASSIFICATIONS=['accepted_locked','rejected','unknown'] as const;

/** Why a decision was reached. Stable ids only; never payer or proof data. */
export type CashuIntakeReason=
  |'unbound_operation'
  |'operation_missing'
  |'not_finalized'
  |'result_missing'
  |'outbox_missing'
  |'outbox_result_mismatch'
  |'operation_mismatch'
  |'mint_mismatch'
  |'unit_mismatch'
  |'keyset_mismatch'
  |'unsafe_amount'
  |'net_amount_mismatch'
  |'fee_exceeds_maximum'
  |'currency_not_sat'
  |'method_denied'
  |'agreement_mismatch'
  |'invoice_not_payable'
  |'invoice_missing'
  |'invalid_invoice_facts'
  |'invoice_mismatch'
  |'invalid_binding';

/** The frozen application binding created before any mint effect. */
export interface CashuIntakeBindingFacts{
  /** Stable identity of the trusted journal instance this binding belongs to. */
  journalAlias:string;
  operationId:string;
  workspace:string;
  invoiceId:string;
  /** This contract covers native Cashu settlement only. */
  method:'cashu';
  /** Canonical https mint URL frozen at binding time. */
  mint:string;
  /** Cashu unit; this boundary accepts whole-satoshi `sat` only. */
  unit:string;
  keysetId:string;
  /** Whole satoshis the invoice may credit for this operation; decimal integer string. */
  netAmount:string;
  /** Maximum whole-satoshi mint fee accepted for this operation; decimal integer string. */
  maxFee:string;
  /** Exact saved method agreement id, when the invoice is method-priced. */
  agreementId?:string;
}

/** Finalized result facts as read from the trusted journal. No proofs. */
export interface CashuIntakeResultFacts{
  operationId:string;
  invoiceId:string;
  mint:string;
  unit:string;
  keysetId:string;
  amount:string;
  fee:string;
  proofCount:number;
}

/** Pending outbox event facts as read from the trusted journal. No proofs. */
export interface CashuIntakeOutboxFacts{
  operationId:string;
  invoiceId:string;
  mint:string;
  unit:string;
  amount:string;
  fee:string;
  proofCount:number;
}

/** Journal facts. `result`/`outboxEvent` are absent when the journal has none. */
export interface CashuIntakeJournalFacts{
  state:'prepared'|'uncertain'|'finalized'|'missing';
  result:CashuIntakeResultFacts|null;
  outboxEvent:CashuIntakeOutboxFacts|null;
}

/** Invoice facts gathered by the service at classification time. */
export interface CashuIntakeInvoiceFacts{
  currency:string;
  /** Whether the invoice accepts native Cashu settlement right now. */
  allowsCashu:boolean;
  /** Current unpaid whole-satoshi balance; decimal integer string. */
  dueSats:string;
  /** The invoice's one locked method agreement, when method-priced. */
  agreement:{id:string;method:string}|null;
}

export interface CashuIntakeDecision{
  classification:CashuIntakeClassification;
  reasons:CashuIntakeReason[];
}

/** Whole-satoshi text: nonnegative decimal integer within safe precision. */
export function parseSatoshiText(value:string):bigint|null{
  if(typeof value!=='string'||!/^(?:0|[1-9][0-9]{0,15})$/.test(value))return null;
  const amount=BigInt(value);
  return amount<=BigInt(Number.MAX_SAFE_INTEGER)?amount:null;
}

/**
 * Classify one operation against its binding. Unknown means the journal could
 * not authenticate a complete finalized picture (uncertain, missing result or
 * missing outbox); rejected means a definitive mismatch with the frozen
 * binding or the invoice rules. Both stay uncredited and unacknowledged.
 */
export function classifyCashuIntake(
  binding:CashuIntakeBindingFacts,
  journal:CashuIntakeJournalFacts,
  invoice:CashuIntakeInvoiceFacts,
):CashuIntakeDecision{
  if(!invoice)return{classification:'unknown',reasons:['invoice_missing']};
  if(parseSatoshiText(invoice.dueSats)===null||typeof invoice.allowsCashu!=='boolean')return{classification:'unknown',reasons:['invalid_invoice_facts']};
  if(binding.method!=='cashu'||binding.unit!=='sat'||parseSatoshiText(binding.netAmount)===null||parseSatoshiText(binding.netAmount)===0n||parseSatoshiText(binding.maxFee)===null)return{classification:'rejected',reasons:['invalid_binding']};
  if(journal.state!=='finalized')return{classification:'unknown',reasons:['not_finalized']};
  const result=journal.result;
  if(!result)return{classification:'unknown',reasons:['result_missing']};
  const outbox=journal.outboxEvent;
  if(!outbox)return{classification:'unknown',reasons:['outbox_missing']};
  // The outbox event must authenticate the result it belongs to.
  if(outbox.operationId!==result.operationId||outbox.invoiceId!==result.invoiceId
    ||outbox.mint!==result.mint||outbox.unit!==result.unit
    ||outbox.amount!==result.amount||outbox.fee!==result.fee
    ||outbox.proofCount!==result.proofCount)return{classification:'unknown',reasons:['outbox_result_mismatch']};
  const reasons:CashuIntakeReason[]=[];
  if(result.operationId!==binding.operationId)reasons.push('operation_mismatch');
  if(result.invoiceId!==binding.invoiceId)reasons.push('invoice_mismatch');
  if(result.mint!==binding.mint)reasons.push('mint_mismatch');
  if(result.unit!==binding.unit)reasons.push('unit_mismatch');
  if(result.keysetId!==binding.keysetId)reasons.push('keyset_mismatch');
  const net=parseSatoshiText(result.amount),boundNet=parseSatoshiText(binding.netAmount);
  if(net===null||boundNet===null)reasons.push('unsafe_amount');
  else if(net!==boundNet)reasons.push('net_amount_mismatch');
  const fee=parseSatoshiText(result.fee),maxFee=parseSatoshiText(binding.maxFee);
  if(fee===null||maxFee===null)reasons.push('unsafe_amount');
  else if(fee>maxFee)reasons.push('fee_exceeds_maximum');
  if(invoice){
    if(invoice.currency!=='SAT')reasons.push('currency_not_sat');
    if(!invoice.allowsCashu)reasons.push('method_denied');
    // A priced invoice must still hold the exact agreement bound before the
    // effect; an invoice that gained or changed a lock since stays refused.
    if(binding.agreementId!==undefined){
      if(!invoice.agreement||invoice.agreement.id!==binding.agreementId||invoice.agreement.method!==binding.method)reasons.push('agreement_mismatch');
    }else if(invoice.agreement)reasons.push('agreement_mismatch');
    // Payability is only decided for the exact bound amount: an unsafe or
    // binding-mismatched result amount is already rejected above, and must
    // not double as an invoice-balance verdict.
    const due=parseSatoshiText(invoice.dueSats);
    if(net!==null&&net===boundNet&&due!==null&&net>due)reasons.push('invoice_not_payable');
  }
  return reasons.length?{classification:'rejected',reasons}:{classification:'accepted_locked',reasons:[]};
}
