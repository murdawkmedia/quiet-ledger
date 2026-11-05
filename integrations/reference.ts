import type {HttpFetch} from './http.js';
const URL='https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';
export type ReferenceRate={pair:'USDCAD';rate:number|null;asOf:string|null;retrievedAt:string;source:'Bank of Canada'|'Unavailable';kind:'reference'|'unavailable';url:string;stale:boolean;error?:string};
let cached:ReferenceRate|undefined;
export function clearReferenceCache(){cached=undefined;}
export async function fetchReferenceRate(options:{fetcher?:HttpFetch;now?:Date}={}):Promise<ReferenceRate>{
  const now=options.now??new Date();
  if(cached&&now.getTime()-Date.parse(cached.retrievedAt)<6*60*60*1000&&now.getTime()>=Date.parse(cached.retrievedAt))return {...cached};
  try{
    const response=await(options.fetcher??fetch)(URL,{signal:AbortSignal.timeout(6500),headers:{'Accept':'application/json'}});
    if(!response.ok)throw new Error('Unavailable');
    const data=await response.json() as {observations?:{d:string;FXUSDCAD?:{v:string}}[]};
    const observation=data.observations?.at(-1),rate=Number(observation?.FXUSDCAD?.v);
    if(!observation||!/^\d{4}-\d{2}-\d{2}$/.test(observation.d)||!Number.isFinite(rate)||rate<=0||rate>100)throw new Error('Invalid reference');
    cached={pair:'USDCAD',rate,asOf:observation.d,retrievedAt:now.toISOString(),source:'Bank of Canada',kind:'reference',url:URL,stale:false};
    return {...cached};
  }catch{
    if(cached)return {...cached,stale:true,error:'Reference feed unavailable; showing the last retrieved observation.'};
    return {pair:'USDCAD',rate:null,asOf:null,retrievedAt:now.toISOString(),source:'Unavailable',kind:'unavailable',url:URL,stale:true,error:'Reference feed unavailable. Simulated payment quotes use their separately labeled demo rate.'};
  }
}
