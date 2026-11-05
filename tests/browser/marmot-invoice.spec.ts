import {test,expect,type Page} from '@playwright/test';
import {finalizeEvent,getPublicKey,type EventTemplate} from 'nostr-tools/pure';

const origin='http://localhost:4335';
async function signup(page:Page){
  const key=new Uint8Array(32);key[31]=83;const pubkey=getPublicKey(key);
  await page.exposeFunction('__fictionalMarmotSign',(event:EventTemplate)=>finalizeEvent(event,key));
  await page.addInitScript(({pubkey})=>{window.nostr={getPublicKey:async()=>pubkey,signEvent:async event=>(window as any).__fictionalMarmotSign(event)};},{pubkey});
  await page.goto('/');await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Private display name (optional)',{exact:true}).fill('TEST independent Marmot merchant');
  await page.getByRole('button',{name:'Create account with Nostr',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
}
test('private account and separate anonymous customer establish a real invoice conversation',async({page,browser},info)=>{
  const errors:string[]=[],sockets:string[]=[],external:string[]=[];
  const observe=(p:Page)=>{p.on('pageerror',e=>errors.push(e.message));p.on('websocket',s=>sockets.push(s.url()));p.on('request',r=>{if(new URL(r.url()).origin!==origin)external.push(r.url());});};observe(page);
  await signup(page);
  const session=await(await page.request.get('/api/session')).json();
  const created=await page.request.post('/api/invoices',{headers:{Origin:origin,'X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},data:{customerName:'TEST independent fictional customer',title:'TEST private conversation invoice',currency:'CAD',items:[{description:'Synthetic work',quantity:1,unitAmount:125}]}});
  expect(created.status()).toBe(201);const invoice=await created.json();
  await page.getByRole('link',{name:'Private conversations',exact:true}).click();
  await page.getByRole('button',{name:'Start private conversation',exact:true}).click();
  await expect(page.getByText('Waiting for the customer to open this conversation.',{exact:true})).toBeVisible();
  const context=await browser.newContext({baseURL:origin}),customer=await context.newPage();observe(customer);
  try{
    await context.addCookies([{name:'ql_fixture_client',value:'253',url:origin}]);
    await customer.goto(`/pay/${invoice.token}`);
    await customer.getByRole('link',{name:'Open private conversation',exact:true}).click();
    await customer.getByRole('button',{name:'Start private conversation',exact:true}).click();
    await expect(page.getByRole('button',{name:'Connect customer',exact:true})).toBeEnabled({timeout:15000});
    await page.getByRole('button',{name:'Connect customer',exact:true}).click();
    await expect(page.getByText('Marmot channel connected',{exact:true})).toBeVisible();
    await expect(customer.getByRole('button',{name:'Accept private invitation',exact:true})).toBeEnabled({timeout:15000});
    await customer.getByRole('button',{name:'Accept private invitation',exact:true}).click();
    await expect(customer.getByText('Marmot channel connected',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Send private update',exact:true}).click();
    await expect(customer.getByRole('log').getByText('A private update is available. Review it in Quiet Ledger.',{exact:true})).toBeVisible({timeout:15000});
    await customer.getByRole('button',{name:'Request review',exact:true}).click();
    await expect(page.getByRole('log').getByText('Please review the details in Quiet Ledger.',{exact:true})).toBeVisible({timeout:15000});
    await expect(page.getByRole('button',{name:'Send receipt notice',exact:true})).toBeDisabled();
    expect((await(await page.request.get(`/api/invoices/${invoice.id}`)).json()).status).toBe('open');
    await customer.reload();await customer.getByRole('button',{name:'Start private conversation',exact:true}).click();
    await expect(customer.getByText('Marmot channel connected',{exact:true})).toBeVisible();
    await expect(customer.getByRole('log').getByText('A private update is available. Review it in Quiet Ledger.',{exact:true})).toHaveCount(1);
    const revoked=await page.request.post(`/api/invoices/${invoice.id}/revoke-links`,{headers:{Origin:origin,'X-CSRF-Token':session.csrfToken,'Idempotency-Key':crypto.randomUUID()},data:{}});
    expect(revoked.status()).toBe(200);
    expect((await customer.request.post(`/api/checkout/${invoice.token}/conversation/query`,{headers:{Origin:origin},data:{filters:[{kinds:[445],limit:40}]}})).status()).toBe(404);
    await page.screenshot({path:info.outputPath('actual-independent-merchant.png'),fullPage:true});
  }finally{await context.close();}
  expect(errors).toEqual([]);expect(sockets).toEqual([]);expect(external).toEqual([]);
});
