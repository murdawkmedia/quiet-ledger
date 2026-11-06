import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InvoiceEditor} from '../../client/screens/InvoiceEditor';
import {CheckoutPage} from '../../client/screens/Public';
import {post,setCsrf} from '../../client/api';
import type {Invoice} from '../../shared/contracts';
import type {InvoiceDraft} from '../../shared/invoice-options';
import '../../client/styles.css';
setCsrf('fictional-line-adjustments-csrf');
const params=new URLSearchParams(location.search);
const initial:InvoiceDraft={customerName:'Fictional review customer',title:'Fictional review draft',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false}],discountBps:500,issueDate:'2028-02-28',dueDate:'2028-03-29',paymentTermDays:30,paymentTerms:'Fictional review terms',taxBps:0};
function Fixture(){
 const [replacement,setReplacement]=useState(false);
 if(params.has('checkout'))return <CheckoutPage token="fictional-lines"/>;
 return <main className="main-content">{params.has('review')?<button onClick={()=>setReplacement(true)}>Replace parent draft</button>:null}<InvoiceEditor demo={!params.has('review')} initialDraft={params.has('review')?{...initial,title:replacement?'Ignored parent replacement':initial.title,items:replacement?initial.items.map(item=>({...item,adjustmentEligible:!item.adjustmentEligible})):initial.items}:undefined} submitDraft={params.has('review')?async(draft,key)=>post<Invoice>('/api/fictional-lines/issue',{draft},key):undefined} onCreated={async()=>{document.body.dataset.created='true';}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
