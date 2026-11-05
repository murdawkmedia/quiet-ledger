import {test,expect,type Page} from '@playwright/test';
import {finalizeEvent,getPublicKey,type EventTemplate} from 'nostr-tools/pure';

const origin='http://localhost:4333';
const instructions='FICTIONAL receiving details: browser-bank@example.invalid. Verify independently.';
const privateLabel='Private fictional bank workspace label';

async function syntheticSigner(page:Page,scalar:number){
  // Known public test scalar, never an actual signer/wallet key.
  const key=new Uint8Array(32);key[31]=scalar;const pubkey=getPublicKey(key);
  await page.exposeFunction('__quietSyntheticConnectionSign',(event:EventTemplate)=>finalizeEvent(event,key));
  await page.addInitScript(({pubkey})=>{window.nostr={getPublicKey:async()=>pubkey,signEvent:async event=>(window as any).__quietSyntheticConnectionSign(event)};},{pubkey});
}
async function signup(page:Page,scalar:number){
  await syntheticSigner(page,scalar);await page.goto('/');
  await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Private display name (optional)',{exact:true}).fill(`Fictional connection browser account ${scalar}`);
  await page.getByRole('button',{name:'Create account with Nostr',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  return (await page.request.get('/api/session')).json();
}
async function saveBank(page:Page,label=privateLabel){
  await page.goto('/integrations');await page.getByRole('button',{name:'Connect Bank / Interac / Wise instructions',exact:true}).click();
  await page.getByLabel('Connection label (optional)',{exact:true}).fill(label);
  await page.getByLabel('Receiving method',{exact:true}).selectOption('interac');
  await page.getByLabel('Payee / recipient name',{exact:true}).fill('Fictional browser recipient');
  await page.getByLabel('Receiving instructions',{exact:true}).fill(instructions);
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/connections'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Save receiving instructions',exact:true}).click();
  const saved=await response;expect(saved.status()).toBe(201);const result=await saved.json();
  await expect(page.getByText('Saved instructions · manual confirmation',{exact:true})).toBeVisible();
  expect(JSON.stringify(result)).not.toContain(instructions);return result.connection;
}

test('saved bank setup survives sign-in and serves instructions from public checkout without settling an invoice',async({page,browser},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const relaySockets:string[]=[];page.on('websocket',socket=>relaySockets.push(socket.url()));
  const first=await signup(page,17),connection=await saveBank(page);
  await page.getByRole('button',{name:'Leave workspace',exact:true}).click();
  await page.getByRole('button',{name:'Continue with Nostr',exact:true}).click();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  await page.goto('/integrations');await page.reload();await expect(page.getByText(privateLabel,{exact:true})).toBeVisible();
  expect((await(await page.request.get('/api/session')).json()).accountId).toBe(first.accountId);
  const list=await(await page.request.get('/api/account/connections')).json();expect(list.connections[0].id).toBe(connection.id);expect(JSON.stringify(list)).not.toContain(instructions);
  await page.goto('/invoices/new');await page.getByLabel('Customer name',{exact:true}).fill('Fictional connection customer');await page.getByLabel('Invoice title',{exact:true}).fill('Fictional saved bank invoice');await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional service');await page.getByLabel('Item 1 unit price',{exact:true}).fill('1.25');
  const invoiceResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/invoices'&&response.request().method()==='POST');await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  const created=await invoiceResponse;expect(created.status()).toBe(201);const invoice=await created.json();
  const publicContext=await browser.newContext(),payer=await publicContext.newPage();
  try{
    await payer.goto(`${origin}/pay/${invoice.token}`);await expect(payer.getByRole('heading',{name:'Choose how to pay.',exact:true})).toBeVisible();
    await payer.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('interac');
    const select=payer.getByRole('combobox',{name:'Payment connection',exact:true});
    if(await select.count()){await select.selectOption(connection.id);await expect(select).toContainText('Bank / Interac / Wise instructions');}
    await expect(payer.locator('body')).not.toContainText(privateLabel);
    const requestResponse=payer.waitForResponse(response=>response.url().includes('/receiving')&&response.request().method()==='POST');await payer.getByRole('button',{name:'Continue with live payment',exact:true}).click();
    const received=await requestResponse;expect(received.status()).toBe(201);const {request}=await received.json();expect(request.adapterId).toBe(connection.id);expect(request.status).toBe('awaiting_payment');
    await expect(payer).toHaveURL(new RegExp(`/receive/${request.token}$`));await expect(payer.getByText(instructions,{exact:true})).toBeVisible();
    await expect(payer.locator('body')).not.toContainText(privateLabel);await expect(payer.getByText('Fictional browser recipient',{exact:true})).toBeVisible();
    await payer.getByRole('button',{name:'Check payment',exact:true}).click();await expect(payer.getByText('Awaiting owner review',{exact:true})).toBeVisible();
    await expect(payer.getByRole('heading',{name:'Payment verified.',exact:true})).toHaveCount(0);
    const stillOpen=await(await page.request.get(`/api/invoices/${invoice.id}`)).json();expect(stillOpen.status).toBe('open');
    await payer.setViewportSize({width:390,height:844});expect(await payer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await payer.screenshot({path:info.outputPath('fictional-saved-bank-public-mobile.png'),fullPage:true,animations:'disabled'});
  }finally{await publicContext.close();}
  await page.goto('/integrations');await page.screenshot({path:info.outputPath('fictional-persisted-bank-connection.png'),fullPage:true,animations:'disabled'});
  expect((await(await page.request.get('/_fixture/provider-reads')).json()).reads).toBe(0);expect(relaySockets).toEqual([]);expect(errors).toEqual([]);
});

test('a second real account cannot list recheck or disconnect the first account connection',async({page,browser})=>{
  await signup(page,18);const connection=await saveBank(page,'Fictional isolation-only bank');
  const otherContext=await browser.newContext({baseURL:origin}),other=await otherContext.newPage();
  try{
    await signup(other,19);await other.goto('/integrations');await expect(other.getByText('No saved connections yet.',{exact:true})).toBeVisible();await expect(other.locator('body')).not.toContainText('Fictional isolation-only bank');
    const list=await(await other.request.get('/api/account/connections')).json();expect(list.connections).toEqual([]);expect(JSON.stringify(list)).not.toContain(instructions);
    const session=await(await other.request.get('/api/session')).json();
    expect((await other.request.post(`/api/account/connections/${connection.id}/check`,{headers:{'X-CSRF-Token':session.csrfToken},data:{}})).status()).toBe(404);
    expect((await other.request.delete(`/api/account/connections/${connection.id}`,{headers:{'X-CSRF-Token':session.csrfToken}})).status()).toBe(404);
    await page.reload();await expect(page.getByText('Fictional isolation-only bank',{exact:true})).toBeVisible();
  }finally{await otherContext.close();}
});

test('Stripe API credentials verify through read-only fixture and can be rechecked then disconnected',async({page})=>{
  await signup(page,20);await page.goto('/integrations');await page.getByRole('button',{name:'Connect Stripe',exact:true}).click();
  const secret='sk_test_FICTIONAL_BROWSER_PRIVATE_KEY_83694';
  await page.getByLabel('Connection label (optional)',{exact:true}).fill('Fictional Stripe browser shop');await page.getByLabel('Environment',{exact:true}).selectOption('test');
  const input=page.getByLabel('Stripe secret/restricted key',{exact:true});await expect(input).toHaveAttribute('type','password');await input.fill(secret);await page.getByLabel('Stripe account ID',{exact:true}).fill('acct_FICTIONALBROWSER');await page.getByLabel('Merchant country',{exact:true}).fill('CA');
  const savedResponse=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/connections'&&response.request().method()==='POST');await page.getByRole('button',{name:'Verify & save connection',exact:true}).click();
  const response=await savedResponse;expect(response.status()).toBe(201);expect(JSON.stringify(await response.json())).not.toContain(secret);
  await expect(page.getByText('Verified connection',{exact:true})).toBeVisible();expect(await page.locator('input[type="password"]').count()).toBe(0);
  await page.getByRole('button',{name:'Recheck connection',exact:true}).click();await expect(page.getByText('Connection checked. Payment settlement still needs verification.',{exact:true})).toBeVisible();
  expect((await(await page.request.get('/_fixture/provider-reads')).json()).reads).toBe(2);
  await page.reload();await expect(page.getByText('Fictional Stripe browser shop',{exact:true})).toBeVisible();expect(JSON.stringify(await(await page.request.get('/api/account/connections')).json())).not.toContain(secret);
  await page.getByRole('button',{name:'Connect Stripe',exact:true}).click();await expect(input).toHaveValue('');await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByText('Existing requests at the provider are not cancelled.',{exact:false})).toBeVisible();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();await expect(page.getByText('No saved connections yet.',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByText('No saved connections yet.',{exact:true})).toBeVisible();expect((await(await page.request.get('/api/account/connections')).json()).connections).toEqual([]);
  expect(await page.evaluate(()=>Object.values(localStorage).join('')+Object.values(sessionStorage).join(''))).not.toContain(secret);
});
