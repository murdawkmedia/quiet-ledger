import React from 'react';
import {createRoot} from 'react-dom/client';
import {CashuInlinePayment} from '../../client/CashuInlinePayment';
import * as journal from '../../client/cashu-melt-store';
const invoice='lightning:lnbc210n1fictional',tokenMarker='cashuA_fictional_bearer_only';
const prepared={id:'fictional-operation',mint:'https://mint.minibits.cash/Bitcoin',invoice,paymentHash:'a'.repeat(64),invoiceSats:21,inputSats:32,inputFeeSats:0,feeReserveSats:2,maxDebitSats:23,expiresAt:Date.now()+600000,inputTags:['b'.repeat(64)],private:{quote:{quote:'fictional-quote'},inputs:[{secret:tokenMarker}],outputData:[{secret:'fictional-output-secret'}],keysets:[]}};
const calls=()=>JSON.parse(localStorage.getItem('fictional-counts')||'{"prepare":0,"execute":0,"recover":0,"settled":0}');
function count(k:string){const n=calls();n[k]++;localStorage.setItem('fictional-counts',JSON.stringify(n));}
const fixture={invoiceCashuAmount:()=>{if(new URLSearchParams(location.search).has('expired'))throw new Error('fictional expiry');return {invoiceSats:21,paymentHash:prepared.paymentHash,expiresAt:prepared.expiresAt};},prepareCashuMelt:async()=>{count('prepare');return new URLSearchParams(location.search).has('unsafe')?{...prepared,maxDebitSats:1000}:prepared;},executeCashuMelt:async()=>{count('execute');return new URLSearchParams(location.search).has('unknown')?{state:'unknown' as const,changePending:true}:{state:'paid' as const,changeToken:'cashuA_fictional_valid_change',changeSats:10,changePending:false,actualDebitSats:22};},recoverCashuMelt:async()=>{count('recover');return {state:'paid' as const,changeToken:'cashuA_fictional_valid_change',changeSats:10,changePending:false,actualDebitSats:22};}};
Object.assign(window,{fixture:{journal,calls,prepared,tokenMarker}});
createRoot(document.getElementById('root')!).render(<CashuInlinePayment paymentRequest={invoice} allowNew={!new URLSearchParams(location.search).has('closed')} onSettled={()=>count('settled')} engine={fixture as never}/>);
