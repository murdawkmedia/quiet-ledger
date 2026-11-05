import {test,expect,type Page,type TestInfo} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import type {Invoice} from '../../shared/contracts';

const runId=Date.now().toString(36);
const caseId=(info:TestInfo)=>info.testId+'-'+runId;
const ownerToken='hardening-fictional-owner-only';
const observations=new WeakMap<Page,{pageErrors:string[];consoleErrors:string[]}>();
test.beforeEach(async({page})=>{
  const observed={pageErrors:[] as string[],consoleErrors:[] as string[]};observations.set(page,observed);
  page.on('pageerror',error=>observed.pageErrors.push(error.message));
  page.on('console',message=>{if(message.type()==='error')observed.consoleErrors.push(message.text());});
});
test.afterEach(async({page},info)=>{
  await info.attach('browser-errors',{body:JSON.stringify(observations.get(page),null,2),contentType:'application/json'});
  expect(observations.get(page)?.pageErrors).toEqual([]);
});
async function enter(page:Page,role:'demo'|'owner'='demo'){
  await page.goto('/');
  if(role==='owner'){
    await page.getByRole('button',{name:'I have an owner token',exact:true}).click();
    await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);
    await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
  }else await page.getByRole('button',{name:'Enter demo workspace',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
}
async function noOverflow(page:Page){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
}
async function checkoutContentFits(page:Page){
  const widths=await page.locator('.checkout-invoice,.checkout-payment,.checkout-totals,.payment-methods').evaluateAll(elements=>elements.map(element=>({className:element.className,left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right,viewport:innerWidth})));
  for(const element of widths){expect(element.left,element.className).toBeGreaterThanOrEqual(0);expect(element.right,element.className).toBeLessThanOrEqual(element.viewport+1);}
}
async function capture(page:Page,info:TestInfo,name:string){await page.screenshot({path:info.outputPath(name+'.png'),fullPage:true});}
async function fillInvoice(page:Page,title:string,currency:'CAD'|'USD'='CAD'){
  await page.goto('/invoices/new');
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional Browser Review Studio');
  await page.getByLabel('Invoice title',{exact:true}).fill(title);
  await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional review service');
  await page.getByLabel('Item 1 quantity',{exact:true}).fill('3');
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('19.99');
  await page.getByRole('combobox',{name:'Invoice currency',exact:true}).selectOption(currency);
  await page.getByLabel('Tax rate (%)',{exact:true}).fill('7.25');
}
async function saveInvoice(page:Page):Promise<Invoice>{
  const response=page.waitForResponse(r=>r.url().endsWith('/api/invoices')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  const result=await response;expect(result.status()).toBe(201);
  const invoice=await result.json();await expect(page).toHaveURL(/\/invoices$/);return invoice;
}
async function apiInvoice(page:Page,title:string,currency:'CAD'|'USD'='CAD',amount=20000):Promise<Invoice>{
  return page.evaluate(async({title,currency,amount})=>{
    const session=await (await fetch('/api/session')).json();
    const response=await fetch('/api/invoices',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({customerName:'Fictional Browser API Setup',title,currency,taxBps:0,items:[{description:'Fictional test line',quantity:1,unitAmount:amount}]})});
    if(!response.ok)throw new Error('Synthetic setup failed '+response.status);return response.json();
  },{title,currency,amount});
}
async function pay(page:Page,invoice:Invoice,method:'cashu'|'square'|'bank_transfer'='cashu'){
  await page.goto(`/pay/${invoice.token}`);
  await expect(page.getByRole('heading',{name:invoice.title,exact:true})).toBeVisible();
  if(method==='square')await page.getByRole('button',{name:'Card Square simulation',exact:true}).click();
  if(method==='bank_transfer')await page.getByRole('button',{name:'Bank Transfer simulation',exact:true}).click();
  await page.getByRole('button',{name:`Pay with simulated ${method==='cashu'?'Cashu':method==='square'?'card':'bank transfer'}`,exact:true}).click();
  await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();
}

for(const currency of ['CAD','USD'] as const)test(`exact ${currency} line totals survive checkout receipt reload and export`,async({page},info)=>{
  await enter(page);await fillInvoice(page,`Fictional ${currency} rounding ${caseId(info)}`,currency);
  await page.getByRole('button',{name:'Add line item',exact:true}).click();
  await page.getByLabel('Item 2 description',{exact:true}).fill('Rounding boundary line');
  await page.getByLabel('Item 2 quantity',{exact:true}).fill('2');
  await page.getByLabel('Item 2 unit price',{exact:true}).fill('0.01');
  await expect(page.locator('.preview-total')).toContainText('64.34');
  const invoice=await saveInvoice(page);expect(invoice).toMatchObject({currency,subtotal:5999,tax:435,total:6434});
  await pay(page,invoice,currency==='USD'?'bank_transfer':'cashu');
  await page.reload();await expect(page.locator('.paid-amount')).toContainText('64.34');
  await page.getByRole('link',{name:'View payment receipt',exact:true}).click();
  await expect(page.locator('.receipt-amount')).toContainText(currency);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download receipt',exact:true}).click();
  const receipt=JSON.parse(await readFile(await(await download).path(),'utf8'));expect(receipt.receipt).toMatchObject({amount:6434,currency,mode:'simulation'});
  await capture(page,info,`${currency}-receipt`);
  await page.goto('/records');const exported=page.waitForEvent('download');await page.getByRole('button',{name:'Export workspace records',exact:true}).click();
  const data=JSON.parse(await readFile(await(await exported).path(),'utf8'));
  expect(data.invoices.find((i:Invoice)=>i.id===invoice.id)).toMatchObject({currency,total:6434,status:'paid'});
  expect(JSON.stringify(data)).not.toContain('876543');
});

test('invoice validation recovers from invalid precision and protects rapid submission',async({page},info)=>{
  await enter(page);await fillInvoice(page,'Fictional validation '+caseId(info));
  const posts:string[]=[];page.on('request',r=>{if(r.url().endsWith('/api/invoices')&&r.method()==='POST')posts.push(r.postData()??'');});
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('1.001');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('up to two decimal places');expect(posts).toHaveLength(0);
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('19.99');
  const result=page.waitForResponse(r=>r.url().endsWith('/api/invoices')&&r.request().method()==='POST');
  await page.locator('form.invoice-form-layout').evaluate((form:HTMLFormElement)=>{form.requestSubmit();form.requestSubmit();});
  expect((await result).status()).toBe(201);await expect(page).toHaveURL(/\/invoices$/);
  const response=await page.request.get('/api/invoices');const {invoices}=await response.json();
  expect(invoices.filter((i:Invoice)=>i.title==='Fictional validation '+caseId(info))).toHaveLength(1);
});

test('lost invoice creation response retries without adding a second invoice',async({page},info)=>{
  await enter(page);await fillInvoice(page,'Fictional lost response '+caseId(info));
  let first=true;const keys:string[]=[];
  await page.route('**/api/invoices',async route=>{
    if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);
    if(first){first=false;await route.fetch();await route.abort('connectionreset');}else await route.continue();
  });
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.getByRole('alert')).toContainText('fetch');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page).toHaveURL(/\/invoices$/);
  expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
  const {invoices}=await(await page.request.get('/api/invoices')).json();expect(invoices.filter((i:Invoice)=>i.title==='Fictional lost response '+caseId(info))).toHaveLength(1);
});

test('lost payment response and rapid retry produce one receipt',async({page},info)=>{
  await enter(page);const invoice=await apiInvoice(page,'Fictional lost payment '+caseId(info));
  await page.goto(`/pay/${invoice.token}`);await expect(page.getByRole('heading',{name:invoice.title,exact:true})).toBeVisible();
  let first=true;const keys:string[]=[];
  await page.route('**/api/checkout/*/pay',async route=>{keys.push(route.request().headers()['idempotency-key']);if(first){first=false;await route.fetch();await route.abort('connectionreset');}else await route.continue();});
  await page.getByRole('button',{name:'Pay with simulated Cashu',exact:true}).click();await expect(page.getByRole('alert')).toContainText('fetch');
  await page.getByRole('button',{name:'Pay with simulated Cashu',exact:true}).click();await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();
  expect(keys[0]).toBe(keys[1]);await page.getByRole('link',{name:'View payment receipt',exact:true}).click();const receiptURL=page.url();
  await page.goBack();await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();await page.reload();
  await page.getByRole('link',{name:'View payment receipt',exact:true}).click();expect(page.url()).toBe(receiptURL);
});

test('initial session dashboard checkout and export failures recover through visible controls',async({page},info)=>{
  let sessionFail=true;await page.route('**/api/session',route=>sessionFail?(sessionFail=false,route.fulfill({status:503,json:{error:'Fictional temporary session outage'}})):route.continue());
  await page.goto('/');await expect(page.getByRole('alert')).toContainText('Fictional temporary session outage');await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.getByRole('button',{name:'Enter demo workspace',exact:true}).click();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  const invoice=await apiInvoice(page,'Fictional recovery '+caseId(info));let fail=true;
  await page.route('**/api/dashboard',route=>fail?(fail=false,route.fulfill({status:503,json:{error:'Fictional dashboard outage'}})):route.continue());
  await page.goto('/dashboard');await expect(page.getByRole('alert')).toContainText('Fictional dashboard outage');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  fail=true;await page.route('**/api/checkout/*',route=>fail?(fail=false,route.fulfill({status:503,json:{error:'Fictional checkout outage'}})):route.continue());
  await page.goto(`/pay/${invoice.token}`);await expect(page.getByRole('alert')).toContainText('Fictional checkout outage');await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByRole('heading',{name:invoice.title,exact:true})).toBeVisible();
  await page.unroute('**/api/dashboard');await page.unroute('**/api/checkout/*');
  await page.goto('/records');fail=true;await page.route('**/api/evidence/export',route=>fail?(fail=false,route.fulfill({status:503,json:{error:'Fictional export outage'}})):route.continue());
  await page.getByRole('button',{name:'Export workspace records',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional export outage');
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'Export workspace records',exact:true}).click();await download;
});

test('payout state progresses explicitly and lost approval response reserves once',async({page},info)=>{
  await enter(page);const invoice=await apiInvoice(page,'Fictional payout '+caseId(info));await pay(page,invoice);await page.goto('/payouts');
  await expect(page.getByRole('heading',{name:'Money with somewhere to go.',exact:true})).toBeVisible();
  if(!await page.getByLabel('Fund from a paid invoice').isVisible())await page.getByRole('button',{name:'New payout',exact:true}).click();
  await page.getByLabel('Fund from a paid invoice').selectOption(invoice.id);await page.getByLabel('Destination type',{exact:true}).selectOption('bill');
  const recipient='Fictional utility '+caseId(info);await page.getByLabel('Recipient label').fill(recipient);await page.getByLabel('Amount to send · CAD',{exact:true}).fill('50.00');
  await page.getByRole('button',{name:'Review simulated quote',exact:true}).click();const card=page.locator('.payout-card').filter({hasText:recipient});await expect(card).toBeVisible();
  let first=true;const keys:string[]=[];
  await page.route('**/api/payouts/*/approve',async route=>{keys.push(route.request().headers()['idempotency-key']);if(first){first=false;await route.fetch();await route.abort('connectionreset');}else await route.continue();});
  await card.getByRole('button',{name:'Approve simulated payout',exact:true}).click();await expect(card.getByRole('alert')).toContainText('fetch');
  await card.getByRole('button',{name:'Approve simulated payout',exact:true}).click();expect(keys[0]).toBe(keys[1]);
  for(const [action,status] of [['Simulate funding received','Provider processing'],['Simulate provider payout','Provider reports paid'],['Confirm simulated recipient credit','Recipient credit confirmed']]){
    await card.getByRole('button',{name:action,exact:true}).click();await expect(card.locator('.badge')).toHaveText(status);
  }
  await page.reload();await expect(card.getByText('Recorded separately from funding',{exact:true})).toBeVisible();
  const {payouts}=await(await page.request.get('/api/payouts')).json();expect(payouts.filter((p:{invoiceId:string;status:string})=>p.invoiceId===invoice.id&&p.status==='received')).toHaveLength(1);
  await capture(page,info,'payout-received');
});

test('mobile maximum length invoice and checkout avoid horizontal overflow',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await enter(page);await fillInvoice(page,'Fictional maximum length');
  const titleLimit=Number(await page.getByLabel('Invoice title',{exact:true}).getAttribute('maxlength'));
  await page.getByLabel('Invoice title',{exact:true}).fill('X'.repeat(titleLimit));
  await page.getByLabel('Customer name',{exact:true}).fill('Y'.repeat(Number(await page.getByLabel('Customer name',{exact:true}).getAttribute('maxlength'))));await page.getByLabel('Item 1 description',{exact:true}).fill('Z'.repeat(Number(await page.getByLabel('Item 1 description',{exact:true}).getAttribute('maxlength'))));
  await page.getByLabel('Customer note').fill('N'.repeat(1000));await noOverflow(page);await capture(page,info,'mobile-long-form');
  const invoice=await saveInvoice(page);await noOverflow(page);await capture(page,info,'mobile-long-invoice-list');
  await page.goto(`/pay/${invoice.token}`);await expect(page.getByRole('heading',{name:invoice.title,exact:true})).toBeVisible();
  await capture(page,info,'mobile-long-checkout');await noOverflow(page);await checkoutContentFits(page);
});

test('mobile sample checkout and navigation preserve demo boundaries',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await enter(page);
  for(const path of ['/dashboard','/invoices','/invoices/new','/payouts','/records','/integrations','/sample-store']){await page.goto(path);await expect(page.locator('h1')).toBeVisible();await noOverflow(page);}
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();await expect(page.getByRole('navigation',{name:'Main navigation'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Square sandbox',exact:true})).toHaveCount(0);await expect(page.getByRole('link',{name:'Private scenario',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Close navigation',exact:true}).first().click();
  const created=page.waitForResponse(r=>r.url().endsWith('/api/sample-checkout')&&r.request().method()==='POST');await page.getByRole('button',{name:'Try sample checkout',exact:true}).click();
  expect((await created).status()).toBe(201);await expect(page.getByRole('heading',{name:'Field notes — website checkout',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Card Square simulation',exact:true}).click();await page.getByRole('button',{name:'Pay with simulated card',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();await noOverflow(page);await capture(page,info,'mobile-sample-paid');
  await page.goto('/scenario');await expect(page.getByRole('alert')).toContainText('private owner');await expect(page.getByText('Synthetic owner-only planning scenario',{exact:true})).toHaveCount(0);
  await page.goto('/square-sandbox');await expect(page.getByRole('alert')).toContainText('private owner');
});

test('owner login error recovery logout and demo keep owner scenario outside exports',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'I have an owner token',exact:true}).click();await page.getByLabel('Owner token',{exact:true}).fill('fictional-incorrect-token');
  await page.getByRole('button',{name:'Open private workspace',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();
  await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();await page.goto('/scenario');await expect(page.getByRole('heading',{name:'Synthetic owner-only planning scenario',exact:true})).toBeVisible();
  await page.goto('/square-sandbox');await expect(page.getByText('Awaiting sandbox credentials',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Verify sandbox connection',exact:true})).toBeDisabled();
  const exported=await page.request.get('/api/evidence/export');expect(await exported.text()).not.toContain('876543');
  await page.getByRole('button',{name:'Leave workspace',exact:true}).click();await page.getByRole('button',{name:'Enter demo workspace',exact:true}).click();
  await page.goto('/scenario');await expect(page.getByRole('alert')).toContainText('private owner');
});

test('Square UI fixtures recover from verification error and never credit simulation balance',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});
  const checkout={id:'clearly-fictional-browser-checkout',token:'clearly-fictional-browser-token',invoiceNumber:'FICTIONAL-SQUARE-UI',amount:1234,currency:'USD',mode:'square_sandbox',status:'awaiting_payment',createdAt:'2026-11-05T03:30:00Z',url:'https://sandbox.square.link/u/fictional-browser-fixture'};
  let attempts=0;let paid=false;
  const receipt={number:'FICTIONAL-UI-RECEIPT',mode:'square_sandbox',amount:1234,currency:'USD',invoiceNumber:checkout.invoiceNumber,verifiedAt:'2026-11-05T03:31:00Z'};
  await page.route('**/api/square-test/clearly-fictional-browser-token',route=>route.fulfill({json:{checkout:paid?{...checkout,status:'paid',receipt}:checkout}}));
  await page.route('**/api/square-test/clearly-fictional-browser-token/check',route=>{attempts++;if(attempts===1)return route.fulfill({status:502,json:{error:'Fictional provider timeout; safe to retry'}});paid=true;return route.fulfill({json:{checkout:{...checkout,status:'paid',receipt}}});});
  await page.goto('/square-test/clearly-fictional-browser-token');await expect(page.getByRole('heading',{name:'A Square test checkout.',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open Square test checkout',exact:true})).toHaveAttribute('href',checkout.url);
  await page.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional provider timeout');
  await page.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(page.getByRole('heading',{name:'Test payment verified.',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('FICTIONAL-UI-RECEIPT',{exact:true})).toBeVisible();await noOverflow(page);await capture(page,info,'square-fixture-receipt-only');
  const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'Download test receipt',exact:true}).click();expect(JSON.parse(await readFile(await(await downloaded).path(),'utf8'))).toEqual(receipt);
  // Fixtures establish UI behavior only. No account or Square API is contacted.
});

test('Square browser API and injected provider transport recover saved checkout and verify exact receipt',async({page},info)=>{
  const origin='http://127.0.0.1:4331';
  await page.goto(origin+'/');await page.getByRole('button',{name:'I have an owner token',exact:true}).click();
  await page.getByLabel('Owner token',{exact:true}).fill(ownerToken);await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  const invoice=await apiInvoice(page,'Fictional provider transport '+caseId(info),'CAD',321);
  const usd=await apiInvoice(page,'Fictional unsupported USD '+caseId(info),'USD',321);
  await page.request.post(origin+'/__fixture/provider',{data:{creationFailures:1,readbackFailures:0,paymentStatus:'pending'}});
  await page.goto(origin+'/square-sandbox');await page.getByRole('button',{name:'Verify sandbox connection',exact:true}).click();
  await expect(page.getByText('Sandbox location verified',{exact:true})).toBeVisible();
  const select=page.getByRole('combobox',{name:'Invoice to test',exact:true});
  expect(await select.locator(`option[value="${usd.id}"]`).evaluate((option:HTMLOptionElement)=>option.disabled)).toBe(true);
  await select.selectOption(invoice.id);await page.getByRole('button',{name:'Create Square test checkout',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('awaiting recovery');
  const card=page.locator('.square-checkout').filter({hasText:invoice.number});await expect(card.getByText('Recover checkout',{exact:true})).toBeVisible();
  await capture(page,info,'square-api-saved-intent');
  await page.reload();await card.getByRole('button',{name:'Retry saved checkout',exact:true}).click();
  await expect(card.getByText('Awaiting test payment',{exact:true})).toBeVisible();
  await card.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(card.getByText('Awaiting test payment',{exact:true})).toBeVisible();
  await page.request.post(origin+'/__fixture/provider',{data:{readbackFailures:1}});
  await card.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('readback is unavailable');
  await card.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
  await page.request.post(origin+'/__fixture/provider',{data:{paymentStatus:'mismatch'}});
  await card.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('does not match');
  await page.setViewportSize({width:390,height:844});
  await card.getByRole('link',{name:'Open test payment page',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A Square test checkout.',exact:true})).toBeVisible();
  await page.request.post(origin+'/__fixture/provider',{data:{paymentStatus:'completed'}});
  await page.getByRole('button',{name:'Check test payment',exact:true}).click();await expect(page.getByRole('heading',{name:'Test payment verified.',exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('heading',{name:'Test payment verified.',exact:true})).toBeVisible();await noOverflow(page);await capture(page,info,'square-api-authoritative-fixture-receipt');
  const view=await(await page.request.get(origin+'/api/dashboard')).json();
  expect(view.invoices.find((i:Invoice)=>i.id===invoice.id)).toMatchObject({status:'open'});expect(view.totals.receivedCad).toBe(0);
  const state=await(await page.request.get(origin+'/__fixture/state')).json();
  const creates=state.requests.filter((r:{url:string})=>r.url.endsWith('/payment-links'));
  const current=creates.slice(-2);expect(current).toHaveLength(2);expect(current[0].body.idempotency_key).toBe(current[1].body.idempotency_key);
  expect(JSON.stringify(current)).not.toContain('Fictional Browser API Setup');expect(JSON.stringify(current)).not.toContain(invoice.title);expect(JSON.stringify(current)).not.toContain('876543');
  await info.attach('fictional-provider-requests',{body:JSON.stringify(state.requests,null,2),contentType:'application/json'});
});

test('supported long unbroken invoice fields wrap on mobile checkout',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await enter(page);
  const invoice=await page.evaluate(async()=>{
    const session=await(await fetch('/api/session')).json();const response=await fetch('/api/invoices',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({customerName:'Y'.repeat(120),title:'X'.repeat(160),currency:'CAD',taxBps:0,items:[{description:'Z'.repeat(240),quantity:1,unitAmount:1234}],note:'N'.repeat(1000)})});
    if(!response.ok)throw new Error('Synthetic long-field setup '+response.status);return response.json();
  });
  await page.goto(`/pay/${invoice.token}`);await expect(page.getByRole('heading',{name:invoice.title,exact:true})).toBeVisible();
  await capture(page,info,'mobile-supported-long-checkout');await noOverflow(page);await checkoutContentFits(page);
});

test('checkout browser back cannot show another invoice after a late response',async({page},info)=>{
  await enter(page);const first=await apiInvoice(page,'Fictional first back target '+caseId(info));const second=await apiInvoice(page,'Fictional second delayed target '+caseId(info));
  await page.goto(`/pay/${first.token}`);await expect(page.getByRole('heading',{name:first.title,exact:true})).toBeVisible();
  let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let requested!:()=>void;const started=new Promise<void>(resolve=>requested=resolve);
  await page.route(`**/api/checkout/${second.token}`,async route=>{const response=await route.fetch();requested();await held;await route.fulfill({response});});
  // The app's history router permits back/forward directly between bearer URLs.
  await page.evaluate(path=>{history.pushState({},'',path);dispatchEvent(new PopStateEvent('popstate'));},`/pay/${second.token}`);await started;
  await page.goBack();await expect(page.getByRole('heading',{name:first.title,exact:true})).toBeVisible();release();
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading',{name:first.title,exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:second.title,exact:true})).toHaveCount(0);
  await capture(page,info,'checkout-back-late-response');
});
