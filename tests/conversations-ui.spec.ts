import {test,expect,type Page} from '@playwright/test';
const invoice={id:'fictional-invoice',token:'fictional-checkout',number:'DEMO-001',title:'Fictional creative work',customerName:'Fictional Studio',currency:'CAD',items:[{description:'Fictional illustration',quantity:1,unitAmount:4200}],taxBps:0,subtotal:4200,tax:0,total:4200,totalCad:4200,amountSats:42000,status:'open',createdAt:'2026-11-05T12:00:00.000Z'};
type Call={path:string;method:string;csrf?:string;body:unknown};
async function serve(page:Page,screen='demo',options:{failLoad?:boolean;peer?:boolean;failPayment?:boolean;noConversation?:boolean;paid?:boolean}={}){
  const calls:Call[]=[];let paid=options.paid??false;let failLoad=options.failLoad;let failPayment=options.failPayment;let merchant=options.peer?'a'.repeat(64):undefined;let customer=options.peer?'b'.repeat(64):undefined;
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,body=request.postDataJSON() as {event?:{kind:number;pubkey:string}}|null;
    calls.push({path,method:request.method(),body,csrf:request.headers()['x-csrf-token']});
    if(path==='/api/hackathon-demo'){
      if(failLoad){failLoad=false;await route.fulfill({status:503,json:{error:'DO-NOT-RENDER-sensitive-error'}});return;}
      await route.fulfill({json:{invoice:{...invoice,status:paid?'paid':'open',settlementMode:paid?'simulation':undefined},checkoutToken:invoice.token,expiresAt:'2026-11-06T12:00:00.000Z'}});return;
    }
    if(path==='/api/hackathon-demo/simulate-payment'){
      if(failPayment){failPayment=false;await route.fulfill({status:502,json:{error:'DO-NOT-RENDER-sensitive-error'}});return;}
      paid=true;await route.fulfill({json:{invoice:{...invoice,status:'paid',settlementMode:'simulation'},checkoutToken:invoice.token,expiresAt:'2026-11-06T12:00:00.000Z'}});return;
    }
    if(path.endsWith('/events')){
      if(body?.event?.kind===30443){if(body.event.pubkey==='a'.repeat(64))merchant=body.event.pubkey;else customer=body.event.pubkey;}
      await route.fulfill({json:{accepted:true}});return;
    }
    if(path.endsWith('/query')){await route.fulfill({json:{events:[]}});return;}
    if(path.endsWith('/conversation')){
      if(options.noConversation&&request.method()==='GET'){await route.fulfill({status:404,json:{error:'Conversation not created'}});return;}
      const role=path.includes('/checkout/')?'customer':'merchant';await route.fulfill({json:{conversation:{id:'fictional-room',role,transportBase:path,peerPubkey:role==='merchant'?customer:merchant},invoice:{...invoice,status:paid?'paid':'open',settlementMode:paid?'simulation':undefined}}});return;
    }
    if(path==='/api/checkout/fictional-checkout'){await route.fulfill({json:{invoice}});return;}
    await route.fulfill({status:404,json:{error:'Not in fixture'}});
  });
  await page.goto(`/tests/fixtures/conversations-ui.html?screen=${screen}`);return calls;
}
test('guided demo uses separate participants, recipient history, and simulated paid gating',async({page},info)=>{
  const calls=await serve(page,'demo',{failPayment:true});
  await expect(page.getByRole('heading',{name:'A private conversation. A clear paper trail.'})).toBeVisible();
  await expect(page.getByText('Fictional Studio',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>Boolean((window as Window&{__marmotTest?:unknown}).__marmotTest))).toBe(false);
  const receipt=page.getByRole('button',{name:'Send receipt notice',exact:true});await expect(receipt).toBeDisabled();
  await page.getByRole('button',{name:'Prepare demo',exact:true}).click();
  await expect(page.getByText('Both participants connected',{exact:true})).toBeVisible();
  const participants=await page.evaluate(()=>(window as Window&{__marmotTest?:{participants:number;namespaces:string[]}}).__marmotTest!);expect(participants.participants).toBe(2);expect(new Set(participants.namespaces).size).toBe(2);
  await page.getByRole('button',{name:'Send private update',exact:true}).click();
  await expect(page.getByRole('region',{name:'Customer conversation'})).toContainText('A private update is available. Review it in Quiet Ledger.');
  await page.getByRole('button',{name:'Acknowledge update',exact:true}).click();
  await expect(page.getByRole('region',{name:'Merchant conversation'})).toContainText('I acknowledge the private update.');
  await expect(receipt).toBeDisabled();
  await page.getByRole('button',{name:'Simulate payment',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The simulated payment could not be recorded.');await expect(receipt).toBeDisabled();
  await expect(page.locator('body')).not.toContainText('DO-NOT-RENDER-sensitive-error');
  await page.getByRole('button',{name:'Simulate payment',exact:true}).click();await expect(page.getByText('Simulated payment recorded',{exact:true})).toBeVisible();
  await receipt.click();await expect(page.getByRole('region',{name:'Customer conversation'})).toContainText('A receipt is ready. Open it in Quiet Ledger.');
  await expect(page.locator('textarea,input[type=text]')).toHaveCount(0);
  for(const call of calls.filter(row=>row.method==='POST'))expect(call.csrf).toBe('fictional-marmot-csrf');
  const envelope=JSON.stringify(calls.filter(row=>row.path.endsWith('/events')));expect(envelope).not.toContain('Fictional Studio');expect(envelope).not.toContain('4200');
  await page.screenshot({path:info.outputPath('fictional-marmot-demo-desktop.png'),fullPage:true});
});
test('load and send errors are safe to retry',async({page})=>{
  await serve(page,'demo',{failLoad:true});await expect(page.getByRole('alert')).toContainText('The fictional demo could not be loaded.');await page.getByRole('button',{name:'Try again',exact:true}).click();
  await page.getByRole('button',{name:'Prepare demo',exact:true}).click();await expect(page.getByText('Both participants connected',{exact:true})).toBeVisible();
  await page.evaluate(()=>{(window as unknown as Window&{__marmotTest:{failSend:boolean}}).__marmotTest.failSend=true;});
  await page.getByRole('button',{name:'Send private update',exact:true}).click();await expect(page.getByRole('alert')).toContainText('The private message could not be delivered.');await expect(page.locator('body')).not.toContainText('DO-NOT-RENDER-sensitive-error');
  await page.getByRole('button',{name:'Send private update',exact:true}).click();await expect(page.getByRole('region',{name:'Customer conversation'})).toContainText('A private update is available.');
});
test('merchant requires explicit connection to the customer before messages',async({page})=>{
  await serve(page,'owner',{peer:true});await page.getByRole('button',{name:'Start private conversation',exact:true}).click();
  await expect(page.getByRole('button',{name:'Send private update',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Connect customer',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>(window as unknown as Window&{__marmotTest:{created:boolean}}).__marmotTest.created)).toBe(false);
  await page.getByRole('button',{name:'Connect customer',exact:true}).click();await expect(page.getByRole('button',{name:'Send private update',exact:true})).toBeEnabled();
  await expect(page.getByRole('button',{name:'Send receipt notice',exact:true})).toBeDisabled();
});
test('customer needs no Nostr account and can wait for a merchant invitation',async({page})=>{
  await serve(page,'customer',{peer:true});await expect(page.getByRole('link',{name:'Back to invoice',exact:false})).toHaveAttribute('href','/pay/fictional-checkout');
  await page.getByRole('button',{name:'Start private conversation',exact:true}).click();await expect(page.getByRole('button',{name:'Accept private invitation',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Accept private invitation',exact:true}).click();await expect(page.getByText('Waiting for the merchant’s invitation.',{exact:true})).toBeVisible();
  await expect(page.locator('input,textarea')).toHaveCount(0);
});
test('mobile role tabs work with a keyboard and do not overflow',async({page},info)=>{
  await page.setViewportSize({width:390,height:844});await serve(page);await page.getByRole('button',{name:'Prepare demo',exact:true}).click();
  const customer=page.getByRole('tab',{name:'Customer',exact:true});await customer.focus();await page.keyboard.press('Enter');await expect(customer).toHaveAttribute('aria-selected','true');await expect(page.getByRole('region',{name:'Customer conversation'})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('fictional-marmot-demo-mobile.png'),fullPage:true});
});
test('customer sees their invoice before the optional conversation exists',async({page})=>{
  await serve(page,'customer',{noConversation:true});await expect(page.getByText('Fictional Studio',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start private conversation',exact:true})).toBeEnabled();
  expect(await page.evaluate(()=>Boolean((window as Window&{__marmotTest?:unknown}).__marmotTest))).toBe(false);
});
test('preparing blocks duplicate operations while pending',async({page})=>{
  await serve(page);let release:()=>void=()=>{};const pending=new Promise<void>(resolve=>{release=resolve;});let starts=0;
  await page.route('**/api/invoices/fictional-invoice/conversation',async route=>{if(route.request().method()!=='POST'){await route.fallback();return;}starts++;await pending;await route.fallback();});
  await page.getByRole('button',{name:'Prepare demo',exact:true}).click();await expect(page.getByRole('button',{name:'Preparing private channel…',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Simulate payment',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Send private update',exact:true})).toBeDisabled();expect(starts).toBe(1);
  release();await expect(page.getByText('Both participants connected',{exact:true})).toBeVisible();
});
test('invoice conversations preserve the simulated payment label',async({page})=>{
  await serve(page,'owner',{paid:true});await expect(page.getByText('Simulated payment recorded',{exact:true})).toBeVisible();
});
