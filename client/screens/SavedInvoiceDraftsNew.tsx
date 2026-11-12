import{useEffect,useState}from'react';
import type{Invoice}from'../../shared/contracts';
import type{InvoiceDraft}from'../../shared/invoice-options';
import{api}from'../api';
import{ErrorMessage,Loading}from'../components';
import{InvoiceEditor}from'./InvoiceEditor';

/**
 * Owner entry for a new invoice: a fresh editor with private server-side
 * draft persistence, or a duplicate of an issued invoice carried into a new
 * editable draft. A duplicate copies the customer, lines, pricing and terms
 * but never the invoice identity, number, token, status, receipts or balance;
 * the issue date resets to today and an absolute due date is cleared for the
 * owner to choose again. Carried expense lines stay marked for review.
 */
export function NewInvoiceDraft({onCreated}:{onCreated:()=>Promise<void>}){
  const duplicate=new URLSearchParams(window.location.search).get('duplicate');
  const[prefill,setPrefill]=useState<{draft:InvoiceDraft|undefined;notice:string}|undefined>(duplicate===null?{draft:undefined,notice:''}:undefined),[failure,setFailure]=useState('');
  useEffect(()=>{
    if(duplicate===null)return;
    let current=true;
    void api<Invoice>(`/api/invoices/${encodeURIComponent(duplicate)}`).then(source=>{
      if(!current)return;
      const copy:InvoiceDraft={
        customerName:source.customerName,...(source.customerEmail!==undefined?{customerEmail:source.customerEmail}:{}),title:source.title,currency:source.currency,
        items:source.items.map(item=>({description:item.description,quantity:item.quantity,unitAmount:item.unitAmount,...(item.kind!==undefined?{kind:item.kind}:{}),...(item.adjustmentEligible!==undefined?{adjustmentEligible:item.adjustmentEligible}:{})})),
        taxBps:source.taxBps,...(source.discountBps!==undefined?{discountBps:source.discountBps}:{}),...(source.premiumBps!==undefined?{premiumBps:source.premiumBps}:{}),
        ...(source.acceptedMethods!==undefined?{acceptedMethods:source.acceptedMethods}:{}),...(source.methodPricing!==undefined?{methodPricing:source.methodPricing}:{}),
        ...(source.paymentTermDays!==undefined?{paymentTermDays:source.paymentTermDays}:{}),...(source.paymentTerms!==undefined?{paymentTerms:source.paymentTerms}:{}),...(source.note!==undefined?{note:source.note}:{}),...(source.billing!==undefined?{billing:source.billing}:{})
      };
      setPrefill({draft:copy,notice:source.paymentTermDays===undefined?`Duplicated from invoice ${source.number}. The issue date was reset to today and the copied absolute due date was cleared — choose the payment terms again.`:`Duplicated from invoice ${source.number}. The issue date was reset to today; the due date follows the copied payment terms.`});
    }).catch(e=>{if(current)setFailure(e instanceof Error?e.message:'The invoice to duplicate could not be loaded.');});
    return()=>{current=false;};
  },[duplicate]);
  if(failure)return <ErrorMessage message={failure}/>;
  if(!prefill)return <Loading label="Opening the duplicated invoice…"/>;
  return <InvoiceEditor initialDraft={prefill.draft} initialNotice={prefill.notice} markCarriedExpenses={duplicate!==null} persistence onCreated={onCreated}/>;
}
