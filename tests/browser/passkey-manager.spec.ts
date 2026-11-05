import {test,expect,type Page} from '@playwright/test';
async function signup(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeEnabled();
}
test('a password-manager request can be cancelled even when an extension ignores its abort signal',async({page})=>{
  await page.addInitScript(()=>{navigator.credentials.create=()=>new Promise(()=>{});});
  let verifies=0;page.on('request',request=>{if(request.url().endsWith('/api/auth/passkey/verify'))verifies++;});
  await signup(page);await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('password manager');
  await page.getByRole('button',{name:'Cancel passkey request',exact:true}).click();
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeEnabled();
  await expect(page.getByRole('alert')).toContainText('cancelled');expect(verifies).toBe(0);
});
test('password-manager continuation invokes WebAuthn from the click with unrestricted attachment and required verification',async({page})=>{
  await page.addInitScript(()=>{(window as any).__calls=[];navigator.credentials.create=async options=>{
    (window as any).__calls.push({active:navigator.userActivation.isActive,selection:options?.publicKey?.authenticatorSelection,mediation:(options as any)?.mediation});
    throw new DOMException('Synthetic provider cancellation','NotAllowedError');
  };});
  await signup(page);await page.getByRole('button',{name:'Use a password manager',exact:true}).click();
  expect(await page.evaluate(()=>(window as any).__calls)).toEqual([]);
  await page.getByRole('button',{name:'Open password manager',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Bitwarden');
  expect(await page.evaluate(()=>(window as any).__calls)).toEqual([{active:true,selection:{residentKey:'required',userVerification:'required',requireResidentKey:true}}]);
});
test('stalled options fetch becomes an actionable error and restores the form',async({page})=>{
  await page.route('**/api/auth/passkey/options',async()=>{});await signup(page);await page.clock.install();
  await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Preparing');await page.clock.fastForward(16_000);
  await expect(page.getByRole('alert')).toContainText('connection');
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeEnabled();
});

test('stalled sign-in configuration shows a retryable error instead of leaving disabled buttons',async({page})=>{
  await page.route('**/api/auth/config',async()=>{});await page.clock.install();await page.goto('/');
  await expect(page.getByRole('status')).toContainText('Checking sign-in options');await page.clock.fastForward(16_000);
  await expect(page.getByRole('alert')).toContainText('connection');await expect(page.getByRole('button',{name:'Try again',exact:true})).toBeVisible();
});
async function virtualPasskey(page:Page){
  const cdp=await page.context().newCDPSession(page);await cdp.send('WebAuthn.enable');
  const {authenticatorId}=await cdp.send('WebAuthn.addVirtualAuthenticator',{options:{protocol:'ctap2',transport:'internal',hasResidentKey:true,hasUserVerification:true,isUserVerified:true,automaticPresenceSimulation:true}});
  return {remove:()=>cdp.send('WebAuthn.removeVirtualAuthenticator',{authenticatorId})};
}
test('linking a backup passkey can cancel a manager that ignores its abort signal',async({page})=>{
  await virtualPasskey(page);await signup(page);await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();await page.goto('/account');
  await expect(page.getByRole('button',{name:'Add another passkey',exact:true})).toBeEnabled();
  await page.evaluate(()=>{navigator.credentials.create=()=>new Promise(()=>{});});
  await page.getByRole('button',{name:'Add another passkey',exact:true}).click();
  await page.getByRole('button',{name:'Cancel passkey request',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  await expect(page.getByRole('button',{name:'Add another passkey',exact:true})).toBeEnabled();
  const account=await(await page.request.get('/api/auth/account')).json();expect(account.credentials).toHaveLength(1);
});
test('an unresponsive manager times out even if it ignores the browser timeout and abort signal',async({page})=>{
  await page.addInitScript(()=>{navigator.credentials.create=()=>new Promise(()=>{});});await signup(page);await page.clock.install();
  await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();await expect(page.getByRole('status')).toContainText('Waiting for your password manager');
  await page.clock.fastForward(106_000);await expect(page.getByRole('alert')).toContainText('Bitwarden');
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeEnabled();
});
test('a late extension response after cancellation is never sent for verification',async({page})=>{
  await page.addInitScript(()=>{navigator.credentials.create=()=>new Promise(resolve=>{(window as any).__lateCredential=resolve;});});
  let verifies=0;page.on('request',request=>{if(request.url().endsWith('/api/auth/passkey/verify'))verifies++;});
  await signup(page);await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Waiting for your password manager');await page.getByRole('button',{name:'Cancel passkey request',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('cancelled');
  await page.evaluate(()=>{(window as any).__lateCredential({id:'AQ',rawId:new Uint8Array([1]).buffer,type:'public-key',response:{clientDataJSON:new Uint8Array([1]).buffer,attestationObject:new Uint8Array([1]).buffer},getClientExtensionResults:()=>({})});});
  await expect(page.getByRole('button',{name:'Create account with a passkey',exact:true})).toBeEnabled();
  expect(verifies).toBe(0);expect((await(await page.request.get('/api/session')).json()).authenticated).toBe(false);
});

test('a stalled account readback after linking a passkey restores controls with a confirmation error',async({page})=>{
  const first=await virtualPasskey(page);await signup(page);await page.getByRole('button',{name:'Create account with a passkey',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();await page.goto('/account');
  await expect(page.getByRole('button',{name:'Add another passkey',exact:true})).toBeEnabled();
  await first.remove();await virtualPasskey(page);let readback=false;
  await page.route('**/api/auth/account',async()=>{readback=true;});await page.clock.install();
  await page.getByRole('button',{name:'Add another passkey',exact:true}).click();await expect.poll(()=>readback).toBe(true);
  await page.clock.fastForward(16_000);await expect(page.getByRole('alert')).toContainText('confirmation');
  await expect(page.getByRole('button',{name:'Add another passkey',exact:true})).toBeEnabled();
});
