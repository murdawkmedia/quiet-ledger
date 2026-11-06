import {test,expect,type Page} from '@playwright/test';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createApp} from '../../server/app.js';
import type {Invoice} from '../../shared/contracts.js';
import type {ReceivingAdapter} from '../../shared/receiving.js';

// Real browser -> real Express/SQLite app, with injected synthetic receiving.
// No provider transport, wallet, private runtime or funded transaction is used.
const ownerToken='synthetic-receiving-browser-owner';
const root=resolve(import.meta.dirname,'../..');
async function startFixture(){
  let paid=false,clock=Date.now(),creates=0,checks=0;
  const adapter:ReceivingAdapter={id:'synthetic-browser-receiver',mode:'live',methods:['bitcoin','bank','lightning'],walletOptionIds:['bitcoin-core','manual-fiat','lnd'],
    create:async context=>{creates++;return {providerId:context.requestId,network:context.method==='bank'?'fiat':'mainnet',asset:context.method==='bank'?context.currency:'BTC',allocationKey:`synthetic:${context.requestId}`,
      ...(context.method==='lightning'?{request:'lightning:lnbc10u1fixtureonly',cashuWalletHandoff:true as const}:context.method==='bitcoin'?{request:'bitcoin:synthetic-fixture-never-send-funds?amount=0.00001000'}:{instructions:[{label:'Synthetic bank instructions',value:'Fixture only: independently check the received transfer before confirmation.'}]}),opaque:{privateInternal:'synthetic-provider-internal-marker'}};},
    check:async context=>{checks++;return context.method==='bank'?{status:'review',reason:'Synthetic bank receipt needs independent owner verification.'}:paid?{status:'paid',paymentId:`synthetic-btc-payment:${context.requestId}`,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'};},
  };
  const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],now:()=>new Date(clock),receivingQuote:async(invoice,method)=>({expectedAtomic:method==='bank'?String(invoice.total):'1000',cadEquivalent:invoice.total,source:'Synthetic browser quote; no market source contacted',observedAt:new Date(clock).toISOString()})});
  const outer=express();outer.use(app);outer.use(express.static(resolve(root,'dist/client')));outer.get('/{*path}',(_req,res)=>res.sendFile(resolve(root,'dist/client/index.html')));
  const listener=outer.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));
  const origin=`http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  return {origin,settle:()=>{paid=true;clock+=4000;},counts:()=>({creates,checks}),close:async()=>{listener.closeAllConnections();await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));app.locals.close();}};
}
async function enter(page:Page,origin:string){
  await page.goto(origin+'/');await page.getByRole('button',{name:'I have an owner token',exact:true}).click();
  await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
}
async function createInvoice(page:Page,origin:string,title:string):Promise<Invoice>{
  const session=await(await page.request.get(origin+'/api/session')).json();
  const response=await page.request.post(origin+'/api/invoices',{headers:{'X-CSRF-Token':session.csrfToken,'Idempotency-Key':randomUUID()},data:{customerName:'Fictional receiving-browser customer',title,currency:'CAD',items:[{description:'Fictional browser fixture',quantity:1,unitAmount:1200}]}});
  expect(response.status()).toBe(201);return response.json();
}

test('actual app BTC checkout preserves pending state then records one verified live receipt',async({page},info)=>{
  const fixture=await startFixture(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await enter(page,fixture.origin);const invoice=await createInvoice(page,fixture.origin,'Synthetic live BTC browser invoice');
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);await expect(page.getByText('Live checkout',{exact:true})).toBeVisible();
    await page.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('bitcoin');await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
    await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();
    await expect(page.getByText('1,000 sats',{exact:true})).toBeVisible();await expect(page.getByText('mainnet',{exact:true})).toBeVisible();
    expect(await page.locator('body').textContent()).not.toContain('synthetic-provider-internal-marker');
    const receiveUrl=page.url();await page.getByRole('button',{name:'Check payment',exact:true}).click();
    await expect.poll(()=>fixture.counts().checks).toBe(1);
    await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();
    const pending=await(await page.request.get(`${fixture.origin}/api/invoices/${invoice.id}`)).json();expect(pending.status).toBe('open');
    fixture.settle();await page.setViewportSize({width:390,height:844});
    // Public checks deliberately retain cached state during a short wall-clock
    // cooldown. Poll through that real boundary rather than disabling it.
    await expect.poll(async()=>{if(fixture.counts().checks<2)await page.getByRole('button',{name:'Check payment',exact:true}).click();return fixture.counts().checks;},{intervals:[1000],timeout:8000}).toBe(2);
    await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();await expect(page.getByText('Live payment · real funds',{exact:true})).toBeVisible();
    await page.reload();await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();expect(page.url()).toBe(receiveUrl);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath('synthetic-actual-app-btc-receipt-mobile.png'),fullPage:true});
    const dashboard=await(await page.request.get(fixture.origin+'/api/dashboard')).json();const saved=dashboard.invoices.find((row:Invoice)=>row.id===invoice.id);
    expect(saved).toMatchObject({status:'paid',settlementMode:'live',nativePayment:{asset:'BTC',atomicAmount:'1000',network:'mainnet',verification:'provider'}});expect(dashboard.totals).toMatchObject({receivedCad:1200,availableCad:0});
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);await page.getByRole('link',{name:'View payment receipt',exact:true}).click();
    await expect(page.getByText('Provider readback',{exact:true})).toBeVisible();await expect(page.getByText('1000 BTC atomic units · mainnet',{exact:true})).toBeVisible();
    expect(fixture.counts()).toEqual({creates:1,checks:2});expect(errors).toEqual([]);
  }finally{await page.goto('about:blank').catch(()=>{});await fixture.close();}
});

test('actual app owner bank review requires explicit fields and records a manual live receipt',async({page},info)=>{
  const fixture=await startFixture(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await enter(page,fixture.origin);const invoice=await createInvoice(page,fixture.origin,'Synthetic independently reviewed bank invoice');
    await page.goto(fixture.origin+'/payment-methods');await page.getByRole('combobox',{name:'Invoice to receive',exact:true}).selectOption(invoice.id);
    await page.getByRole('combobox',{name:'Receiving method',exact:true}).selectOption('bank');await page.getByRole('button',{name:'Create live receiving request',exact:true}).click();
    const card=page.locator('.receiving-card').filter({hasText:invoice.number});await expect(card).toBeVisible();
    await card.getByRole('link',{name:'Open payment request',exact:true}).click();await expect(page.getByText('Synthetic bank instructions',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Check payment',exact:true}).click();await expect(page.getByRole('heading',{name:'Awaiting payment review.',exact:true})).toBeVisible();
    expect((await(await page.request.get(`${fixture.origin}/api/invoices/${invoice.id}`)).json()).status).toBe('open');
    await page.goto(fixture.origin+'/payment-methods');await expect(card.getByText('Owner review required',{exact:true})).toBeVisible();
    await card.getByRole('button',{name:'Review a manually verified payment',exact:true}).click();
    const confirm=card.getByRole('button',{name:'Confirm independently verified payment',exact:true});await expect(confirm).toBeDisabled();
    await card.getByLabel(/Received transaction reference/).fill('SYNTHETIC-RECEIVED-BANK-REFERENCE');await card.getByLabel('Verification note',{exact:true}).fill('Synthetic fixture: independently checked exact received currency, amount and invoice.');await expect(confirm).toBeDisabled();
    await card.getByLabel('I verified the exact asset, network, amount and invoice',{exact:true}).check();await confirm.click();
    await expect(card.getByText('Verified',{exact:true})).toBeVisible();await page.reload();await expect(card.getByText('Verified',{exact:true})).toBeVisible();
    await page.screenshot({path:info.outputPath('synthetic-actual-app-bank-confirmed.png'),fullPage:true});
    const dashboard=await(await page.request.get(fixture.origin+'/api/dashboard')).json();const saved=dashboard.invoices.find((row:Invoice)=>row.id===invoice.id);
    expect(saved).toMatchObject({status:'paid',settlementMode:'live',nativePayment:{verification:'manual'}});expect(dashboard.totals).toMatchObject({receivedCad:1200,availableCad:0});
    await page.goto(`${fixture.origin}/receipt/${saved.receiptToken}`);await expect(page.getByText('Independent owner review',{exact:true})).toBeVisible();await expect(page.getByText('Live payment · real funds',{exact:true})).toBeVisible();
    await expect(page.getByText('SYNTHETIC-RECEIVED-BANK-REFERENCE',{exact:true})).toBeVisible();expect(fixture.counts()).toEqual({creates:1,checks:1});expect(errors).toEqual([]);
  }finally{await page.goto('about:blank').catch(()=>{});await fixture.close();}
});

test('actual app Cashu handoff keeps one Lightning allocation and provider-verified receipt across reload',async({page},info)=>{
  const fixture=await startFixture(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  try{
    await enter(page,fixture.origin);const invoice=await createInvoice(page,fixture.origin,'Fictional Cashu-wallet Lightning invoice');
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);
    await page.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('lightning');
    await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
    const receiveUrl=page.url(),button=page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true});
    await button.click();await expect(page.getByRole('img',{name:'Scan this Lightning invoice in your Cashu wallet',exact:true})).toBeVisible();
    await expect(page.getByText('1,000 sats',{exact:true})).toBeVisible();
    expect(fixture.counts()).toEqual({creates:1,checks:0});
    expect((await(await page.request.get(`${fixture.origin}/api/invoices/${invoice.id}`)).json()).status).toBe('open');
    await page.reload();await button.click();await expect(page.locator('.cashu-wallet-handoff code')).toHaveText('lightning:lnbc10u1fixtureonly');
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:info.outputPath('fictional-cashu-handoff-mobile.png'),fullPage:true});
    await page.getByRole('button',{name:'Check payment',exact:true}).click();await expect.poll(()=>fixture.counts().checks).toBe(1);
    await expect(button).toBeVisible();fixture.settle();
    await expect.poll(async()=>{if(fixture.counts().checks<2)await page.getByRole('button',{name:'Check payment',exact:true}).click();return fixture.counts().checks;},{intervals:[1000],timeout:8000}).toBe(2);
    await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();await expect(button).toHaveCount(0);
    await expect(page.locator('.receipt-facts dd').filter({hasText:/^Lightning$/})).toBeVisible();
    await page.reload();expect(page.url()).toBe(receiveUrl);await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();
    const record=(await(await page.request.get(fixture.origin+'/api/receive/'+new URL(receiveUrl).pathname.split('/').pop())).json()).request;
    expect(record.receipt).toMatchObject({method:'lightning',mode:'live'});
    const saved=(await(await page.request.get(`${fixture.origin}/api/invoices/${invoice.id}`)).json());
    expect(saved).toMatchObject({paymentMethod:'lightning',settlementMode:'live',nativePayment:{asset:'BTC',atomicAmount:'1000',network:'mainnet',verification:'provider'}});
    expect(fixture.counts()).toEqual({creates:1,checks:2});expect(errors).toEqual([]);
  }finally{await page.goto('about:blank').catch(()=>{});await fixture.close();}
});
