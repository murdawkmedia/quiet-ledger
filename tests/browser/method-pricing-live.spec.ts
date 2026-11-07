import {test,expect,type Page} from '@playwright/test';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {createApp} from '../../server/app.js';
import type {ReceivingAdapter,ReceivingContext} from '../../shared/receiving.js';
import type {Invoice} from '../../shared/contracts.js';

// Built UI -> real API -> encrypted SQLite -> synthetic provider readback.
// No external network, wallet, real account, seed or funded payment is used.
const ownerToken='synthetic-method-browser-owner';
async function fixture(){
 let clock=Date.now();const requests:ReceivingContext[]=[],paid=new Set<string>();
 const adapter:ReceivingAdapter={id:'synthetic-method-browser',mode:'live',methods:['lightning','card'],
  create:async context=>{requests.push(context);return {providerId:context.requestId,request:'synthetic:fictional-payment-only',network:context.method==='lightning'?'mainnet':'synthetic-provider',asset:context.method==='lightning'?'BTC':'CAD'};},
  check:async context=>paid.has(context.requestId)?{status:'paid',paymentId:'synthetic:'+context.requestId,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'},
 };
 const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],now:()=>new Date(clock),receivingQuote:async invoice=>({expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.totalCad,source:'Controlled fictional quote',observedAt:new Date(clock).toISOString()})});
 const outer=express();outer.use(app);const dist=resolve(import.meta.dirname,'../../dist/client');outer.use(express.static(dist));outer.get('/{*path}',(_req,res)=>res.sendFile(resolve(dist,'index.html')));
 const listener=outer.listen(0,'127.0.0.1');await new Promise<void>(done=>listener.once('listening',done));
 return {origin:`http://127.0.0.1:${(listener.address() as AddressInfo).port}`,requests,settle:()=>{paid.add(requests.at(-1)!.requestId);clock+=4000;},close:async()=>{listener.closeAllConnections();await new Promise<void>((done,reject)=>listener.close(error=>error?reject(error):done()));app.locals.close();}};
}
async function createFromEditor(page:Page,origin:string){
 await page.goto(origin);await page.getByRole('button',{name:'I have an owner token',exact:true}).click();await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);await page.getByRole('button',{name:'Open private workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
 await page.goto(origin+'/invoices/new');await page.getByLabel('Customer name',{exact:true}).fill('Fictional invoice studio');await page.getByLabel('Invoice title',{exact:true}).fill('Fictional labour and fixed flights');await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional production labour');await page.getByLabel('Item 1 unit price',{exact:true}).fill('2000.00');await page.getByRole('button',{name:'Add line item',exact:true}).click();await page.getByLabel('Item 2 description',{exact:true}).fill('Fictional fixed flight expense');await page.getByLabel('Item 2 unit price',{exact:true}).fill('800.00');await page.getByLabel('Item 2 type',{exact:true}).selectOption('expense');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).not.toBeChecked();
 await page.getByLabel('Discount (%)',{exact:true}).fill('5');await page.getByLabel('Tax rate (%)',{exact:true}).fill('5');await page.getByLabel('Offer all payment methods',{exact:true}).uncheck();
 for(const label of ['Accept Bitcoin','Accept Bank transfer'])await page.getByLabel(label,{exact:true}).uncheck();
 await page.getByLabel('Accept Lightning',{exact:true}).check();await page.getByLabel('Accept Card',{exact:true}).check();
 await page.getByRole('button',{name:'Add method price rule',exact:true}).click();await page.getByLabel('Rule 1 method',{exact:true}).selectOption('lightning');await page.getByLabel('Rule 1 discount (%)',{exact:true}).fill('10');await page.getByRole('button',{name:'Add method price rule',exact:true}).click();await page.getByLabel('Rule 2 method',{exact:true}).selectOption('card');await page.getByLabel('Rule 2 premium (%)',{exact:true}).fill('2');
 await expect(page.getByTestId('method-preview-lightning')).toContainText('$2,625.00');await expect(page.getByTestId('method-preview-card')).toContainText('$2,877.00');await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page).toHaveURL(origin+'/invoices');return (await(await page.request.get(origin+'/api/invoices')).json()).invoices[0] as Invoice;
}
for(const choice of [{method:'lightning',label:'Lightning',total:262500,display:'$2,625.00'},{method:'card',label:'Card',total:287700,display:'$2,877.00'}])test(`actual invoice ${choice.method} agreement keeps flights fixed and settles two installments`,async({page})=>{
 const f=await fixture(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 try {
  const invoice=await createFromEditor(page,f.origin);expect(invoice.total).toBe(283500);expect(invoice.items[1]).toMatchObject({kind:'expense',adjustmentEligible:false});
  await page.goto(`${f.origin}/pay/${invoice.token}`);await expect(page.getByTestId('price-offer-lightning')).toContainText('$2,625.00');await expect(page.getByTestId('price-offer-card')).toContainText('$2,877.00');expect(f.requests).toHaveLength(0);
  await page.getByRole('button',{name:`Select ${choice.label} price`,exact:true}).click();await page.getByRole('button',{name:`Confirm ${choice.label} at ${choice.display}`,exact:true}).click();await expect(page.getByText(`${choice.label} price locked`,{exact:true})).toBeVisible();expect(f.requests).toHaveLength(0);
  const locked=await(await page.request.get(`${f.origin}/api/checkout/${invoice.token}`)).json(),agreement=locked.invoice.priceAgreement;expect(agreement).toMatchObject({method:choice.method,effectiveTotal:choice.total,eligibleSubtotal:200000,issuedTotal:283500});expect(agreement).not.toHaveProperty('invoiceId');expect(agreement).not.toHaveProperty('referenceTotalCad');expect(locked.invoice.balance.paid).toBe(0);
  for(const amount of [100000,choice.total-100000]){
   await page.goto(`${f.origin}/pay/${invoice.token}`);await expect(page.getByLabel('Payment method',{exact:true}).locator('option')).toHaveText([choice.label]);await page.getByLabel('Payment amount (CAD)',{exact:true}).fill((amount/100).toFixed(2));await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();expect(f.requests.at(-1)).toMatchObject({method:choice.method,amount,currency:'CAD'});
   const before=await(await page.request.get(`${f.origin}/api/invoices/${invoice.id}`)).json();expect(before.status).toBe('open');await page.getByRole('button',{name:'Check payment',exact:true}).click();await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();f.settle();await expect.poll(async()=>{const done=page.getByRole('heading',{name:'Payment verified.',exact:true});if(await done.isVisible())return true;await page.getByRole('button',{name:'Check payment',exact:true}).click();return done.isVisible();},{intervals:[1000],timeout:8000}).toBe(true);
  }
  const ledger=await(await page.request.get(`${f.origin}/api/invoices/${invoice.id}/ledger`)).json();expect(ledger.balance).toMatchObject({total:283500,effectiveTotal:choice.total,paid:choice.total,due:0,state:'paid'});expect(ledger.entries).toHaveLength(2);expect(ledger.entries.every((row:{kind:string})=>row.kind==='payment')).toBe(true);expect(ledger.invoice.priceAgreement.id).toBe(agreement.id);
  await page.goto(`${f.origin}/pay/${invoice.token}`);await page.getByRole('link',{name:'View payment receipt',exact:true}).click();await expect(page.getByText('Live payment receipt',{exact:true})).toBeVisible();await expect(page.getByTestId('receipt-effective-total')).toHaveText(choice.display);await expect(page.getByText('Provider readback',{exact:true})).toBeVisible();
  const csv=await(await page.request.get(`${f.origin}/api/invoice-ledger/export.csv`)).text();expect(csv).toContain(`"2835.00","${(choice.total/100).toFixed(2)}","${choice.method}"`);expect(csv).toContain(agreement.id);
  const dashboard=await(await page.request.get(f.origin+'/api/dashboard')).json();expect(dashboard.totals).toMatchObject({receivedCad:choice.total,availableCad:0});expect(f.requests).toHaveLength(2);expect(errors).toEqual([]);
 } finally {await page.goto('about:blank').catch(()=>{});await f.close();}
});
