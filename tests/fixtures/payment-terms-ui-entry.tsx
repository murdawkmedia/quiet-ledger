import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {InvoiceEditor} from '../../client/screens/InvoiceEditor';
import {CheckoutPage} from '../../client/screens/Public';
import {post,setCsrf} from '../../client/api';
import type {Invoice} from '../../shared/contracts';
import type {InvoiceDraft} from '../../shared/invoice-options';
import '../../client/styles.css';
setCsrf('fictional-terms-csrf');
const params=new URLSearchParams(location.search);
const initial:InvoiceDraft={customerName:'Fictional review customer',title:'Fictional review draft',currency:'CAD',items:[{description:'Fictional review service',quantity:2,unitAmount:12345}],issueDate:'2028-02-28',dueDate:'2028-03-29',paymentTermDays:30,paymentTerms:'Fictional initial terms',note:'Fictional legacy note',taxBps:0};
function Fixture(){
 const [replacement,setReplacement]=useState(false);
 if(params.has('checkout'))return <CheckoutPage token="fictional-terms"/>;
 return <main className="main-content">{params.has('review')?<button onClick={()=>setReplacement(true)}>Replace parent draft</button>:null}<InvoiceEditor demo={!params.has('review')} initialDraft={params.has('review')?{...initial,title:replacement?'Ignored parent replacement':initial.title}:undefined} submitDraft={params.has('review')?async(draft,key)=>post<Invoice>('/api/fictional-review/issue',{draft},key):undefined} onCreated={async()=>{document.body.dataset.created='true';}}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
