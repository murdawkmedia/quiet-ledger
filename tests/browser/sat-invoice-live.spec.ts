import {test,expect,type Page} from '@playwright/test';
import express from 'express';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {createApp} from '../../server/app.js';
import type {ReceivingAdapter} from '../../shared/receiving.js';
import type {Invoice} from '../../shared/contracts.js';

// Real browser -> real Express/SQLite app with an injected synthetic Bitcoin
// adapter. Whole-satoshi SAT flow end to end: no provider transport, wallet,
// network quote, seed or funded transaction is ever contacted.
const ownerToken='synthetic-sat-browser-owner';
const root=resolve(import.meta.dirname,'../..');
async function startFixture(){
 let paid=false,clock=Date.now(),creates=0,checks=0;
 const adapter:ReceivingAdapter={id:'synthetic-sat-browser-receiver',mode:'live',methods:['bitcoin','lightning'],
  create:async context=>{creates++;return {providerId:context.requestId,request:'lightning:lnbc210u1fixtureonly',network:'mainnet',asset:'BTC',allocationKey:`synthetic:${context.requestId}`,cashuWalletHandoff:true as const};},
  check:async context=>{checks++;return paid?{status:'paid',paymentId:`synthetic-sat-payment:${context.requestId}`,reference:context.requestId,amount:context.amount,currency:context.currency}:{status:'pending'};},
 };
 const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],now:()=>new Date(clock)});
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

test('actual app creates a whole-satoshi SAT invoice, receives exact sats live and reports it honestly',async({page})=>{
 const fixture=await startFixture(),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 try{
  await enter(page,fixture.origin);
  // Issue the SAT invoice through the real editor against the real API.
  await page.goto(fixture.origin+'/invoices/new');
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional satoshi studio');
  await page.getByLabel('Invoice title',{exact:true}).fill('Whole-satoshi workshop');
  await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional recording');
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('21000');
  await page.getByLabel('Tax rate (%)',{exact:true}).fill('0');
  await page.getByRole('combobox',{name:'Invoice currency',exact:true}).selectOption('SAT');
  await expect(page.getByText('SAT invoices settle in whole satoshis:',{exact:false})).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'Accept Card',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(fixture.origin.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/invoices$'));
  await expect(page.getByText('21,000 sats',{exact:true})).toBeVisible();
  const list=await(await page.request.get(fixture.origin+'/api/invoices')).json();
  const invoice:Invoice=list.invoices[0];
  expect(invoice).toMatchObject({currency:'SAT',total:21000,amountSats:21000,status:'open'});
  expect(invoice.totalCad).toBeUndefined();
  // Customer checkout binds the exact satoshi amount with the live adapter only.
  await page.goto(`${fixture.origin}/pay/${invoice.token}`);
  await expect(page.getByText('Live checkout',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('lightning');
  await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();
  await expect(page.getByText('21,000 sats',{exact:true})).toBeVisible();
  await expect(page.getByText('mainnet',{exact:true})).toBeVisible();
  const receiveUrl=page.url();
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect.poll(()=>fixture.counts().checks).toBe(1);
  await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();
  expect((await(await page.request.get(`${fixture.origin}/api/invoices/${invoice.id}`)).json()).status).toBe('open');
  fixture.settle();
  // Public checks keep a short cached cooldown; poll through that real boundary.
  await expect.poll(async()=>{if(fixture.counts().checks<2)await page.getByRole('button',{name:'Check payment',exact:true}).click();return fixture.counts().checks;},{intervals:[1000],timeout:8000}).toBe(2);
  await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();
  await expect(page.getByText('Live payment · real funds',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();expect(page.url()).toBe(receiveUrl);
  // The receipt records the exact whole-satoshi amount and provider verification.
  await page.goto(`${fixture.origin}/pay/${invoice.token}`);
  await page.getByRole('link',{name:'View payment receipt',exact:true}).click();
  await expect(page.getByText('Live payment receipt',{exact:true})).toBeVisible();
  await expect(page.locator('.receipt-amount')).toContainText('21,000 sats');
  await expect(page.getByText('Provider readback',{exact:true})).toBeVisible();
  await expect(page.getByText('21000 BTC atomic units · mainnet',{exact:true})).toBeVisible();
  // Workspace records: exact sats, no CAD reference, no payout funding.
  const dashboard=await(await page.request.get(fixture.origin+'/api/dashboard')).json();
  const saved=dashboard.invoices.find((row:Invoice)=>row.id===invoice.id);
  expect(saved).toMatchObject({currency:'SAT',total:21000,status:'paid',settlementMode:'live',nativePayment:{asset:'BTC',atomicAmount:'21000',network:'mainnet',verification:'provider'}});
  expect(saved.totalCad).toBeUndefined();
  expect(dashboard.totals).toMatchObject({invoicedCad:0,receivedCad:0,availableCad:0});
  expect(dashboard.valuation.satInvoices).toBe('excluded_no_fiat_conversion');
  const satRow=dashboard.currencyBalances.find((row:{currency:string;mode:string})=>row.currency==='SAT'&&row.mode==='live');
  expect(satRow).toMatchObject({issued:21000,paid:21000,due:0});
  const csv=await(await page.request.get(fixture.origin+'/api/invoice-ledger/export.csv')).text();
  expect(csv).toContain('"SAT","21000","21000","","0","0","0","0","0","21000","0","0","0"');
  expect(csv.includes('"210.00"')).toBe(false);
  expect(fixture.counts()).toEqual({creates:1,checks:2});
  expect(errors).toEqual([]);
 }finally{await page.goto('about:blank').catch(()=>{});await fixture.close();}
});
