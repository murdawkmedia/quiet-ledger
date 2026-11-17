import {test,expect,type Page} from '@playwright/test';
import type {DemoLivePaymentView,DemoLiveRequest} from '../shared/demo-live-payment';
const path='/api/hackathon-demo/live-payment';
const sample=():DemoLiveRequest=>({id:'fictional-request',mode:'live',method:'lightning',status:'awaiting_payment',amount:21,currency:'SAT',expectedAtomic:'21',createdAt:new Date(Date.now()-1000).toISOString(),expiresAt:'2099-01-01T00:00:00.000Z',intent:{request:'lightning:lnbc210n1'+('fictional'.repeat(80)),network:'mainnet',asset:'BTC',cashuWalletHandoff:true}});
async function fixture(page:Page,request?:DemoLiveRequest,enabled=true){
  const state={view:{enabled,receiver:'fictional-receiver@coinos.test',amountSats:21,rail:'lightning',...(request?{request}:{})} as DemoLivePaymentView,mutations:[] as {path:string;key?:string;body:unknown}[],failures:0,lostCreation:false,paid:false,invalidCheck:false};
  await page.route('**/api/**',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='GET'&&url.pathname===path)return route.fulfill({json:state.view});
    if(req.method()==='POST')state.mutations.push({path:url.pathname,key:req.headers()['idempotency-key'],body:req.postDataJSON()});
    if(url.pathname===path&&req.method()==='POST'){
      if(state.failures-->0)return route.fulfill({status:503,json:{error:'Fictional unavailable readback.'}});
      if(state.lostCreation){state.view.request={...sample(),status:'creation_pending',intent:undefined,creationUncertain:true};return route.abort('connectionreset');}
      state.view.request=sample();return route.fulfill({status:201,json:state.view});
    }
    if(url.pathname===path+'/check'){
      if(state.invalidCheck)state.view.request!.status='paid';
      if(state.paid){const row=state.view.request!;row.status='paid';row.receipt={number:'PAY-fictional-request',amount:21,currency:'SAT',method:'lightning',mode:'live',verifiedAt:new Date().toISOString()};}
      return route.fulfill({json:state.view});
    }
    return route.fulfill({status:404,json:{error:'Unmocked fictional fixture endpoint.'}});
  });
  await page.goto('/tests/fixtures/demo-live-ui.html');
  return state;
}
test('mount reads only, consent starts unchecked and failed creates reuse the same key',async({page})=>{
  const state=await fixture(page);state.failures=1;
  const create=page.getByRole('button',{name:'Create my real 21-sat Lightning invoice',exact:true});
  await expect(create).toBeDisabled();await expect(page.getByRole('checkbox')).not.toBeChecked();expect(state.mutations).toEqual([]);
  await page.getByRole('checkbox').check();await create.click();await expect(page.getByRole('alert')).toBeVisible();await create.click();
  await expect(page.getByRole('button',{name:'Check payment',exact:true})).toBeVisible();
  expect(state.mutations).toHaveLength(2);expect(state.mutations[0].key).toBeTruthy();expect(state.mutations[1]).toEqual(state.mutations[0]);
});
test('disabled sample explains unavailability without creation controls',async({page})=>{
  const state=await fixture(page,undefined,false);
  await expect(page.getByRole('status')).toContainText('unavailable');
  await expect(page.getByRole('checkbox')).toHaveCount(0);await expect(page.getByRole('button',{name:/^Create my real/})).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});
test('lost create response refreshes saved uncertainty without automatically retrying',async({page})=>{
  const state=await fixture(page);state.lostCreation=true;
  await page.getByRole('checkbox').check();await page.getByRole('button',{name:'Create my real 21-sat Lightning invoice',exact:true}).click();
  await expect(page.getByText('Still confirming the original invoice',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create my real 21-sat Lightning invoice',exact:true})).toHaveCount(0);
  expect(state.mutations).toHaveLength(1);
});
test('review withholds payment controls and a receipt until authoritative readback',async({page})=>{
  const state=await fixture(page,{...sample(),reviewReason:'Fictional review required.'});
  await expect(page.getByRole('alert')).toContainText('Fictional review');
  await expect(page.getByRole('button',{name:'Copy Lightning invoice',exact:true})).toHaveCount(0);
  await expect(page.getByText('Real Lightning payment received',{exact:true})).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});
test('provider expiry hides payment controls at its deadline, retaining the saved sample',async({page})=>{
  await page.clock.install();const request=sample();request.intent!.expiresAt=new Date(Date.now()+1500).toISOString();
  await fixture(page,request);await expect(page.getByRole('button',{name:'Copy Lightning invoice',exact:true})).toBeVisible();
  await page.clock.fastForward(2500);await expect(page.getByText('This invoice expired',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Copy Lightning invoice',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^Create my real/})).toHaveCount(0);
});
test('only a valid paid receipt displays payment received',async({page})=>{
  const state=await fixture(page,sample());state.paid=true;
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect(page.getByText('Real Lightning payment received',{exact:true})).toBeVisible();
  await expect(page.getByText(/Receipt PAY-fictional-request/)).toBeVisible();expect(state.mutations.map(row=>row.path)).toEqual([path+'/check']);
});
test('malformed paid state is unavailable rather than a fabricated success',async({page})=>{
  await fixture(page,{...sample(),status:'paid'});
  await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByText('Real Lightning payment received',{exact:true})).toHaveCount(0);
});
test('invalid readback withholds the previously displayed payment request',async({page})=>{
  const state=await fixture(page,sample());state.invalidCheck=true;
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByRole('button',{name:'Copy Lightning invoice',exact:true})).toHaveCount(0);
  await expect(page.getByText('Real Lightning payment received',{exact:true})).toHaveCount(0);
});
test('390px sample retains keyboard access and QR guidance without horizontal overflow',async({page})=>{
  await page.setViewportSize({width:390,height:844});await fixture(page,sample());
  await page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByRole('img',{name:'Scan this Lightning invoice in your Cashu wallet',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
