import {useState} from 'react';
import type {InvoiceEmailResult} from '../../shared/invoice-delivery';

export function InvoiceEmailRecovery({delivery,busy,onResolve}:{delivery:InvoiceEmailResult;busy:boolean;onResolve:(id:string,outcome:'confirmed_sent'|'confirmed_not_sent',note:string)=>Promise<void>}){
 const [outcome,setOutcome]=useState<''|'confirmed_sent'|'confirmed_not_sent'>(''),[note,setNote]=useState('');
 if(delivery.resolutionOutcome)return <p>{delivery.resolutionOutcome==='confirmed_sent'?'Confirmed sent after mailbox review':'Confirmed not sent after mailbox review'}{delivery.resolvedAt?` · ${new Date(delivery.resolvedAt).toLocaleString()}`:''}</p>;
 if(!delivery.deliveryId||!['unknown','partial_rejection','sending'].includes(delivery.state))return null;
 return <form className="email-recovery" onSubmit={event=>{event.preventDefault();if(outcome)void onResolve(delivery.deliveryId!,outcome,note);}}><p>Check your sent mailbox and recipients before recording a review. This action sends no email.</p><label className="field">Email review result<select aria-label="Email review result" required value={outcome} onChange={event=>setOutcome(event.target.value as typeof outcome)} disabled={busy}><option value="">Choose what you verified</option><option value="confirmed_sent">I confirmed it was sent</option><option value="confirmed_not_sent">I confirmed it was not sent</option></select></label><label className="field">Email review note<textarea aria-label="Email review note" rows={2} required minLength={5} maxLength={1000} value={note} onChange={event=>setNote(event.target.value)} disabled={busy}/></label><button className="button secondary" disabled={busy||!outcome||note.trim().length<5}>Record email review</button></form>;
}
