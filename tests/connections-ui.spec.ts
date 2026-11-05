import {test,expect,type Page} from '@playwright/test';

// Public synthetic values only. No provider account or network is contacted.
const providers=[{
  id:'synthetic-processor',name:'Fictional processor',description:'Connect an existing eligible merchant account.',
  fields:[{key:'endpoint',label:'Service URL',type:'url',required:true,help:'Use your existing HTTPS service.'},{key:'token',label:'Restricted API token',type:'password',required:true},{key:'region',label:'Region',type:'select',required:true,options:[{value:'ca',label:'Canada'},{value:'us',label:'United States'}]}],
  walletOptionIds:['stripe'],modes:['live','test'],verification:'automatic',methods:['card'],
},{id:'synthetic-bank',name:'Saved bank instructions',description:'Save receiving details for your existing bank, Wise or Tangerine account. Confirm payments independently.',fields:[{key:'instructions',label:'Payment instructions',type:'textarea',required:true},{key:'reference',label:'Reference label',type:'text'}],walletOptionIds:['manual'],modes:['live'],verification:'manual',methods:['bank']},
{id:'synthetic-review-provider',name:'Fictional reviewed provider',description:'API access is checked. Merchant identity requires manual review.',fields:[{key:'clientSecret',label:'Client secret',type:'password',required:true}],walletOptionIds:['paypal'],modes:['live','test'],verification:'manual',methods:['paypal']}];
const verified={id:'connection-fixture-1',provider:'synthetic-processor',label:'Fictional shop',mode:'live',status:'connected',detail:'Merchant metadata verified.',methods:['card'],createdAt:'2026-11-05T17:00:00.000Z',verifiedAt:'2026-11-05T17:00:00.000Z'};
async function serve(page:Page,connections:unknown[]=[],options:{failLoad?:boolean;failSave?:boolean}={}){
  const calls:{method:string;path:string;body:unknown;csrf:string|undefined}[]=[];
  let current=[...connections],failed=false;
  await page.route('**/api/account/connections**',async route=>{
    const request=route.request(),method=request.method(),path=new URL(request.url()).pathname;
    calls.push({method,path,body:request.postDataJSON(),csrf:request.headers()['x-csrf-token']});
    if(method==='GET'){
      if(options.failLoad&&!failed){failed=true;await route.fulfill({status:503,json:{error:'Do not reveal synthetic-secret-canary'}});return;}
      await route.fulfill({json:{providers,connections:current}});return;
    }
    if(method==='POST'&&path.endsWith('/check')){await route.fulfill({json:{connection:{...verified,detail:'Rechecked merchant metadata.'}}});return;}
    if(method==='DELETE'){current=[];await route.fulfill({json:{disconnected:true}});return;}
    if(options.failSave){await route.fulfill({status:502,json:{error:'Provider returned synthetic-secret-canary'}});return;}
    const input=request.postDataJSON();const connection=input.provider==='synthetic-bank'?{...verified,id:'connection-fixture-2',provider:input.provider,label:input.label||'Bank instructions',status:'manual',detail:'Saved instructions only.',methods:['bank']}:verified;
    current=[...current,connection];await route.fulfill({status:201,json:{connection}});
  });
  await page.goto('/tests/fixtures/connections-ui.html');
  return calls;
}

test('builds credential forms from server metadata and saves without browser persistence',async({page})=>{
  const calls=await serve(page);
  await expect(page.getByRole('heading',{name:'Connect once. Come back ready.',exact:true})).toBeVisible();
  await expect(page.getByText('No saved connections yet.',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();
  await expect(page.getByLabel('Environment',{exact:true})).toHaveValue('live');
  const secret=page.getByLabel('Restricted API token',{exact:true});
  await expect(secret).toHaveAttribute('type','password');await expect(secret).toHaveAttribute('autocomplete','off');await expect(secret).toHaveAttribute('spellcheck','false');
  await page.getByLabel('Connection label (optional)',{exact:true}).fill('Fictional shop');
  await page.getByLabel('Service URL',{exact:true}).fill('https://fictional.example');await secret.fill('synthetic-secret-canary');
  await page.getByLabel('Region',{exact:true}).selectOption('ca');
  await page.getByRole('button',{name:'Verify & save connection',exact:true}).click();
  await expect(page.getByText('Verified connection',{exact:true})).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Connection saved');
  expect(calls.find(call=>call.method==='POST')).toEqual({method:'POST',path:'/api/account/connections',csrf:'synthetic-connections-csrf',body:{provider:'synthetic-processor',label:'Fictional shop',mode:'live',fields:{endpoint:'https://fictional.example',token:'synthetic-secret-canary',region:'ca'}}});
  expect(await page.locator('input[type="password"]').count()).toBe(0);
  expect(await page.evaluate(()=>Object.keys(localStorage).length+Object.keys(sessionStorage).length)).toBe(0);
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();await expect(secret).toHaveValue('');
  await page.reload();await expect(page.getByText('Fictional shop',{exact:true})).toBeVisible();
});

test('manual instructions stay distinct from account verification and paid receipts',async({page})=>{
  await serve(page);await page.getByRole('button',{name:'Connect Saved bank instructions',exact:true}).click();
  await expect(page.getByLabel('Environment',{exact:true})).toHaveCount(0);
  await page.getByLabel('Payment instructions',{exact:true}).fill('Fictional receiving instructions; independently confirm settlement.');
  await page.getByRole('button',{name:'Save receiving instructions',exact:true}).click();
  await expect(page.getByText('Saved instructions · manual confirmation',{exact:true})).toBeVisible();
  await expect(page.getByText('A saved connection does not confirm a payment.',{exact:false})).toBeVisible();
  await expect(page.getByRole('link',{name:'Manage API keys',exact:false})).toHaveAttribute('href','/account');
});

test('load failure is generic and retry recovers without exposing server details',async({page})=>{
  await serve(page,[],{failLoad:true});await expect(page.getByRole('alert')).toContainText('Your saved connections could not be loaded.');
  await expect(page.locator('body')).not.toContainText('synthetic-secret-canary');
  await page.getByRole('button',{name:'Try again',exact:true}).click();await expect(page.getByText('No saved connections yet.',{exact:true})).toBeVisible();
});

test('recheck and explicit disconnect preserve saved state until successful deletion',async({page})=>{
  const calls=await serve(page,[verified]);
  await page.getByRole('button',{name:'Recheck connection',exact:true}).click();await expect(page.getByRole('status')).toContainText('Connection checked.');
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await expect(page.getByText('Existing requests at the provider are not cancelled.',{exact:false})).toBeVisible();
  expect(calls.filter(call=>call.method==='DELETE')).toHaveLength(0);
  await page.getByRole('button',{name:'Keep connection',exact:true}).click();await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();
  await expect(page.getByText('No saved connections yet.',{exact:true})).toBeVisible();
  expect(calls.filter(call=>call.method==='DELETE')).toEqual([{method:'DELETE',path:'/api/account/connections/connection-fixture-1',body:null,csrf:'synthetic-connections-csrf'}]);
});

test('failed save keeps exact retry identity and never renders credential echoes',async({page})=>{
  await serve(page,[],{failSave:true});const keys:string[]=[];
  page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/account/connections')keys.push(request.headers()['idempotency-key']);});
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();
  await page.getByLabel('Service URL',{exact:true}).fill('https://fictional.example');await page.getByLabel('Restricted API token',{exact:true}).fill('synthetic-secret-canary');await page.getByLabel('Region',{exact:true}).selectOption('ca');
  const save=page.getByRole('button',{name:'Verify & save connection',exact:true});await save.click();await expect(page.getByRole('alert')).toContainText('The connection could not be saved.');await expect(page.locator('body')).not.toContainText('synthetic-secret-canary');
  await save.click();await expect.poll(()=>keys.length).toBe(2);expect(keys[0]).toBeTruthy();expect(keys[1]).toBe(keys[0]);
  await page.getByLabel('Environment',{exact:true}).selectOption('test');await save.click();await expect.poll(()=>keys.length).toBe(3);expect(keys[2]).not.toBe(keys[1]);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('button',{name:'Connect Fictional processor',exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();await expect(page.getByLabel('Restricted API token',{exact:true})).toHaveValue('');
});

test('mobile layout and keyboard can open and cancel a connection without overflow',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await serve(page,[{...verified,label:'Fictional shop '.repeat(8)}]);
  const connect=page.getByRole('button',{name:'Connect Fictional processor',exact:true});await connect.focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('heading',{name:'Fictional processor',exact:true,level:2})).toBeFocused();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await expect(connect).toBeFocused();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(await page.locator('.connections-intro>div').evaluate(element=>element.getBoundingClientRect().width)).toBeGreaterThan(180);
  await page.screenshot({path:info.outputPath('fictional-connections-mobile.png'),fullPage:true});
});

test('hosted payment methods link to saved setup and match only the actual provider',async({page})=>{
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const adapters=[{id:'saved-immutable-id',mode:'live',configured:true,verified:true,methods:['card']}];
    const body=path==='/api/account/connections'?{providers,connections:[verified]}:path==='/api/payment-methods'?{adapters,defaultMode:'live',walletOptions:[{id:'stripe',name:'Stripe',methods:['card']},{id:'revolut',name:'Revolut',methods:['card']}]}:path==='/api/payment-reports'?{reports:[]}:path==='/api/receiving'?{requests:[],adapters}:{error:'Not configured in UI fixture'};
    await route.fulfill({status:path==='/api/collateral'||path==='/api/ark'?503:200,json:body});
  });
  await page.goto('/tests/fixtures/connections-ui.html?screen=payment-methods');
  await expect(page.getByRole('heading',{name:'Your ways to get paid.',exact:true})).toBeVisible();
  const stripe=page.locator('.wallet-option').filter({has:page.getByRole('heading',{name:'Stripe',exact:true})});
  const revolut=page.locator('.wallet-option').filter({has:page.getByRole('heading',{name:'Revolut',exact:true})});
  await expect(stripe).toContainText('Verified connection · live');await expect(revolut).not.toContainText('Verified connection');
  await expect(page.locator('body')).not.toContainText('Setup belongs in the private server configuration.');
  await expect(page.getByRole('link',{name:'Manage saved connections',exact:false}).first()).toHaveAttribute('href','/integrations');
  await expect(page.getByRole('link',{name:'Manage API keys',exact:false})).toHaveAttribute('href','/account');
});

test('pending save blocks duplicate actions and check or disconnect failures remain retryable',async({page})=>{
  await serve(page,[verified]);let release:()=>void=()=>{};
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/account/connections',async route=>{
    if(route.request().method()!=='POST'){await route.fallback();return;}
    await waiting;await route.fulfill({status:502,json:{error:'synthetic-secret-canary'}});
  });
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();
  await page.getByLabel('Service URL',{exact:true}).fill('https://fictional.example');await page.getByLabel('Restricted API token',{exact:true}).fill('synthetic-secret-canary');await page.getByLabel('Region',{exact:true}).selectOption('ca');
  await page.getByRole('button',{name:'Verify & save connection',exact:true}).click();
  await expect(page.getByRole('button',{name:'Checking & saving…',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Cancel',exact:true})).toBeDisabled();await expect(page.getByLabel('Restricted API token',{exact:true})).toBeDisabled();
  release();await expect(page.getByRole('button',{name:'Verify & save connection',exact:true})).toBeEnabled();await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.route('**/api/account/connections/connection-fixture-1/check',route=>route.fulfill({status:502,json:{error:'synthetic-secret-canary'}}));
  await page.getByRole('button',{name:'Recheck connection',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The connection could not be checked.');await expect(page.getByRole('button',{name:'Recheck connection',exact:true})).toBeEnabled();
  await page.route('**/api/account/connections/connection-fixture-1',route=>route.fulfill({status:502,json:{error:'synthetic-secret-canary'}}));
  await page.getByRole('button',{name:'Disconnect',exact:true}).click();await page.getByRole('button',{name:'Confirm disconnect',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The connection could not be disconnected.');await expect(page.getByText('Fictional shop',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Confirm disconnect',exact:true})).toBeEnabled();await expect(page.locator('body')).not.toContainText('synthetic-secret-canary');
});

test('providers requiring merchant review still verify API credentials before saving',async({page})=>{
  await serve(page,[{...verified,provider:'synthetic-review-provider',status:'manual'}]);await expect(page.getByText('Credentials saved · account review needed',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Connect Fictional reviewed provider',exact:true}).click();
  await expect(page.getByRole('button',{name:'Verify & save connection',exact:true})).toBeVisible();
  await expect(page.getByText('Provider access is checked, while merchant details and each payment still require independent review.',{exact:false})).toBeVisible();
  await expect(page.getByLabel('Client secret',{exact:true})).toHaveAttribute('type','password');
});

test('hosted workspace mounts saved Connections and remains usable on mobile',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const data=path==='/api/session'?{authenticated:true,role:'owner',authMode:'hosted',csrfToken:'synthetic-connections-csrf',privateScenarioAvailable:false}:path==='/api/dashboard'?{invoices:[],payouts:[],activity:[],totals:{invoicedCad:0,receivedCad:0,availableCad:0,spentCad:0}}:path==='/api/account/connections'?{providers,connections:[verified]}:{error:'Not configured in UI fixture'};
    await route.fulfill({json:data});
  });
  await page.goto('/tests/fixtures/connections-ui.html?screen=full-app');
  await expect(page.getByRole('heading',{name:'Connect once. Come back ready.',exact:true})).toBeVisible();await expect(page.getByText('Fictional shop',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('fictional-connections-desktop.png'),fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Open navigation',exact:true}).click();await expect(page.getByRole('navigation').getByRole('link',{name:'Connections',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Close navigation',exact:true}).last().click();
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();await expect(page.getByLabel('Restricted API token',{exact:true})).toBeVisible();
  await page.screenshot({path:info.outputPath('fictional-connection-form-mobile.png'),fullPage:true,animations:'disabled'});expect(errors).toEqual([]);
});

test('a late list refresh cannot erase a successfully saved connection',async({page})=>{
  await serve(page);await expect(page.getByText('No saved connections yet.',{exact:true})).toBeVisible();
  let release:()=>void=()=>{};const waiting=new Promise<void>(resolve=>{release=resolve;});
  await page.route('**/api/account/connections',async route=>{if(route.request().method()!=='GET'){await route.fallback();return;}await waiting;await route.fulfill({json:{providers,connections:[]}});});
  await page.getByRole('button',{name:'Refresh list',exact:true}).click();
  await page.getByRole('button',{name:'Connect Fictional processor',exact:true}).click();
  await page.getByLabel('Service URL',{exact:true}).fill('https://fictional.example');await page.getByLabel('Restricted API token',{exact:true}).fill('synthetic-secret-canary');await page.getByLabel('Region',{exact:true}).selectOption('ca');
  await page.getByRole('button',{name:'Verify & save connection',exact:true}).click();await expect(page.getByText('Verified connection',{exact:true})).toBeVisible();
  const response=page.waitForResponse(response=>response.url().endsWith('/api/account/connections')&&response.request().method()==='GET');release();await response;
  await expect(page.getByRole('button',{name:'Refresh list',exact:true})).toBeEnabled();await expect(page.getByText('Verified connection',{exact:true})).toBeVisible();
});
