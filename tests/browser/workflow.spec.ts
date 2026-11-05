import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';

async function enterDemo(page:Page){
  await page.goto('/');
  await page.getByRole('button',{name:'Enter demo workspace'}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.'})).toBeVisible();
}

test('invoice → Cashu simulation → receipt → bill payout → records survives reload',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:1440,height:1000});
  await enterDemo(page);
  await page.screenshot({path:'test-results/dashboard-desktop.png',fullPage:true});
  await page.getByRole('link',{name:'Create invoice',exact:true}).first().click();
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional Workflow Studio');
  await page.getByLabel('Invoice title',{exact:true}).fill('Browser-tested design service');
  await page.getByLabel('Item 1 description',{exact:true}).fill('Design and implementation');
  await page.getByLabel('Item 1 quantity',{exact:true}).fill('2');
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('125.00');
  await page.getByLabel('Tax rate (%)',{exact:true}).fill('5');
  const created=page.waitForResponse(r=>r.url().endsWith('/api/invoices')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  const creation=await created;expect(creation.status()).toBe(201);
  const invoice=await creation.json();expect(invoice.total).toBe(26250);
  await page.goto(`/pay/${invoice.token}`);
  await expect(page.getByRole('heading',{name:'Browser-tested design service'})).toBeVisible();
  await page.screenshot({path:'test-results/checkout-desktop.png',fullPage:true});
  await page.getByRole('button',{name:'Pay with simulated Cashu',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();
  await page.getByRole('link',{name:'View payment receipt'}).click();
  const receiptDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download receipt',exact:true}).click();
  const receipt=JSON.parse(await readFile(await (await receiptDownload).path(),'utf8'));
  expect(receipt.receipt.mode).toBe('simulation');expect(receipt.receipt.amount).toBe(26250);
  await page.goto('/payouts');
  const form=page.getByRole('button',{name:'Review simulated quote',exact:true});
  if(!await form.isVisible())await page.getByRole('button',{name:'New payout',exact:true}).click();
  await page.getByLabel('Fund from a paid invoice').selectOption(invoice.id);
  await page.getByLabel('Provider',{exact:true}).selectOption('bullbitcoin');
  await page.getByLabel('Destination type',{exact:true}).selectOption('bill');
  await page.getByLabel('Recipient label').fill('Fictional utility for browser test');
  await page.getByLabel('Amount to send · CAD',{exact:true}).fill('100.00');
  await form.click();
  const card=page.locator('.payout-card').filter({hasText:'Fictional utility for browser test'}).first();
  await card.getByRole('button',{name:'Approve simulated payout',exact:true}).click();
  await card.getByRole('button',{name:'Simulate funding received',exact:true}).click();
  await card.getByRole('button',{name:'Simulate provider payout',exact:true}).click();
  await expect(card.getByRole('button',{name:'Confirm simulated recipient credit',exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/payout-desktop.png',fullPage:true});
  await card.getByRole('button',{name:'Confirm simulated recipient credit',exact:true}).click();
  await page.reload();
  await expect(card.getByText('Recorded separately from funding')).toBeVisible();
  await page.goto('/records');
  const exportDownload=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export workspace records',exact:true}).click();
  const exported=JSON.parse(await readFile(await (await exportDownload).path(),'utf8'));
  expect(exported.mode).toBe('simulation');expect(exported.payouts.some((p:any)=>p.invoiceId===invoice.id&&p.status==='received')).toBe(true);
  expect(JSON.stringify(exported)).not.toContain('ownerToken');
  expect(errors).toEqual([]);
});

test('phone layout supports website checkout and ordinary-fiat payout restrictions',async({page})=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.setViewportSize({width:390,height:844});await enterDemo(page);
  await page.screenshot({path:'test-results/dashboard-mobile.png',fullPage:true});
  for(const path of ['/dashboard','/invoices/new','/payouts','/integrations','/sample-store']){
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  }
  const created=page.waitForResponse(r=>r.url().endsWith('/api/sample-checkout')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Try sample checkout',exact:true}).click();
  const response=await created;expect(response.status()).toBe(201);const invoice=await response.json();
  await page.getByRole('button',{name:'Card Square simulation'}).click();
  await page.getByRole('button',{name:'Pay with simulated card',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  await page.goto('/payouts');
  if(!await page.getByRole('button',{name:'Review simulated quote',exact:true}).isVisible())await page.getByRole('button',{name:'New payout',exact:true}).click();
  await page.getByLabel('Fund from a paid invoice').selectOption(invoice.id);
  await expect(page.getByLabel('Provider',{exact:true})).toHaveValue('wise');
  // Native option.disabled is true; this Chromium/Playwright combination's
  // generic isDisabled() does not report disabled option elements correctly.
  expect(await page.getByLabel('Destination type',{exact:true}).locator('option[value="bill"]').evaluate((option:HTMLOptionElement)=>option.disabled)).toBe(true);
  await page.getByLabel('Recipient label').fill('Fictional own business account');
  await page.getByLabel('Amount to send · CAD',{exact:true}).fill('999999.00');
  await page.getByRole('button',{name:'Review simulated quote',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('exceeds');
  await page.getByLabel('Amount to send · CAD',{exact:true}).fill('5.00');
  await page.getByRole('button',{name:'Review simulated quote',exact:true}).click();
  await expect(page.locator('.payout-card').filter({hasText:'Fictional own business account'}).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('private owner scenario requires owner login and uses a separate empty ledger',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'I have an owner token',exact:true}).click();
  await page.getByLabel('Owner token',{exact:true}).fill('e2e-only-owner-fixture');
  await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
  await page.getByRole('link',{name:'Private scenario',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Synthetic owner-only planning scenario',exact:true})).toBeVisible();
  await page.goto('/invoices');
  await expect(page.getByText('Fictional Workflow Studio',{exact:true})).toHaveCount(0);
});
