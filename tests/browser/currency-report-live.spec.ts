import {test,expect} from '@playwright/test';
import express from 'express';
import {randomUUID} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {resolve} from 'node:path';
import {createApp} from '../../server/app.js';
const ownerToken='fictional-currency-browser-owner',root=resolve(import.meta.dirname,'../..');
test('actual invoice records produce separate USD and whole-won dashboard and export summaries',async({page},info)=>{
 const app=createApp({dbPath:':memory:',ownerToken}),outer=express();outer.use(app);outer.use(express.static(resolve(root,'dist/client')));outer.get('/{*path}',(_req,res)=>res.sendFile(resolve(root,'dist/client/index.html')));
 const listener=outer.listen(0,'127.0.0.1');await new Promise<void>(r=>listener.once('listening',r));const origin=`http://127.0.0.1:${(listener.address() as AddressInfo).port}`,errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 try{
  await page.goto(origin);await page.getByRole('button',{name:'I have an owner token',exact:true}).click();await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);await page.getByRole('button',{name:'Open private workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  const session=await(await page.request.get(origin+'/api/session')).json(),headers={'X-CSRF-Token':session.csrfToken};
  for(const [currency,unitAmount] of [['USD',10001],['KRW',150001]] as const){
   const created=await page.request.post(origin+'/api/invoices',{headers:{...headers,'Idempotency-Key':randomUUID()},data:{customerName:'Fictional native-currency client',title:'Fictional report invoice',currency,items:[{description:'Fictional service',quantity:1,unitAmount}]}});expect(created.status()).toBe(201);const invoice=await created.json();
   const credit=await page.request.post(origin+`/api/invoices/${invoice.id}/credits`,{headers:{...headers,'Idempotency-Key':randomUUID()},data:{amount:1,reason:'Fictional one-minor-unit adjustment'}});expect(credit.status()).toBe(200);
  }
  await page.reload();const table=page.getByRole('table',{name:'Invoice balances by currency',exact:true});await expect(table).toBeVisible();await expect(table.getByRole('row')).toHaveCount(3);await expect(table.getByRole('row').filter({hasText:'USD'})).toContainText('100.01');await expect(table.getByRole('row').filter({hasText:'KRW'})).toContainText('150,001');await expect(table.getByRole('row').filter({hasText:'KRW'})).toContainText('150,000');
  await page.goto(origin+'/records');await expect(table).toBeVisible();const evidence=await(await page.request.get(origin+'/api/evidence/export')).json();expect(evidence.currencyBalances.map((r:any)=>[r.currency,r.due])).toEqual([['USD',10000],['KRW',150000]]);expect(evidence.valuation.invoicedCad).toBe('reference_only');
  await page.reload();await expect(table.getByRole('row')).toHaveCount(3);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:info.outputPath('fictional-currency-report-mobile.png'),fullPage:true});expect(errors).toEqual([]);
 }finally{await page.goto('about:blank').catch(()=>{});listener.closeAllConnections();await new Promise<void>(r=>listener.close(()=>r()));app.locals.close();}
});
