import {useEffect,useId,useState} from 'react';
import type {ReceivingRecord} from '../../shared/receiving';
import {receivingRequestExpiry} from '../../shared/receiving';
import {CopyButton} from '../components';

/** The adapter validates BOLT11; these UI guards never authorize settlement. */
export function canGuideCashuWallet(request:ReceivingRecord,now=Date.now()){
  const intent=request.intent,expiry=receivingRequestExpiry(request);
  return request.mode==='live'&&request.method==='lightning'&&request.status==='awaiting_payment'
    &&!request.reviewReason&&!request.creationUncertain&&Number.isFinite(expiry)&&expiry>now
    &&intent?.cashuWalletHandoff===true&&intent.network==='mainnet'&&intent.asset==='BTC'
    &&/^\d+$/.test(request.expectedAtomic)&&BigInt(request.expectedAtomic)>0n
    &&/^lightning:lnbc[0-9a-z]+$/.test(intent.request??'');
}

export function CashuWalletHandoff({paymentRequest}:{paymentRequest:string}){
  const [open,setOpen]=useState(false),[qr,setQr]=useState(''),[qrFailed,setQrFailed]=useState(false),id=useId();
  useEffect(()=>{
    if(!open)return;
    let active=true;setQr('');setQrFailed(false);
    void import('qrcode').then(module=>module.toDataURL(paymentRequest,{width:256,margin:4,errorCorrectionLevel:'M'}))
      .then(value=>{if(active)setQr(value);}).catch(()=>{if(active)setQrFailed(true);});
    return()=>{active=false;};
  },[open,paymentRequest]);
  return <section className="cashu-wallet-handoff">
    <button type="button" className="button secondary full" aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}>Pay from a Cashu wallet</button>
    {open?<div id={id} className="receive-instruction">
      <p>Open your existing Cashu wallet and choose Pay Lightning. Paste or scan this invoice for the exact sats amount shown above.</p>
      <div className="payment-request receiving-address"><code>{paymentRequest}</code><CopyButton value={paymentRequest} label="Copy Lightning invoice for Cashu wallet"/></div>
      {qr?<img className="cashu-wallet-qr" src={qr} width={256} height={256} alt="Scan this Lightning invoice in your Cashu wallet"/>:<p role="status">{qrFailed?'QR unavailable. Copy the Lightning invoice instead.':'Preparing QR…'}</p>}
      <p>Check the fees and total in your wallet before confirming. Your wallet and mint handle the payment; availability and fees vary.</p>
      <p><strong>Your receipt will say Lightning.</strong> Return here and choose Check payment after paying. Quiet Ledger verifies the original Lightning request and cannot identify how you funded it.</p>
      <p>Keep ecash tokens, wallet keys and recovery words in your wallet. This page does not need them.</p>
    </div>:null}
  </section>;
}
