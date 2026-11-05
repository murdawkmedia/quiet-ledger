export const METHOD_DEFINITIONS = [
  {id:'bitcoin',label:'Bitcoin',zaprite:'BITCOIN',family:'bitcoin',settlement:'bitcoin'},
  {id:'liquid',label:'Liquid · L-BTC',zaprite:'LIQUID',family:'bitcoin',settlement:'bitcoin'},
  {id:'lightning',label:'Lightning',zaprite:'LIGHTNING',family:'bitcoin',settlement:'bitcoin'},
  {id:'bank',label:'Bank transfer',zaprite:'BANK',family:'manual',settlement:'fiat'},
  {id:'card',label:'Card',zaprite:'CARD',family:'fiat',settlement:'fiat'},
  {id:'cash',label:'Cash',zaprite:'CASH',family:'manual',settlement:'fiat'},
  {id:'check',label:'Check / cheque',zaprite:'CHECK',family:'manual',settlement:'fiat'},
  {id:'gift_card',label:'Gift card',zaprite:'GIFTCARD',family:'adjustment',settlement:'noncash'},
  {id:'coupon',label:'Coupon',zaprite:'COUPON',family:'adjustment',settlement:'noncash'},
  {id:'apple_pay',label:'Apple Pay',zaprite:'APPLEPAY',family:'fiat',settlement:'fiat'},
  {id:'google_pay',label:'Google Pay',zaprite:'GOOGLEPAY',family:'fiat',settlement:'fiat'},
  {id:'cash_app_pay',label:'Cash App Pay',zaprite:'CASHAPP_PAY',family:'fiat',settlement:'fiat'},
  {id:'interac',label:'Interac e-Transfer',zaprite:'INTERAC',family:'manual',settlement:'fiat'},
  {id:'ach',label:'ACH',zaprite:'ACH',family:'manual',settlement:'fiat'},
  {id:'sepa',label:'SEPA',zaprite:'SEPA',family:'manual',settlement:'fiat'},
  {id:'wire',label:'Wire transfer',zaprite:'WIRE_TRANSFER',family:'manual',settlement:'fiat'},
  {id:'venmo',label:'Venmo',zaprite:'VENMO',family:'fiat',settlement:'fiat'},
  {id:'paypal',label:'PayPal',zaprite:'PAYPAL',family:'fiat',settlement:'fiat'},
  {id:'revolut_pay',label:'Revolut Pay',zaprite:'REVOLUT_PAY',family:'fiat',settlement:'fiat'},
  {id:'no_charge',label:'No charge / write-off',zaprite:'NO_CHARGE',family:'adjustment',settlement:'noncash'},
  {id:'usdt',label:'Tether · USDT',zaprite:'TETHER',family:'stablecoin',settlement:'stablecoin'},
  {id:'usdc',label:'USD Coin · USDC',zaprite:'USDCIRCLE',family:'stablecoin',settlement:'stablecoin'},
  {id:'ideal',label:'iDEAL',zaprite:null,family:'fiat',settlement:'fiat'},
  {id:'pay_by_bank',label:'Pay by Bank',zaprite:null,family:'fiat',settlement:'fiat'},
  {id:'stripe_dynamic',label:'Other eligible Stripe methods',zaprite:null,family:'fiat',settlement:'fiat'},
  {id:'cashu',label:'Cashu ecash',zaprite:null,family:'bitcoin',settlement:'bitcoin'},
  {id:'ark',label:'Ark · Bark',zaprite:null,family:'bitcoin',settlement:'bitcoin'},
] as const;
export type MethodId = typeof METHOD_DEFINITIONS[number]['id'];
export type PaymentMethod = MethodId | 'square' | 'bank_transfer';
export const PAYMENT_METHOD_IDS: PaymentMethod[] = [...METHOD_DEFINITIONS.map(method=>method.id),'square','bank_transfer'];
export function methodInfo(method:PaymentMethod){return METHOD_DEFINITIONS.find(row=>row.id===(method==='square'?'card':method==='bank_transfer'?'bank':method))!;}
export const isCryptoMethod=(method:PaymentMethod)=>['bitcoin','stablecoin'].includes(methodInfo(method).settlement);
export const canFundPayout=(method?:PaymentMethod)=>Boolean(method&&['bitcoin','fiat'].includes(methodInfo(method).settlement));
export const receivedValue=(method:PaymentMethod,amount:number)=>methodInfo(method).settlement==='noncash'?0:amount;
