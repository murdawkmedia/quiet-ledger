import {test,expect,type Page,type TestInfo} from '@playwright/test';
import type {Invoice} from '../../shared/contracts';

const origin='http://localhost:4335';
const text={update:'A private update is available. Review it in Quiet Ledger.',acknowledge:'I acknowledge the private update.',review:'Please review the details in Quiet Ledger.','receipt-notice':'A receipt is ready. Open it in Quiet Ledger.'};
test.beforeEach(async({context},info)=>{
  const client=1+[...info.testId].reduce((sum,character)=>sum+character.charCodeAt(0),0)%200;
  await context.addCookies([{name:'ql_fixture_client',value:String(client),url:origin}]);
});
type DemoView={invoice:Invoice;checkoutToken:string;expiresAt:string};
type Envelope={kind:number;pubkey:string;content:string;tags:string[][]};
function observe(page:Page){
  const errors:string[]=[],external:string[]=[],sockets:string[]=[],events:Envelope[]=[],rateLimits:string[]=[],counts={apiRequests:0};
  page.on('pageerror',error=>errors.push(error.message));
  page.on('websocket',socket=>sockets.push(new URL(socket.url()).origin));
  page.on('response',response=>{if(response.status()===429)rateLimits.push(new URL(response.url()).pathname);});
  page.context().on('request',request=>{
    const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin)external.push(url.origin);
    if(url.origin===origin&&url.pathname.startsWith('/api/'))counts.apiRequests++;
    if(request.method()==='POST'&&url.pathname.endsWith('/conversation/events')){
      const body=request.postDataJSON() as {event?:Envelope}|null;if(body?.event)events.push(body.event);
    }
  });
  return {errors,external,sockets,events,counts,rateLimits};
}
async function signIn(page:Page,wrongPassword=false){
  await page.goto('/');await page.getByRole('button',{name:'Hackathon demo',exact:true}).click();
  const password=page.getByLabel('Demo password',{exact:true});
  if(wrongPassword){await password.fill('fictional-wrong-demo-password');await page.getByRole('button',{name:'Enter hackathon demo',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page).not.toHaveURL(/\/demo$/);}
  await password.fill('marmot');await page.getByRole('button',{name:'Enter hackathon demo',exact:true}).click();
  await expect(page).toHaveURL(/\/demo$/);await expect(page.getByRole('heading',{name:'A private conversation. A clear paper trail.',exact:true})).toBeVisible();
}
async function demoView(page:Page):Promise<DemoView>{const response=await page.request.get('/api/hackathon-demo');expect(response.status()).toBe(200);return response.json();}
async function prepare(page:Page){await page.getByRole('button',{name:'Prepare demo',exact:true}).click();await expect(page.getByText('Both participants connected',{exact:true})).toBeVisible({timeout:30000});}
async function networkEvidence(info:TestInfo,observed:ReturnType<typeof observe>){
  expect(observed.external,'No browser HTTP request may leave this fixture origin.').toEqual([]);
  expect(observed.sockets,'Private app transport must not open a WebSocket.').toEqual([]);
  expect(observed.errors,'The actual app and SDK should not throw browser errors.').toEqual([]);
  expect(observed.rateLimits,'The actual protocol flow should fit its application request budget.').toEqual([]);
  await info.attach('actual-sdk-transport-observation',{body:JSON.stringify({externalHttpRequests:observed.external.length,webSockets:observed.sockets.length,pageErrors:observed.errors.length,browserApiRequests:observed.counts.apiRequests,rateLimitedRequests:observed.rateLimits.length,publishedEventKinds:observed.events.map(event=>event.kind),keyPackageIdentities:new Set(observed.events.filter(event=>event.kind===30443).map(event=>event.pubkey)).size},null,2),contentType:'application/json'});
}

test('hackathon demo entry opens its password form',async({page})=>{
  await page.goto('/');
  await page.getByRole('button',{name:'Hackathon demo',exact:true}).click();
  await expect(page.getByLabel('Demo password',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enter hackathon demo',exact:true})).toBeVisible();
});

test('actual Marmot demo decrypts updates replies and paid notices and survives reload',async({page},info)=>{
  const observed=observe(page);await signIn(page,true);const before=await demoView(page);
  expect(before.invoice.status).toBe('open');expect(before.invoice.settlementMode).toBe('simulation');await expect(page.getByText('Marmot Field Lab (fictional)',{exact:true})).toBeVisible();
  const receipt=page.getByRole('button',{name:'Send receipt notice',exact:true});await expect(receipt).toBeDisabled();
  await prepare(page);
  const merchant=page.getByRole('log',{name:'Merchant decrypted messages',exact:true}),customer=page.getByRole('log',{name:'Customer decrypted messages',exact:true});
  expect(new Set(observed.events.filter(event=>event.kind===30443).map(event=>event.pubkey)).size).toBe(2);
  await page.getByRole('button',{name:'Send private update',exact:true}).click();await expect(customer.getByText(text.update,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Acknowledge update',exact:true}).click();await expect(merchant.getByText(text.acknowledge,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Request review',exact:true}).click();await expect(merchant.getByText(text.review,{exact:true})).toBeVisible();
  await expect(receipt).toBeDisabled();await page.getByRole('button',{name:'Simulate payment',exact:true}).click();
  await expect(page.getByText('Simulated payment recorded',{exact:true})).toBeVisible();await expect(receipt).toBeEnabled();
  await receipt.click();await expect(customer.getByText(text['receipt-notice'],{exact:true})).toBeVisible();
  const after=await demoView(page);expect(after.invoice.status).toBe('paid');expect(after.invoice.settlementMode).toBe('simulation');expect(after.invoice.id).toBe(before.invoice.id);
  const plaintext=JSON.stringify(observed.events);
  for(const value of [...Object.values(text),before.invoice.title,before.invoice.customerName,before.invoice.items[0].description])expect(plaintext.includes(value),`A private envelope must not include application plaintext: ${value}`).toBe(false);
  expect(observed.events.filter(event=>event.kind===445).length).toBeGreaterThanOrEqual(4);
  await page.screenshot({path:info.outputPath('actual-marmot-demo-desktop.png'),fullPage:true});
  await page.reload();await expect(page.getByRole('heading',{name:'A private conversation. A clear paper trail.',exact:true})).toBeVisible();await prepare(page);
  for(const value of Object.values(text)){await expect(merchant.getByText(value,{exact:true})).toHaveCount(1);await expect(customer.getByText(value,{exact:true})).toHaveCount(1);}
  expect((await demoView(page)).invoice.status).toBe('paid');
  await page.getByRole('button',{name:'Refresh messages',exact:true}).click();
  for(const value of Object.values(text)){await expect(merchant.getByText(value,{exact:true})).toHaveCount(1);await expect(customer.getByText(value,{exact:true})).toHaveCount(1);}
  await networkEvidence(info,observed);
});

test('new browser demo logins own distinct isolated fictional workspaces',async({page,browser},info)=>{
  const observed=observe(page);await signIn(page);const first=await demoView(page),firstSession=await(await page.request.get('/api/session')).json() as {accountId:string};
  const secondContext=await browser.newContext({baseURL:origin});await secondContext.addCookies([{name:'ql_fixture_client',value:'254',url:origin}]);const other=await secondContext.newPage();const otherObserved=observe(other);
  try{
    await signIn(other);const second=await demoView(other),secondSession=await(await other.request.get('/api/session')).json() as {accountId:string};
    expect(secondSession.accountId).not.toBe(firstSession.accountId);expect(second.invoice.id).not.toBe(first.invoice.id);expect(second.checkoutToken).not.toBe(first.checkoutToken);
    expect((await other.request.get(`/api/invoices/${first.invoice.id}`)).status()).toBe(404);
    expect((await page.request.get(`/api/invoices/${second.invoice.id}`)).status()).toBe(404);
    const firstDashboard=await(await page.request.get('/api/dashboard')).json() as {invoices:Invoice[]},secondDashboard=await(await other.request.get('/api/dashboard')).json() as {invoices:Invoice[]};
    expect(firstDashboard.invoices.map(invoice=>invoice.id)).toEqual([first.invoice.id]);expect(secondDashboard.invoices.map(invoice=>invoice.id)).toEqual([second.invoice.id]);
    expect((await page.request.get('/api/account/connections')).status()).toBe(403);expect((await other.request.get('/api/account/api-keys')).status()).toBe(403);
    await networkEvidence(info,otherObserved);
  }finally{await secondContext.close();}
  await networkEvidence(info,observed);
});

test('actual Marmot demo works on mobile with keyboard role tabs and no overflow',async({page},info)=>{
  const observed=observe(page);await page.setViewportSize({width:390,height:844});await signIn(page);await prepare(page);
  await page.getByRole('button',{name:'Send private update',exact:true}).click();
  const merchantTab=page.getByRole('tab',{name:'Merchant',exact:true}),customerTab=page.getByRole('tab',{name:'Customer',exact:true});
  await merchantTab.focus();await page.keyboard.press('ArrowRight');await expect(customerTab).toBeFocused();await expect(customerTab).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('log',{name:'Customer decrypted messages',exact:true}).getByText(text.update,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Acknowledge update',exact:true}).click();await customerTab.focus();await page.keyboard.press('ArrowLeft');await expect(merchantTab).toBeFocused();
  await expect(page.getByRole('log',{name:'Merchant decrypted messages',exact:true}).getByText(text.acknowledge,{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:info.outputPath('actual-marmot-demo-mobile.png'),fullPage:true});
  await networkEvidence(info,observed);
});
