import {test,expect,type Page} from '@playwright/test';
import {METHOD_DEFINITIONS} from '../../shared/payment-methods';

// Explicit UI fixtures: these tests never contact a wallet, node or provider.
const invoice={id:'fictional-invoice',token:'fictional-invoice-token',number:'FICTIONAL-PARITY',title:'Fictional parity service',customerName:'Fictional customer',currency:'CAD',items:[{description:'Fictional work',quantity:1,unitAmount:1200}],subtotal:1200,tax:0,taxBps:0,total:1200,totalCad:1200,amountSats:12000,status:'open',createdAt:'2026-11-04T12:00:00Z'};
const adapter={id:'bitcoin-fixture',methods:['bitcoin'],mode:'live'};
const receive={id:'fictional-request',token:'fictional-receive-token',invoiceId:invoice.id,invoiceNumber:invoice.number,method:'bitcoin',adapterId:adapter.id,mode:'live',status:'awaiting_payment',amount:1200,currency:'CAD',expectedAtomic:'12000',createdAt:invoice.createdAt,expiresAt:'2099-11-04T13:00:00Z',intent:{providerId:'fictional-provider',network:'bitcoin-mainnet',asset:'BTC',request:'bitcoin:bc1qfictionalfixture?amount=0.00012'}};
async function workspace(page:Page,owner=false){
  await page.route('**/api/session',route=>route.fulfill({json:{authenticated:true,role:owner?'owner':'demo',csrfToken:'fixture-csrf',privateScenarioAvailable:false}}));
  await page.route('**/api/dashboard',route=>route.fulfill({json:{totals:{invoicedCad:1200,receivedCad:0,availableCad:0,spentCad:0},invoices:[invoice],payouts:[],activity:[]}}));
  await page.route('**/api/payment-methods',route=>route.fulfill({json:{methods:METHOD_DEFINITIONS,adapters:[],defaultMode:'live'}}));
  await page.route('**/api/payment-reports',route=>route.fulfill({json:{reports:[]}}));
}
test('all catalog methods and wallet choices stay visible without claiming connections',async({page},info)=>{
  await workspace(page);await page.goto('/payment-methods');
  await expect(page.getByRole('heading',{name:'Your ways to get paid.',exact:true})).toBeVisible();
  for(const method of METHOD_DEFINITIONS)await expect(page.locator(`[data-method="${method.id}"]`)).toBeVisible();
  for(const label of ['Bitcoin Core','Watch-only / hardware wallet','LND / Lightning','LNURL','Bark / Ark','Liquid','Stablecoin address','Stripe','Square','PayPal','Revolut','Manual fiat'])await expect(page.getByRole('heading',{name:label,exact:true})).toBeVisible();
  await expect(page.getByText('Unavailable · setup required').first()).toBeVisible();
  await page.screenshot({path:info.outputPath('catalog-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:info.outputPath('catalog-mobile.png')});
});
test('manual report waits for owner review and has no paid receipt',async({page})=>{
  await page.route('**/api/checkout/fictional-invoice-token',route=>route.fulfill({json:{invoice,payment:{mode:'simulation',amountSats:12000,request:'simulation:fixture'}}}));
  await page.route('**/api/checkout/fictional-invoice-token/pay',async route=>{expect(route.request().postDataJSON()).toEqual({method:'cash'});await route.fulfill({json:{invoice,alreadyPaid:false,report:{id:'fictional-report',method:'cash',status:'reported',createdAt:invoice.createdAt}}});});
  await page.goto('/pay/fictional-invoice-token');await page.getByLabel('More payment methods',{exact:true}).selectOption('cash');
  await page.getByRole('button',{name:'Report cash payment',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Awaiting owner review.',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'View payment receipt',exact:true})).toHaveCount(0);
  await expect(page.getByText('Payment recorded.',{exact:true})).toHaveCount(0);
});
test('configured live checkout creates request and renders verified live receipt accurately',async({page},info)=>{
  await page.route('**/api/checkout/fictional-invoice-token',route=>route.fulfill({json:{invoice,payment:{mode:'simulation',amountSats:12000,request:'simulation:fixture'},adapters:[adapter]}}));
  await page.route('**/api/checkout/fictional-invoice-token/receiving',async route=>{expect(route.request().postDataJSON()).toEqual({method:'bitcoin',adapterId:adapter.id});await route.fulfill({json:{request:receive}});});
  await page.route('**/api/receive/fictional-receive-token',route=>route.fulfill({json:{request:receive}}));
  await page.route('**/api/receive/fictional-receive-token/check',route=>route.fulfill({json:{request:{...receive,status:'paid',receipt:{number:'FICTIONAL-LIVE-RECEIPT',mode:'live',method:'bitcoin',amount:1200,currency:'CAD',verifiedAt:invoice.createdAt}}}}));
  await page.goto('/pay/fictional-invoice-token');await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:info.outputPath('receive-mobile.png'),fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await expect(page.getByText('12,000 sats',{exact:true})).toBeVisible();await expect(page.getByText(receive.intent.request,{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Check payment',exact:true}).click();await expect(page.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();
  await expect(page.getByText('FICTIONAL-LIVE-RECEIPT',{exact:true})).toBeVisible();await expect(page.getByText('Live payment · real funds',{exact:true})).toBeVisible();
  await expect(page.getByText(/no real funds/i)).toHaveCount(0);
  await page.screenshot({path:info.outputPath('live-receipt-mobile.png'),fullPage:true});
});
test('owner confirms a reported payment explicitly and only once while busy',async({page})=>{
  await workspace(page,true);
  await page.route('**/api/receiving',route=>route.fulfill({json:{requests:[],adapters:[],defaultMode:'live'}}));
  await page.route('**/api/collateral',route=>route.fulfill({status:503,json:{error:'No read-only node configured.'}}));
  await page.route('**/api/ark',route=>route.fulfill({json:{ark:[]}}));
  await page.route('**/api/payment-reports',route=>route.fulfill({json:{reports:[{id:'fictional-report',invoiceId:invoice.id,invoiceNumber:invoice.number,method:'coupon',amount:1200,currency:'CAD',status:'reported',createdAt:invoice.createdAt}]}}));
  let calls=0;await page.route('**/api/payment-reports/fictional-report/confirm',async route=>{calls++;await route.fulfill({json:{invoice:{...invoice,status:'paid'},alreadyPaid:false}});});
  await page.goto('/payment-methods');
  const card=page.locator('.payment-report');await expect(card.getByText('No new cash value',{exact:true})).toBeVisible();
  await card.getByLabel('I have independently verified this settlement',{exact:true}).check();await card.getByRole('button',{name:'Confirm reported payment',exact:true}).click();
  await expect(card).toHaveCount(0);expect(calls).toBe(1);
});
test('live receipts and noncash settlements cannot be offered as simulated payout funding',async({page})=>{
  await workspace(page);
  await page.route('**/api/dashboard',route=>route.fulfill({json:{totals:{invoicedCad:3600,receivedCad:1200,availableCad:1200,spentCad:0},invoices:[{...invoice,id:'fictional-live',status:'paid',paymentMethod:'bitcoin',settlementMode:'live'},{...invoice,id:'fictional-coupon',status:'paid',paymentMethod:'coupon'},{...invoice,id:'fictional-eligible',status:'paid',paymentMethod:'lightning'}],payouts:[],activity:[]}}));
  await page.goto('/payouts');const options=page.getByLabel('Fund from a paid invoice').locator('option');
  await expect(options).toHaveCount(2);await expect(options.last()).toHaveAttribute('value','fictional-eligible');await expect(page.getByLabel('Provider',{exact:true})).toHaveValue('bullbitcoin');
});
test('owner chooses receiving adapter and collateral stays separate from Ark balance',async({page})=>{
  await workspace(page,true);let saved=false;
  await page.route('**/api/payment-methods',route=>route.fulfill({json:{methods:METHOD_DEFINITIONS,adapters:[adapter],defaultMode:'live',walletOptions:[{id:adapter.id,name:'Fictional receive-only watch wallet',category:'bitcoin',methods:['bitcoin'],description:'Fictional configured protocol fixture.',requirements:['No spending key.'],configured:true}]}}));
  await page.route('**/api/receiving',async route=>{
    if(route.request().method()==='POST'){expect(route.request().postDataJSON()).toEqual({invoiceId:invoice.id,method:'bitcoin',adapterId:adapter.id});expect(route.request().headers()['idempotency-key']).toBeTruthy();saved=true;await route.fulfill({json:{request:receive}});}
    else await route.fulfill({json:{requests:saved?[receive]:[],adapters:[adapter],defaultMode:'live'}});
  });
  await page.route('**/api/collateral',route=>route.fulfill({json:{collateral:{totalSats:1000,height:1000000,network:'mainnet',observedAt:invoice.createdAt,utxos:[{txid:'a'.repeat(64),vout:0,valueSats:1000,confirmations:6}],control:'unverified',unencumbered:'unknown',lenderAcceptance:'unknown'}}}));
  await page.route('**/api/ark',route=>route.fulfill({json:{ark:[{network:'mainnet',observedAt:invoice.createdAt,spendableSats:999999,tipHeight:1000000,categories:{spendable_sat:999999},kind:'virtual-vtxo-balance'}]}}));
  await page.goto('/payment-methods');await expect(page.getByRole('heading',{name:'Fictional receive-only watch wallet',exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Invoice to receive',exact:true}).selectOption(invoice.id);
  await page.getByRole('combobox',{name:'Receiving method',exact:true}).selectOption('bitcoin');await page.getByRole('button',{name:'Create live receiving request',exact:true}).click();
  await expect(page.getByRole('link',{name:'Open payment request',exact:true})).toBeVisible();
  const verification=page.locator('.verification-grid');await expect(verification.getByText('1,000 sats',{exact:true})).toBeVisible();await expect(verification.getByText('999,999 sats spendable',{exact:true})).toBeVisible();await expect(verification.getByText('unverified',{exact:true})).toBeVisible();
  await expect(verification.getByText('unknown',{exact:true})).toHaveCount(2);
});
test('receiving page discards a late verification after navigation to another token',async({page})=>{
  await page.route('**/api/receive/fictional-receive-token',route=>route.fulfill({json:{request:receive}}));
  await page.route('**/api/receive/other-fictional-token',route=>route.fulfill({json:{request:{...receive,id:'other',token:'other-fictional-token',invoiceNumber:'FICTIONAL-SECOND',expectedAtomic:'23000'}}}));
  let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);let requested!:()=>void;const started=new Promise<void>(resolve=>requested=resolve);
  await page.route('**/api/receive/fictional-receive-token/check',async route=>{requested();await held;await route.fulfill({json:{request:{...receive,status:'paid',receipt:{number:'FICTIONAL-STALE-RECEIPT',mode:'live',method:'bitcoin',amount:1200,currency:'CAD',verifiedAt:invoice.createdAt}}}});});
  await page.goto('/receive/fictional-receive-token');await page.getByRole('button',{name:'Check payment',exact:true}).click();await started;
  await page.evaluate(()=>{history.pushState({},'','/receive/other-fictional-token');dispatchEvent(new PopStateEvent('popstate'));});
  await expect(page.getByText('23,000 sats',{exact:true})).toBeVisible();release();await page.waitForLoadState('networkidle');
  await expect(page.getByText('23,000 sats',{exact:true})).toBeVisible();await expect(page.getByText('FICTIONAL-STALE-RECEIPT',{exact:true})).toHaveCount(0);
});
test('main live receipt retains asset details and never claims simulation',async({page})=>{
  await page.route('**/api/receipts/fictional-live-receipt',route=>route.fulfill({json:{invoice:{...invoice,status:'paid',settlementMode:'live'},receipt:{number:'FICTIONAL-NATIVE-RECEIPT',mode:'live',method:'ark',amount:1200,currency:'CAD',invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName,issuedAt:invoice.createdAt,nativePayment:{asset:'BTC',atomicAmount:'12000',network:'mainnet',paymentId:'fictional-reviewed-payment',verification:'manual'}}}}));
  await page.goto('/receipt/fictional-live-receipt');await expect(page.getByText('Live payment · real funds',{exact:true})).toBeVisible();
  await expect(page.getByText('Independent owner review',{exact:true})).toBeVisible();await expect(page.getByText('12000 BTC atomic units · mainnet',{exact:true})).toBeVisible();await expect(page.getByText(/simulat/i)).toHaveCount(0);
});
test('saved receiving creation recovers through its server identity after reload',async({page})=>{
  await workspace(page,true);let recovered=false;let body:unknown;
  await page.route('**/api/receiving',route=>route.fulfill({json:{requests:[recovered?receive:{...receive,status:'creation_pending',intent:undefined}],adapters:[adapter],defaultMode:'live'}}));
  await page.route('**/api/collateral',route=>route.fulfill({status:503,json:{error:'Fictional unconfigured node'}}));
  await page.route('**/api/ark',route=>route.fulfill({json:{ark:[]}}));
  await page.route('**/api/receiving/fictional-request/recover',async route=>{body=route.request().postDataJSON();recovered=true;await route.fulfill({json:{request:receive}});});
  await page.goto('/payment-methods');await page.reload();await page.getByRole('button',{name:'Recover saved request',exact:true}).click();
  await expect(page.getByRole('button',{name:'Recover saved request',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Check payment',exact:true})).toBeEnabled();expect(body).toEqual({});
});
test('owner explicitly switches to test receiving while live remains the default',async({page})=>{
  await workspace(page,true);const testAdapter={...adapter,id:'bitcoin-test-fixture',mode:'test'};
  await page.route('**/api/payment-methods',route=>route.fulfill({json:{methods:METHOD_DEFINITIONS,adapters:[adapter,testAdapter],defaultMode:'live'}}));
  await page.route('**/api/receiving',async route=>{
    if(route.request().method()==='POST'){expect(route.request().postDataJSON()).toEqual({invoiceId:invoice.id,method:'bitcoin',adapterId:testAdapter.id});await route.fulfill({json:{request:{...receive,mode:'test',adapterId:testAdapter.id}}});}
    else await route.fulfill({json:{requests:[],adapters:[adapter,testAdapter],defaultMode:'live'}});
  });
  await page.route('**/api/collateral',route=>route.fulfill({status:503,json:{error:'Fictional unconfigured node'}}));await page.route('**/api/ark',route=>route.fulfill({json:{ark:[]}}));
  await page.goto('/payment-methods');const environment=page.getByRole('combobox',{name:'Receiving environment',exact:true});await expect(environment).toHaveValue('live');await environment.selectOption('test');
  await expect(page.getByText('Test receipts never settle the live invoice or fund a simulated payout.',{exact:true})).toBeVisible();
  await page.getByRole('combobox',{name:'Invoice to receive',exact:true}).selectOption(invoice.id);await page.getByRole('combobox',{name:'Receiving method',exact:true}).selectOption('bitcoin');
  await expect(page.getByRole('combobox',{name:'Receiving adapter',exact:true})).toHaveValue(testAdapter.id);
  await page.getByRole('button',{name:'Create test receiving request',exact:true}).click();await expect(page.getByRole('link',{name:'Open payment page',exact:true})).toBeVisible();
});
