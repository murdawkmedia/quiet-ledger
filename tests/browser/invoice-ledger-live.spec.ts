import {test,expect,type Page} from '@playwright/test';
import express from 'express';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {createApp} from '../../server/app.js';
import type {ReceivingAdapter} from '../../shared/receiving.js';

const root=resolve(import.meta.dirname,'../..'),ownerToken='fictional-business-browser-owner';
async function fixture(){
 const paid=new Set<string>(),requests:{id:string;amount:number}[]=[];
 const adapter:ReceivingAdapter={id:'fictional-ledger-lnd',mode:'live',methods:['lightning'],walletOptionIds:['lnd'],create:async c=>{requests.push({id:c.requestId,amount:c.amount});return {providerId:c.requestId,asset:'BTC',network:'mainnet',request:'lightning:lnbc10u1fixtureonly',cashuWalletHandoff:true};},check:async c=>paid.has(c.requestId)?{status:'paid',paymentId:'fixture-payment:'+c.requestId,reference:c.requestId,amount:c.amount,currency:c.currency}:{status:'pending'}};
 const app=createApp({dbPath:':memory:',ownerToken,receivingAdapters:[adapter],receivingQuote:async invoice=>({expectedAtomic:String(invoice.total*10),cadEquivalent:invoice.total,source:'Fictional browser quote',observedAt:new Date().toISOString()})});
 const outer=express();outer.use(app);outer.use(express.static(resolve(root,'dist/client')));outer.get('/{*path}',(_req,res)=>res.sendFile(resolve(root,'dist/client/index.html')));
 const listener=outer.listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));
 return {origin:`http://127.0.0.1:${(listener.address() as AddressInfo).port}`,paid,requests,close:async()=>{listener.closeAllConnections();await new Promise<void>(resolve=>listener.close(()=>resolve()));app.locals.close();}};
}
async function enter(page:Page,origin:string){await page.goto(origin);await page.getByRole('button',{name:'I have an owner token',exact:true}).click();await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);await page.getByRole('button',{name:'Open private workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();}
async function invoice(page:Page,origin:string,title:string){const session=await(await page.request.get(origin+'/api/session')).json();const response=await page.request.post(origin+'/api/invoices',{headers:{'X-CSRF-Token':session.csrfToken,'Idempotency-Key':randomUUID()},data:{customerName:'Fictional invoice-browser client',title,currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:10000}]}});expect(response.status()).toBe(201);return response.json();}

test('actual app deposit and final balance produce two exact receipts and a paid ledger',async({page},info)=>{
 const f=await fixture(),errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await enter(page,f.origin);const saved=await invoice(page,f.origin,'Fictional deposit and final invoice');
  await page.goto(`${f.origin}/invoices/${saved.id}/ledger`);await expect(page.getByRole('heading',{name:'Invoice ledger',exact:true})).toBeVisible();
  for(const [amount,due] of [['30.00','70.00'],['70.00','0.00']]){
   await page.getByLabel('Payment request amount (CAD)',{exact:true}).fill(amount);await page.getByRole('button',{name:'Create payment request',exact:true}).click();
   await expect.poll(()=>f.requests.length).toBe(amount==='30.00'?1:2);const row=page.locator('.ledger-request-list article').first();f.paid.add(f.requests.at(-1)!.id);
   await row.getByRole('link',{name:'Open payment request',exact:false}).click();await page.getByRole('button',{name:'Check payment',exact:true}).click();await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();
   await page.goto(`${f.origin}/invoices/${saved.id}/ledger`);await expect(page.getByTestId('ledger-due')).toHaveText('$'+due);
  }
  await expect(page.locator('.ledger-entries tbody tr')).toHaveCount(2);await expect(page.getByTestId('ledger-total')).toHaveText('$100.00');await expect(page.getByTestId('ledger-paid')).toHaveText('$100.00');
  expect(f.requests.map(row=>row.amount)).toEqual([3000,7000]);
  const links=await page.locator('.ledger-entries a').evaluateAll(nodes=>nodes.map(node=>(node as HTMLAnchorElement).href));expect(new Set(links).size).toBe(2);
  const amounts=[];for(const link of links){const token=new URL(link).pathname.split('/').pop();const data=await(await page.request.get(f.origin+'/api/receipts/'+token)).json();amounts.push(data.receipt.amount);}expect(amounts.sort((a,b)=>a-b)).toEqual([3000,7000]);
  await page.reload();await expect(page.locator('.ledger-entries tbody tr')).toHaveCount(2);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('fictional-paid-ledger-mobile.png'),fullPage:true});expect(errors).toEqual([]);
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});

test('actual app credit and void close collection without creating payment receipts',async({page})=>{
 const f=await fixture();try{
  await enter(page,f.origin);const saved=await invoice(page,f.origin,'Fictional full credit');await page.goto(`${f.origin}/invoices/${saved.id}/ledger`);
  await page.getByLabel('Credit amount (CAD)',{exact:true}).fill('100.00');await page.getByLabel('Credit reason',{exact:true}).fill('Fictional scope withdrawn');await page.getByRole('button',{name:'Record credit note',exact:true}).click();await expect(page.getByTestId('ledger-due')).toHaveText('$0.00');await expect(page.getByTestId('ledger-paid')).toHaveText('$0.00');
  await page.goto(`${f.origin}/pay/${saved.token}`);await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'View payment receipt',exact:true})).toHaveCount(0);
  const other=await invoice(page,f.origin,'Fictional void');await page.goto(`${f.origin}/invoices/${other.id}/ledger`);await page.getByLabel('Void reason',{exact:true}).fill('Fictional duplicate invoice');await page.getByRole('checkbox',{name:'I confirm this unpaid invoice should be voided.',exact:true}).check();await page.getByRole('button',{name:'Void unpaid invoice',exact:true}).click();await expect(page.getByTestId('ledger-due')).toHaveText('$0.00');
  const data=await(await page.request.get(`${f.origin}/api/invoices/${other.id}/ledger`)).json();expect(data.balance.state).toBe('void');expect(data.entries.some((entry:any)=>entry.kind==='payment')).toBe(false);expect(f.requests).toEqual([]);
 }finally{await page.goto('about:blank').catch(()=>{});await f.close();}
});
