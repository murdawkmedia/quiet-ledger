import {test,expect,type Page} from '@playwright/test';
import {finalizeEvent,getPublicKey,type EventTemplate} from 'nostr-tools/pure';
import {randomUUID} from 'node:crypto';

async function virtualPasskey(page:Page){
  const cdp=await page.context().newCDPSession(page);await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  return {close:async()=>{await cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId}).catch(()=>{});await cdp.detach().catch(()=>{});}};
}
async function syntheticSigner(page:Page,scalar:number){
  // Public test scalar; no actual wallet/signing material is opened or generated.
  const key=new Uint8Array(32);key[31]=scalar;const pubkey=getPublicKey(key);
  await page.exposeFunction('__quietSyntheticNostrSign',(event:EventTemplate)=>finalizeEvent(event,key));
  await page.addInitScript(({pubkey})=>{window.nostr={getPublicKey:async()=>pubkey,signEvent:async event=>(window as any).__quietSyntheticNostrSign(event)};},{pubkey});
}
async function createSyntheticInvoice(page:Page,title:string){
  const session=await(await page.request.get('/api/session')).json();
  const response=await page.request.post('/api/invoices',{headers:{'X-CSRF-Token':session.csrfToken,'Idempotency-Key':randomUUID()},data:{customerName:'Fictional hosted account customer',title,currency:'CAD',items:[{description:'Synthetic account-isolation fixture',quantity:1,unitAmount:1200}]}});
  expect(response.status()).toBe(201);return response.json();
}

test('hosted entry offers passkeys and Nostr with explicit signup and privacy limits',async({page},info)=>{
  await page.goto('/');
  await expect(page.getByRole('heading',{name:'Sign in without a password.',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with a passkey',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with Nostr',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Enter demo workspace',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'I have an owner token',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Start with a private workspace.',exact:true})).toBeVisible();
  await expect(page.getByLabel('Private display name (optional)',{exact:true})).toHaveAttribute('maxlength','80');
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create account with Nostr',exact:true})).toBeVisible();
  expect(await page.locator('input[type="password"],input[type="email"]').count()).toBe(0);
  await expect(page.getByText('The hosting operator can decrypt your records.',{exact:false})).toBeVisible();
  await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('hosted-account-entry-mobile.png'),fullPage:true});
});

test('missing Nostr signer stays recoverable without asking for a private key',async({page})=>{
  await page.goto('/');await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await page.getByRole('button',{name:'Create account with Nostr',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Open this page in a browser with a Nostr signer');
  await expect(page.getByRole('button',{name:'Create account with Nostr',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeEnabled();
  expect(await page.locator('input[type="password"],textarea').count()).toBe(0);
  await page.getByRole('button',{name:'Already have an account? Sign in',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Sign in without a password.',exact:true})).toBeVisible();await expect(page.getByRole('alert')).toHaveCount(0);
});

test('real passkey signup login and linked credential keep the private workspace after refresh',async({page},info)=>{
  const authenticator=await virtualPasskey(page),errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  let backup:Awaited<ReturnType<typeof virtualPasskey>>|undefined;
  try{
    await page.goto('/');await page.getByRole('button',{name:'Create an account',exact:true}).click();
    await page.getByLabel('Private display name (optional)',{exact:true}).fill('Fictional passkey browser account');
    await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();
    await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
    const first=await(await page.request.get('/api/session')).json();expect(first.authenticated).toBe(true);expect(first.authMode).toBe('hosted');
    const invoice=await createSyntheticInvoice(page,'Synthetic passkey-only workspace invoice');
    await page.goto('/account');await expect(page.getByRole('heading',{name:'A private way back in.',exact:true})).toBeVisible();
    await expect(page.getByRole('heading',{name:'Fictional passkey browser account',exact:true})).toBeVisible();
    // Registration excludes a credential already on the same authenticator.
    // A backup means a second authenticator, not re-registering the first one.
    await authenticator.close();backup=await virtualPasskey(page);
    await page.getByRole('button',{name:'Add another passkey',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('Another passkey is linked');
    const account=await(await page.request.get('/api/auth/account')).json();expect(account.credentials.filter((credential:any)=>credential.type==='passkey').length).toBe(2);
    await page.getByRole('button',{name:'Leave workspace',exact:true}).click();
    await page.getByRole('button',{name:'Continue with a passkey',exact:true}).click();
    await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
    await page.reload();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
    expect((await(await page.request.get('/api/session')).json()).accountId).toBe(first.accountId);
    expect((await page.request.get(`/api/invoices/${invoice.id}`)).status()).toBe(200);
    await page.setViewportSize({width:390,height:844});await page.goto('/account');
    await expect(page.getByRole('heading',{name:'A private way back in.',exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:info.outputPath('fictional-passkey-account-mobile.png'),fullPage:true});expect(errors).toEqual([]);
  }finally{await backup?.close();await authenticator.close();}
});

test('real Nostr signup relogin and two-account isolation never publish to a relay',async({page,browser},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await syntheticSigner(page,2);
  const outbound:string[]=[];page.on('websocket',socket=>outbound.push(socket.url()));
  await page.goto('/');await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Private display name (optional)',{exact:true}).fill('Fictional Nostr browser account');
  await page.getByRole('button',{name:'Create account with Nostr',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  const first=await(await page.request.get('/api/session')).json(),invoice=await createSyntheticInvoice(page,'Synthetic Nostr account private invoice');
  await page.getByRole('button',{name:'Leave workspace',exact:true}).click();await page.getByRole('button',{name:'Continue with Nostr',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();expect((await(await page.request.get('/api/session')).json()).accountId).toBe(first.accountId);
  await page.reload();await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  const context=await browser.newContext(),other=await context.newPage();
  try{
    await syntheticSigner(other,3);await other.goto('http://localhost:4332/');await other.getByRole('button',{name:'Create an account',exact:true}).click();
    await other.getByLabel('Private display name (optional)',{exact:true}).fill('Fictional second Nostr account');await other.getByRole('button',{name:'Create account with Nostr',exact:true}).click();
    await expect(other.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
    const second=await(await other.request.get('http://localhost:4332/api/session')).json();expect(second.accountId).not.toBe(first.accountId);
    expect((await other.request.get(`http://localhost:4332/api/invoices/${invoice.id}`)).status()).toBe(404);
    const dashboard=await(await other.request.get('http://localhost:4332/api/dashboard')).json();expect(dashboard.invoices).toHaveLength(0);
    const exported=await(await other.request.get('http://localhost:4332/api/evidence/export')).json();expect(exported.invoices).toHaveLength(0);
  }finally{await context.close();}
  await page.goto('/account');await expect(page.getByRole('heading',{name:'Fictional Nostr browser account',exact:true})).toBeVisible();
  const keys=page.getByRole('heading',{name:'Website and agent API keys',exact:true});await expect(keys).toBeVisible();
  await expect(page.getByRole('checkbox',{name:'Manually confirm payments',exact:false})).not.toBeChecked();
  await expect(page.getByRole('checkbox',{name:'Export workspace records',exact:false})).not.toBeChecked();
  await page.getByLabel('Key label (optional)',{exact:true}).fill('Fictional website API test');
  const result=page.waitForResponse(response=>response.url().endsWith('/api/account/api-keys')&&response.request().method()==='POST');await page.getByRole('button',{name:'Create API key',exact:true}).click();
  const created=await(await result).json(),token=created.key.token;
  await expect(page.getByLabel('New API token',{exact:true})).toHaveAttribute('type','password');
  await page.getByRole('button',{name:'Show API token',exact:true}).click();await expect(page.getByLabel('New API token',{exact:true})).toHaveAttribute('type','text');
  expect((await page.getByLabel('New API token',{exact:true}).inputValue()).length>=32).toBe(true);
  const apiRead=await page.request.get('/api/v1/invoices',{headers:{Authorization:'Bearer '+token}});expect(apiRead.status()).toBe(200);expect((await apiRead.json()).invoices.some((row:any)=>row.id===invoice.id)).toBe(true);
  await page.getByRole('button',{name:'Done — hide this token',exact:true}).click();await page.reload();
  await expect(page.getByLabel('New API token',{exact:true})).toHaveCount(0);
  const list=await(await page.request.get('/api/account/api-keys')).json();expect(!JSON.stringify(list).includes(token)).toBe(true);
  const keyRow=page.locator('.account-key-list article').filter({hasText:'Fictional website API test'});await keyRow.getByRole('button',{name:'Revoke key',exact:true}).click();await expect(keyRow.getByText('Revoked',{exact:true})).toBeVisible();
  expect((await page.request.get('/api/v1/invoices',{headers:{Authorization:'Bearer '+token}})).status()).toBe(401);
  await page.evaluate(()=>window.scrollTo(0,0));await page.waitForFunction(()=>window.scrollY===0);
  await page.screenshot({path:info.outputPath('fictional-nostr-account-desktop.png'),fullPage:true});expect(outbound).toEqual([]);expect(errors).toEqual([]);
});
