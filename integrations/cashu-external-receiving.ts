import type {ReceivingAdapter,ReceivingContext,ReceivingIntent,ReceivingObservation} from '../shared/receiving.js';

/**
 * External-wallet manual Cashu receiving (fixture-tested only).
 *
 * Real ecash is received in the owner's existing
 * external wallet (Minibits, Zeus or another compatible wallet) on one
 * explicitly approved mint. This app never generates a wallet secret, never
 * stores or ingests cashuA/cashuB proofs, never connects a private wallet and
 * never redeems, swaps, mints or melts ecash. The adapter performs zero
 * transport calls: saving, checking and creating a receiving request are all
 * offline manual information, and the owner's explicit manual confirmation is
 * the only path to a receipt.
 */

/** The only mints selectable for external-wallet manual receiving. */
export const CASHU_EXTERNAL_MINTS=['https://mint.minibits.cash/Bitcoin','https://mint.coinos.io'] as const;
export type CashuExternalMint=typeof CASHU_EXTERNAL_MINTS[number];
/** Wallet labels the owner can declare for the outside transfer channel. */
export const CASHU_EXTERNAL_WALLET_LABELS=['Minibits','Zeus','Other compatible Cashu wallet'] as const;
export type CashuExternalWalletLabel=typeof CASHU_EXTERNAL_WALLET_LABELS[number];
/**
 * Where the receiving wallet runs. Both choices use the exact same honest
 * manual receiving/confirmation flow; the label is public configuration with
 * an explicit verification level, never an automatic paid flag. A self-hosted
 * selection never implies a qualified automatic receiver, and running your own
 * mint URL remains a separately named future capability.
 */
export const CASHU_EXTERNAL_HOSTING_LABELS=['Self-hosted wallet (user-run)','Third-party wallet'] as const;
export type CashuExternalHosting=typeof CASHU_EXTERNAL_HOSTING_LABELS[number];

const SECRET_SHAPED=[
  // Bearer ecash token URIs (cashuA…/cashuB… proofs) in any casing.
  /[Cc]ashu[AB][A-Za-z0-9_-]{15,}/,
  // Nostr private keys.
  /\b(?:nsec1|npriv1)[a-z0-9]{20,}/,
  // HD wallet seeds / extended private keys.
  /\b(?:xprv|tprv|zprv|yprv|uprv)[1-9A-HJ-NP-Za-km-z]{20,}/,
  // PEM private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  // Long hex blobs: proof-secret/blinding-factor/key material shape.
  /[0-9a-fA-F]{64,}/,
];

/**
 * True when a value looks like a bearer Cashu token or another wallet secret.
 * Every saved external-wallet field and every supplied reference is checked
 * with this; keys, proofs and seeds are refused, never stored.
 */
export function isCashuSecretShaped(value:string):boolean{
  return typeof value==='string'&&SECRET_SHAPED.some(pattern=>pattern.test(value));
}

export interface CashuExternalReceivingConfig {
  /** Saved connection id; becomes the receiving adapter id. */
  id:string;
  /** External-wallet manual receiving is live SAT only. */
  mode:'live';
  walletLabel:CashuExternalWalletLabel;
  mint:CashuExternalMint;
  /** Public custody label: where the receiving wallet runs. */
  hosting:CashuExternalHosting;
  /** Nonsecret description of the owner's existing outside-wallet transfer channel. */
  instructions:string;
}

const invalid=()=>new Error('Invalid external Cashu wallet receiving settings.');

export function createCashuExternalReceivingAdapter(config:CashuExternalReceivingConfig):ReceivingAdapter{
  if(!config||typeof config!=='object')throw invalid();
  const {id,mode,walletLabel,mint,hosting,instructions}=config;
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,80}$/.test(id))throw invalid();
  if(mode!=='live')throw invalid();
  if(!CASHU_EXTERNAL_WALLET_LABELS.includes(walletLabel))throw invalid();
  if(!CASHU_EXTERNAL_MINTS.includes(mint))throw invalid();
  if(!CASHU_EXTERNAL_HOSTING_LABELS.includes(hosting))throw invalid();
  if(typeof instructions!=='string'||!instructions.trim()||instructions.length>8000||isCashuSecretShaped(instructions))throw invalid();
  return {
    id,mode,methods:['cashu'],walletOptionIds:['cashu'],
    // SAT invoices only: exact whole-satoshi amounts, no fiat conversion.
    supportedCurrencies:['SAT'],
    // Pure local instruction construction: replaying after interruption is safe.
    creationRetrySafe:true,
    async create(context:ReceivingContext):Promise<ReceivingIntent>{
      if(context.mode!=='live'||context.method!=='cashu')throw invalid();
      if(context.currency!=='SAT')throw invalid();
      if(!Number.isSafeInteger(context.amount)||context.amount<=0)throw invalid();
      // The required net sat-ecash value equals the exact invoice amount; no FX.
      if(context.expectedAtomic!==String(context.amount))throw invalid();
      const created=Date.parse(context.createdAt),expires=Date.parse(context.expiresAt);
      if(!Number.isFinite(created)||!Number.isFinite(expires)||expires<=created)throw invalid();
      // Each receiving request gets its own invoice-bound allocation/reference.
      // The saved connection is reusable; the reference never is.
      const reference=`cashu-external:${context.requestId}`;
      return {
        providerId:context.requestId,asset:'BTC',network:`cashu-external (${hosting})`,allocationKey:reference,
        instructions:[
          {label:'Mint (send on this exact mint only)',value:mint},
          {label:'Merchant wallet',value:walletLabel},
          {label:'Wallet hosting',value:`${hosting} · verification level: manual owner confirmation in the merchant's own wallet. Never an automated mint check.`},
          {label:'Net amount to receive',value:`${context.amount.toLocaleString('en-US')} sats net of fees on the mint above`},
          {label:'Fees',value:'Your wallet or mint may charge send or swap fees. Cover them yourself: the merchant must receive the exact net sats shown above.'},
          {label:'How to transfer',value:instructions},
          {label:'Payment reference',value:reference},
          {label:'Confirmation',value:'The merchant imports the received ecash into their own external wallet and verifies it is spendable there, then confirms receipt in Quiet Ledger. Checking or reporting here never credits the invoice; this is not automated mint verification.'},
        ],
      };
    },
    async check(_context:ReceivingContext,intent:ReceivingIntent,evidence?:{transactionId?:string}):Promise<ReceivingObservation>{
      if(intent&&typeof intent==='object'&&Object.values(intent).some(value=>typeof value==='string'&&isCashuSecretShaped(value)))throw invalid();
      if(evidence?.transactionId!==undefined&&(typeof evidence.transactionId!=='string'||isCashuSecretShaped(evidence.transactionId)))throw invalid();
      // Always review: payer action or evidence alone never credits an invoice.
      return {status:'review',reason:'The merchant must import and verify the received ecash in their external wallet, then confirm it manually. No mint is contacted.'};
    },
  };
}
