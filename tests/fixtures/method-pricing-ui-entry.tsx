import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InvoiceEditor} from '../../client/screens/InvoiceEditor';
import {CheckoutPage,ReceiptPage} from '../../client/screens/Public';
import {PaymentMethodsPage} from '../../client/screens/PaymentMethods';
import {InvoiceLedger} from '../../client/screens/InvoiceLedger';
import {post,setCsrf} from '../../client/api';
import type {Dashboard} from '../../client/types';
import type {Invoice} from '../../shared/contracts';
import type {InvoiceDraft} from '../../shared/invoice-options';
import '../../client/styles.css';

setCsrf('fictional-method-pricing-csrf');
const params=new URLSearchParams(location.search);
const agreement={id:'00000000-0000-4000-8000-000000000101',invoiceId:'fictional-priced-invoice',method:'lightning',offerHash:'a'.repeat(64),confirmedAt:'2026-11-06T01:00:00Z',confirmation:'public_checkout_token',currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:10000,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,discountBps:1000,premiumBps:0,discountAmount:20000,premiumAmount:0,adjustedSubtotal:250000,effectiveTax:12500,taxAdjustment:-1000,effectiveTotal:262500,totalAdjustment:-21000,referenceAmountSats:262500};
const pricedInvoice={id:'fictional-priced-invoice',number:'QL-FICTIONAL-PRICING',token:'fictional-pricing-token',title:'Fictional labour and flights',customerName:'Fictional Customer',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false}],taxBps:500,discountBps:500,discountAmount:10000,premiumAmount:0,subtotal:280000,tax:13500,total:283500,status:'open',createdAt:'2026-11-06T00:00:00Z',acceptedMethods:['lightning','card'],methodPricing:[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}],priceAgreement:params.has('locked')?agreement:undefined,balance:{total:283500,effectiveTotal:params.has('locked')?262500:283500,paid:0,credited:0,due:params.has('locked')?262500:283500,overpaid:0,currency:'CAD',state:'unpaid',mode:'live'}};
const initial:InvoiceDraft={customerName:'Fictional review customer',title:'Fictional recurring review draft',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false}],discountBps:500,premiumBps:0,issueDate:'2028-02-28',dueDate:'2028-03-29',paymentTermDays:30,paymentTerms:'Fictional recurring review terms',taxBps:500,acceptedMethods:['lightning','card'],methodPricing:[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}]};
const satInitial:InvoiceDraft={...initial,currency:'SAT',title:'Fictional SAT review draft',items:[{description:'Fictional SAT labour',quantity:1,unitAmount:1000,kind:'service',adjustmentEligible:true},{description:'Fictional SAT expense',quantity:1,unitAmount:200,kind:'expense',adjustmentEligible:false}],acceptedMethods:['lightning'],methodPricing:[{method:'lightning',discountBps:1000}],issueDate:'2028-03-01',dueDate:'2028-03-31'};
function Fixture(){
 const view=params.get('view')??'editor';
 const [token,setToken]=useState('fictional-pricing-token');
 if(view==='checkout')return <>{params.has('switch')?<button onClick={()=>setToken('fictional-other-token')}>Switch checkout token</button>:null}<CheckoutPage token={token}/></>;
 if(view==='receipt')return <ReceiptPage token="fictional-receipt-token"/>;
 if(view==='methods')return <main className="main-content"><PaymentMethodsPage owner data={{invoices:[pricedInvoice],payouts:[],activity:[],totals:{invoicedCad:283500,receivedCad:0,availableCad:0,spentCad:0}} as Dashboard} refreshDashboard={async()=>{}}/></main>;
 if(view==='ledger')return <main className="main-content"><InvoiceLedger id="fictional-priced-invoice" onChanged={async()=>{document.body.dataset.changed='true';}}/></main>;
 return <main className="main-content"><InvoiceEditor demo={view==='demo'} initialDraft={view==='review'||view==='sat'?view==='sat'?satInitial:initial:undefined} submitDraft={view==='review'||view==='sat'?async(draft,key)=>post<Invoice>('/api/fictional-pricing/issue',{draft},key):undefined} onCreated={async()=>{document.body.dataset.created='true';}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
