import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';

test('owner sees Square credential blocker without exposing provider actions to the demo',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'I have an owner token',exact:true}).click();
  await page.getByLabel('Owner token',{exact:true}).fill('e2e-only-owner-fixture');
  await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
  await page.getByRole('link',{name:'Square sandbox',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Test your card checkout.',exact:true})).toBeVisible();
  await expect(page.getByText('Awaiting sandbox credentials',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Verify sandbox connection',exact:true})).toBeDisabled();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});

test('Square public checkout displays only a verified test receipt and downloads it on mobile',async({page})=>{
  const checkout={id:'fixture-checkout',token:'fixture-token',invoiceNumber:'QL-TEST-1',amount:125,currency:'CAD',mode:'square_sandbox',status:'awaiting_payment',createdAt:'2026-11-05T02:00:00Z',url:'https://sandbox.square.link/u/fixture'};
  let paid=false;
  await page.route('**/api/square-test/fixture-token',route=>route.fulfill({json:{checkout:paid?{...checkout,status:'paid',receipt:{number:'SQTEST-FIXTURE',mode:'square_sandbox',amount:125,currency:'CAD',invoiceNumber:'QL-TEST-1',verifiedAt:'2026-11-05T02:01:00Z'}}:checkout}}));
  await page.route('**/api/square-test/fixture-token/check',route=>{paid=true;return route.fulfill({json:{checkout:{...checkout,status:'paid',receipt:{number:'SQTEST-FIXTURE',mode:'square_sandbox',amount:125,currency:'CAD',invoiceNumber:'QL-TEST-1',verifiedAt:'2026-11-05T02:01:00Z'}}}});});
  await page.setViewportSize({width:390,height:844});
  await page.goto('/square-test/fixture-token');
  await expect(page.getByRole('heading',{name:'A Square test checkout.',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open Square test checkout',exact:true})).toHaveAttribute('href',checkout.url);
  await page.getByRole('button',{name:'Check test payment',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Test payment verified.',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByText('SQTEST-FIXTURE',{exact:true})).toBeVisible();
  const downloaded=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download test receipt',exact:true}).click();
  const receipt=JSON.parse(await readFile(await(await downloaded).path(),'utf8'));
  expect(receipt.mode).toBe('square_sandbox');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});
