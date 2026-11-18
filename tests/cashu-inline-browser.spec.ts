import {test,expect} from '@playwright/test';
import {createHash} from 'node:crypto';
import * as bolt11 from 'bolt11';
import * as sdk from '@cashu/cashu-ts-browser';
const mint='https://mint.minibits.cash/Bitcoin';
const bytes=(n:number)=>Uint8Array.from(Buffer.from(n.toString(16).padStart(64,'0'),'hex'));
for(const lost of [false,true])test(`built demo Cashu to Lightning with ${lost?'lost response and recovery':'verified change and receipt'}`,async({page},info)=>{
 const errors:string[]=[],leaks:string[]=[];let melts=0,quoteInvoice='',outputs:any[]=[],paid=false;
 page.on('pageerror',e=>errors.push(e.message));
 const keys=Object.fromEntries([1,2,4,8,16,32,64].map(n=>[String(n),Buffer.from(sdk.getPubKeyFromPrivKey(bytes(n))).toString('hex')]));
 const id=sdk.deriveKeysetId(keys,{unit:'sat',input_fee_ppk:0}),keyset={id,unit:'sat',active:true,input_fee_ppk:0,keys};
 const secret='fictional-browser-payer-'+(lost?'lost':'paid'),Y=sdk.hashToCurve(new TextEncoder().encode(secret)),B=Y.add(sdk.pointFromHex(keys['1'])),d=sdk.createDLEQProof(B,bytes(32));
 const proof={id,amount:32,secret,C:Y.multiply(32n).toHex(true),dleq:{e:Buffer.from(d.e).toString('hex'),s:Buffer.from(d.s).toString('hex'),r:'0'.repeat(63)+'1'}};
 const token=sdk.getEncodedToken({mint,unit:'sat',proofs:sdk.normalizeProofAmounts([proof])});
 page.on('request',r=>{if(r.url().startsWith('http://localhost:4367')&&r.postData()?.includes(secret))leaks.push(r.url());});
 const preimage=()=>{const hash=bolt11.decode(quoteInvoice).tags.find(t=>t.tagName==='payment_hash')!.data;for(let i=1;i<20;i++){const p=createHash('sha256').update('fictional-cashu-browser-'+i).digest('hex');if(createHash('sha256').update(Buffer.from(p,'hex')).digest('hex')===hash)return p;}throw new Error('No fixture preimage');};
 const signatures=()=>[2,8].map((amount,i)=>{const B=sdk.pointFromHex(outputs[i].B_),signature=sdk.createBlindSignature(B,bytes(amount),id),d=sdk.createDLEQProof(B,bytes(amount));return {id,amount,C_:signature.C_.toHex(true),dleq:{e:Buffer.from(d.e).toString('hex'),s:Buffer.from(d.s).toString('hex')}};});
 const quote=()=>({quote:'fictional_browser_quote',amount:21,fee_reserve:2,expiry:Math.floor(Date.now()/1000)+500,state:paid?'PAID':'UNPAID',payment_preimage:paid?preimage():null});
 await page.route(mint+'/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname.replace('/Bitcoin','');
  let body:any;
  if(path==='/v1/keysets'||path.startsWith('/v1/keys/'))body={keysets:[keyset]};
  else if(path==='/v1/melt/quote/bolt11'&&request.method()==='POST'){quoteInvoice=request.postDataJSON().request;body=quote();}
  else if(path==='/v1/melt/bolt11'){
   melts++;expect(melts).toBe(1);const payload=request.postDataJSON();outputs=payload.outputs;paid=true;
   const hash=bolt11.decode(quoteInvoice).tags.find(t=>t.tagName==='payment_hash')!.data;
   expect((await page.request.post('/__fixture/settle',{data:{paymentHash:hash}})).status()).toBe(200);
   if(lost){await route.abort('failed');return;}body={...quote(),change:signatures()};
  }else if(path.startsWith('/v1/melt/quote/bolt11/'))body={...quote(),change:signatures()};
  else if(path==='/v1/restore')body={outputs:outputs.slice(0,2).map((o,i)=>({...o,amount:[2,8][i]})),signatures:signatures()};
  else throw new Error('Unexpected fictional mint path '+path);
  await route.fulfill({json:body,headers:{'Access-Control-Allow-Origin':'*'}});
 });
 await page.goto('/');await page.getByRole('button',{name:'Hackathon demo',exact:true}).click();await page.getByLabel('Demo password',{exact:true}).fill('marmot');await page.getByRole('button',{name:'Enter hackathon demo',exact:true}).click();await expect(page).toHaveURL(/\/demo$/);
 const original=await page.request.get('/api/hackathon-demo').then(r=>r.json());
 await page.getByRole('link',{name:'Real 21-sat payment',exact:true}).click();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Create my real 21-sat Lightning invoice',exact:true}).click();
 await page.getByRole('button',{name:'Pay with ecash here',exact:true}).click();await page.getByLabel('Cashu token',{exact:true}).fill(token);await page.getByRole('button',{name:'Review Cashu payment',exact:true}).click();
 await expect(page.getByText('Maximum debit: 23 sats',{exact:true})).toBeVisible();expect(melts).toBe(0);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Save private recovery file',exact:true}).click();await download;
 await page.getByRole('button',{name:'Confirm Cashu payment',exact:true}).click();
 if(lost){await expect(page.getByText('Payment outcome unknown.',{exact:true})).toBeVisible();await page.reload();await page.getByRole('button',{name:'Pay with ecash here',exact:true}).click();await page.getByRole('button',{name:'Check saved payment and change',exact:true}).click();}
 await expect(page.getByText('Real Lightning payment received',{exact:true})).toBeVisible();await expect(page.getByText('Change returned: 10 sats',{exact:true})).toBeVisible();
 const change=await page.getByLabel('Recovered ecash change',{exact:true}).inputValue();const decoded=sdk.getDecodedToken(change,[id]);expect(decoded.proofs.reduce((n,p)=>n+p.amount.toNumber(),0)).toBe(10);for(const p of decoded.proofs)expect(sdk.verifyDleqIfPresent(p,keyset)).toBe(true);
 await page.reload();await expect(page.getByText('Real Lightning payment received',{exact:true})).toBeVisible();await expect(page.getByText('Change returned: 10 sats',{exact:true})).toBeVisible();expect(melts).toBe(1);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('fictional-cashu-lightning-change.png'),fullPage:true});
 expect((await page.request.get('/api/hackathon-demo').then(r=>r.json())).invoice).toEqual(original.invoice);expect(errors).toEqual([]);expect(leaks).toEqual([]);
});
