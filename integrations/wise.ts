import {bounded,minorAmount,providerJson,type HttpFetch} from './http.js';
const BASE='https://api.wise-sandbox.com/2026Q4';
type FundingOrigin='ordinary_fiat'|'crypto';
function eligible(origin:FundingOrigin){if(origin!=='ordinary_fiat')throw new Error('Wise is restricted here to ordinary business fiat; crypto-origin payouts require separate route eligibility.');}
function validTransfer(value:any,profileId:number){
  if(!value||!Number.isSafeInteger(value.id)||value.id<=0||typeof value.status!=='string'||!value.status.trim()||value.status.length>100||value.business!==profileId)throw new Error('Wise transfer response is incomplete or belongs to a different business.');
}
export function createWiseSandboxClient(options:{token:string;profileId:number;fetcher?:HttpFetch}){
  bounded(options.token,'Wise sandbox credential',4096);
  if(!Number.isSafeInteger(options.profileId)||options.profileId<=0)throw new Error('A Wise business profile id is required.');
  const fetcher=options.fetcher??fetch;
  const headers={'Authorization':`Bearer ${options.token}`,'Content-Type':'application/json'};
  return {
    async createQuote(input:{amountMinor:number;sourceCurrency:'CAD'|'USD';targetCurrency:'CAD'|'USD';fundingOrigin:FundingOrigin}){
      eligible(input.fundingOrigin);minorAmount(input.amountMinor);
      if(!['CAD','USD'].includes(input.sourceCurrency)||!['CAD','USD'].includes(input.targetCurrency))throw new Error('Unsupported Wise currency.');
      const q=await providerJson(fetcher,`${BASE}/profiles/${options.profileId}/quotes`,{method:'POST',headers,body:JSON.stringify({sourceCurrency:input.sourceCurrency,targetCurrency:input.targetCurrency,sourceAmount:input.amountMinor/100,payOut:'BANK_TRANSFER',preferredPayIn:'BALANCE'})},'Wise');
      if(!q||q.sourceCurrency!==input.sourceCurrency||q.targetCurrency!==input.targetCurrency||q.sourceAmount!==input.amountMinor/100||typeof q.targetAmount!=='number'||!Number.isFinite(q.targetAmount)||q.targetAmount<=0)throw new Error('Wise quote response does not match the requested currencies and amount.');
      bounded(q.id,'Wise quote id',100);
      return q as {id:string;[key:string]:unknown};
    },
    async createTransfer(input:{recipientId:number;quoteId:string;customerTransactionId:string;reference:string;fundingOrigin:FundingOrigin}){
      eligible(input.fundingOrigin);bounded(input.quoteId,'quote id',100);bounded(input.reference,'payment reference',100);
      if(!Number.isSafeInteger(input.recipientId)||input.recipientId<=0)throw new Error('Select a verified Wise recipient.');
      if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.customerTransactionId))throw new Error('A stable UUID is required for Wise transfer idempotency.');
      const result=await providerJson(fetcher,`${BASE}/transfers`,{method:'POST',headers,body:JSON.stringify({targetAccount:input.recipientId,quoteUuid:input.quoteId,customerTransactionId:input.customerTransactionId,details:{reference:input.reference}})},'Wise');
      validTransfer(result,options.profileId);
      if(result.targetAccount!==input.recipientId||result.quoteUuid!==input.quoteId||result.customerTransactionId!==input.customerTransactionId||result.details?.reference!==input.reference)throw new Error('Wise transfer response does not match the prepared request.');
      return result as {id:number;status:string;[key:string]:unknown};
    },
    async getTransfer(id:number){
      if(!Number.isSafeInteger(id)||id<=0)throw new Error('Invalid Wise transfer id.');
      const result=await providerJson(fetcher,`${BASE}/transfers/${id}`,{method:'GET',headers},'Wise');
      validTransfer(result,options.profileId);
      if(result.id!==id)throw new Error('Wise transfer response does not match the requested transfer.');
      return result;
    },
  };
}
