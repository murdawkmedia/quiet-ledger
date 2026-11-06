let csrfToken = '';
export function setCsrf(value?:string) { csrfToken = value ?? ''; }
export class ApiError extends Error { constructor(message:string,public status:number,public code?:string) { super(message); } }
export async function api<T>(path:string, options:RequestInit = {}):Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type','application/json');
  if (options.method && !['GET','HEAD'].includes(options.method.toUpperCase()) && csrfToken) headers.set('X-CSRF-Token',csrfToken);
  const response = await fetch(path,{...options,headers,credentials:'same-origin'});
  const contentType = response.headers.get('content-type') ?? '';
  const result = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new ApiError(result?.error || `Request could not be completed (${response.status}).`,response.status,result?.code);
  return result as T;
}
export const post = <T,>(path:string,body?:unknown,key?:string) => api<T>(path,{method:'POST',body:body===undefined?undefined:JSON.stringify(body),headers:key?{'Idempotency-Key':key}:undefined});
export const actionKey = () => crypto.randomUUID();
export function money(value:number,currency='CAD') { return new Intl.NumberFormat('en-CA',{style:'currency',currency}).format((Number.isFinite(value)?value:0)/(currency==='KRW'?1:100)); }
export function date(value?:string) { return value ? new Intl.DateTimeFormat('en-CA',{month:'short',day:'numeric',year:'numeric'}).format(new Date(/^\d{4}-\d{2}-\d{2}$/.test(value)?value+'T12:00:00':value)) : '—'; }
export function cents(value:string) { if(!/^\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error('Enter an amount with up to two decimal places.'); const amount=Math.round(Number(value)*100); if(!Number.isSafeInteger(amount)||amount<=0) throw new Error('Enter a positive amount.'); return amount; }
export function downloadJson(value:unknown,filename:string) { const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'})); const a=document.createElement('a');a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
export function methodLabel(method?:string) { return method==='square'?'Card · Square':method==='bank_transfer'?'Bank transfer':METHOD_DEFINITIONS.find(row=>row.id===method)?.label??(method?'Unrecognized payment method':'Awaiting payment'); }
export function providerLabel(provider:string) { return ({bullbitcoin:'Bull Bitcoin',bitcoinwell:'Bitcoin Well',wise:'Wise Business'} as Record<string,string>)[provider]??provider; }
import { METHOD_DEFINITIONS } from '../shared/payment-methods';
