export type HttpFetch = (url:string,init?:RequestInit)=>Promise<Response>;
export function minorAmount(value:number):void {
  if(!Number.isSafeInteger(value)||value<=0||value>1_000_000_000_000) throw new Error('Amount must be a positive integer in minor units.');
}
export function bounded(value:string,name:string,max=192):void {
  if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(`Invalid ${name}.`);
}
export async function providerJson(fetcher:HttpFetch,url:string,init:RequestInit,provider:string):Promise<any>{
  let response:Response;
  try{response=await fetcher(url,{...init,signal:AbortSignal.timeout(10_000),redirect:'error'});}
  catch{throw new Error(`${provider} request unavailable; reconcile the existing request before retrying.`);}
  if(!response.ok)throw new Error(`${provider} rejected the request (HTTP ${response.status}).`);
  try{return await response.json();}catch{throw new Error(`${provider} returned an invalid response.`);}
}
