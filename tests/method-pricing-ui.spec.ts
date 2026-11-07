import {test,expect,type Page} from '@playwright/test';

type Call={path:string;body:any;key?:string};
const agreementId='00000000-0000-4000-8000-000000000101';
const invoiceId='fictional-priced-invoice';
const token='fictional-pricing-token';
const adapters=[{id:'fictional-lightning',label:'Fictional Lightning',mode:'live',configured:true,methods:['lightning'],supportedCurrenciesByMethod:{lightning:['CAD','SAT']}},{id:'fictional-card',label:'Fictional Card',mode:'live',configured:true,methods:['card'],supportedCurrenciesByMethod:{card:['CAD']}}];
function invoice(agreement?:any,paid=0){return {id:invoiceId,number:'QL-FICTIONAL-PRICING',token,title:'Fictional <img src=x onerror="window.__pricingExecuted=true"> labour',customerName:'Fictional Customer',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},{description:'Fictional <img src=x onerror="window.__pricingExecuted=true"> flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false}],taxBps:500,discountBps:500,discountAmount:10000,premiumAmount:0,subtotal:280000,tax:13500,total:283500,status:'open',createdAt:'2026-11-06T00:00:00Z',acceptedMethods:['lightning','card'],methodPricing:[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}],priceAgreement:agreement,balance:{total:283500,effectiveTotal:agreement?.effectiveTotal??283500,paid,credited:0,due:Math.max(0,(agreement?.effectiveTotal??283500)-paid),overpaid:0,currency:'CAD',state:'unpaid',mode:'live'}};}
function offer(method:'lightning'|'card'){const lightning=method==='lightning';return {method,offerHash:(lightning?'a':'b').repeat(64),currency:'CAD',eligibleSubtotal:200000,issuedSubtotal:280000,issuedDiscountAmount:10000,issuedPremiumAmount:0,issuedTax:13500,issuedTotal:283500,discountBps:lightning?1000:0,premiumBps:lightning?0:200,discountAmount:lightning?20000:0,premiumAmount:lightning?0:4000,adjustedSubtotal:lightning?250000:274000,effectiveTax:lightning?12500:13700,taxAdjustment:lightning?-1000:200,effectiveTotal:lightning?262500:287700,totalAdjustment:lightning?-21000:4200,referenceAmountSats:lightning?262500:287700};}
function agreement(method:'lightning'|'card'='lightning'){return {...offer(method),id:agreementId,invoiceId,confirmedAt:'2026-11-06T01:00:00Z',confirmation:'public_checkout_token'};}
async function editor(page:Page,view='editor'){
 const calls:Call[]=[];
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[]}}));
 await page.route('**/api/invoice-templates',async route=>{if(route.request().method()==='GET')return route.fulfill({json:{templates:[]}});const body=route.request().postDataJSON();calls.push({path:'/api/invoice-templates',body,key:route.request().headers()['idempotency-key']});return route.fulfill({json:{template:{id:'fictional-saved',...body}}});});
 await page.route('**/api/hackathon-demo/invoices',async route=>{calls.push({path:'/api/hackathon-demo/invoices',body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});return route.fulfill({json:{invoice:{id:'fictional-demo'}}});});
 await page.goto(`/tests/fixtures/method-pricing-ui.html?view=${view}`);return calls;
}
async function fillLabourAndFlights(page:Page){
 await page.getByLabel('Customer name',{exact:true}).fill('Fictional Customer');await page.getByLabel('Invoice title',{exact:true}).fill('Fictional method pricing');
 await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional labour');await page.getByLabel('Item 1 unit price',{exact:true}).fill('2000.00');
 await page.getByRole('button',{name:'Add line item',exact:true}).click();await page.getByLabel('Item 2 description',{exact:true}).fill('Fictional flights');await page.getByLabel('Item 2 unit price',{exact:true}).fill('800.00');await page.getByLabel('Item 2 type',{exact:true}).selectOption('expense');
 await page.getByLabel('Discount (%)',{exact:true}).fill('5');await page.getByLabel('Tax rate (%)',{exact:true}).fill('5');
 await page.getByLabel('Offer all payment methods',{exact:true}).uncheck();
}
async function acceptLightningAndCard(page:Page){
 const bank=page.getByLabel('Accept Bank transfer',{exact:true});if(await bank.isChecked())await bank.uncheck();const bitcoin=page.getByLabel('Accept Bitcoin',{exact:true});if(await bitcoin.isChecked())await bitcoin.uncheck();const card=page.getByLabel('Accept Card',{exact:true});if(!await card.isChecked())await card.check();
}
async function publicFixture(page:Page,options:{locked?:boolean;offers?:boolean;live?:boolean}={}){
 const state={agreement:options.locked?agreement():undefined,paid:0,calls:[] as Call[],confirmed:[] as Call[]};
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():undefined;
  if(path===`/api/checkout/${token}`&&req.method()==='GET'){const awaiting=!state.agreement;return route.fulfill({json:{invoice:invoice(state.agreement,state.paid),payment:awaiting?null:{mode:'simulation',amountSats:state.agreement?.referenceAmountSats??283500,request:'fictional-payment-request'},pricingOffers:awaiting&&options.offers!==false?[offer('lightning'),offer('card')]:[],adapters:options.live===false?[]:adapters}});}
  if(path===`/api/checkout/${token}/method-agreement`){const call={path,body,key:req.headers()['idempotency-key']};state.confirmed.push(call);state.agreement=agreement(body.method);return route.fulfill({status:201,json:{agreement:state.agreement}});}
  if(path===`/api/checkout/${token}/receiving`){state.calls.push({path,body,key:req.headers()['idempotency-key']});state.paid+=body.amount;return route.fulfill({status:201,json:{request:{id:`fictional-request-${state.calls.length}`,token:`fictional-receive-${state.calls.length}`,invoiceId,invoiceNumber:'QL-FICTIONAL-PRICING',method:body.method,adapterId:body.adapterId,agreementId:body.agreementId,amount:body.amount,currency:'CAD',mode:'live',status:'awaiting_payment',createdAt:'2026-11-06T02:00:00Z'}}});}
  if(path===`/api/checkout/${token}/pay`){state.calls.push({path,body,key:req.headers()['idempotency-key']});return route.fulfill({json:{invoice:{...invoice(state.agreement),status:'paid'},alreadyPaid:false}});}
  return route.fulfill({status:404,json:{error:`Unmocked fictional endpoint ${path}`}});
 });
 await page.goto('/tests/fixtures/method-pricing-ui.html?view=checkout');return state;
}
async function ownerFixture(page:Page,locked:boolean){
 const calls:Call[]=[];
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():undefined;
  if(req.method()==='POST')calls.push({path,body,key:req.headers()['idempotency-key']});
  if(path==='/api/payment-methods')return route.fulfill({json:{adapters,defaultMode:'live'}});
  if(path==='/api/payment-reports')return route.fulfill({json:{reports:[]}});
  if(path==='/api/receiving'&&req.method()==='GET')return route.fulfill({json:{adapters,requests:[]}});
  if(path==='/api/receiving'&&req.method()==='POST'){const row={id:'fictional-owner-request',token:'fictional-owner-receive',invoiceId,invoiceNumber:'QL-FICTIONAL-PRICING',method:body.method,adapterId:body.adapterId,agreementId:body.agreementId,amount:locked?262500:283500,currency:'CAD',mode:'live',status:'awaiting_payment',createdAt:'2026-11-06T02:00:00Z'};return route.fulfill({status:201,json:{request:row}});}
  if(path==='/api/collateral'||path==='/api/ark')return route.fulfill({json:path.endsWith('ark')?{ark:[]}:{collateral:null}});
  return route.fulfill({status:404,json:{error:`Unmocked fictional owner endpoint ${path}`}});
 });
 await page.goto(`/tests/fixtures/method-pricing-ui.html?view=methods${locked?'&locked':''}`);await page.waitForLoadState('networkidle');return calls;
}

test.beforeEach(async({page})=>{page.on('pageerror',error=>{throw error;});});

test('unpriced legacy and demo editors submit unchanged bodies without method rules',async({page})=>{
 const calls=await editor(page,'demo');await expect(page.getByRole('button',{name:'Add method price rule',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');
 expect(calls).toHaveLength(1);expect(calls[0].body).not.toHaveProperty('methodPricing');expect(calls[0].body).not.toHaveProperty('acceptedMethods');expect(calls[0].body).toMatchObject({customerName:'Marmot Field Lab (fictional)',title:'Marmot workshop recording',currency:'CAD'});
});

test('optional rules use eligible labour, exact tax and accepted-method filtering',async({page})=>{
 const calls=await editor(page);await fillLabourAndFlights(page);await acceptLightningAndCard(page);
 await expect(page.getByText('Method discounts and premiums apply only to adjustment-eligible labour and services; excluded expenses stay in the subtotal and tax.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add method price rule',exact:true}).click();await page.getByLabel('Rule 1 method',{exact:true}).selectOption('lightning');await page.getByLabel('Rule 1 discount (%)',{exact:true}).fill('10');
 const preview=page.getByTestId('method-preview-lightning');await expect(preview).toContainText('$200.00');await expect(preview).toContainText('$2,625.00');await expect(preview).toContainText('$125.00');
 await page.getByRole('button',{name:'Add method price rule',exact:true}).click();await page.getByLabel('Rule 2 method',{exact:true}).selectOption('card');await page.getByLabel('Rule 2 premium (%)',{exact:true}).fill('2');await expect(page.getByTestId('method-preview-card')).toContainText('$2,877.00');
 await expect(page.getByLabel('Rule 1 method',{exact:true}).locator('option[value="bank"]')).toHaveCount(0);
 await page.getByLabel('Template name',{exact:true}).fill('Fictional method template');await page.getByRole('button',{name:'Save as new template',exact:true}).click();
 expect(calls[0].body.draft.methodPricing).toEqual([{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}]);
 await page.getByLabel('Invoice currency',{exact:true}).selectOption('SAT');await expect(page.getByTestId('method-preview-card')).toHaveCount(0);await expect(page.getByLabel('Rule 1 method',{exact:true})).toHaveValue('lightning');await expect(page.getByLabel('Rule 1 method',{exact:true}).locator('option[value="card"]')).toHaveCount(0);await page.getByLabel('Item 1 unit price',{exact:true}).fill('2000');await page.getByLabel('Item 2 unit price',{exact:true}).fill('800');await expect(page.getByTestId('method-preview-lightning')).toBeVisible();
});

test('templates and recurring initialDraft preserve rules, dates, terms and line flags',async({page})=>{
 const calls=await editor(page,'review');
 await expect(page.getByLabel('Rule 1 method',{exact:true})).toHaveValue('lightning');await expect(page.getByLabel('Rule 1 discount (%)',{exact:true})).toHaveValue('10');await expect(page.getByLabel('Rule 2 premium (%)',{exact:true})).toHaveValue('2');
 await expect(page.getByLabel('Payment terms',{exact:true})).toHaveValue('Fictional recurring review terms');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2028-03-29');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).not.toBeChecked();
 await page.getByLabel('Template name',{exact:true}).fill('Fictional priced recurring template');await page.getByRole('button',{name:'Save as new template',exact:true}).click();
 await page.getByLabel('Rule 1 discount (%)',{exact:true}).fill('1');await page.getByLabel('Saved invoice template',{exact:true}).selectOption('fictional-saved');await expect(page.getByLabel('Rule 1 discount (%)',{exact:true})).toHaveValue('10');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).not.toBeChecked();
 const attempts:Call[]=[];await page.route('**/api/fictional-pricing/issue',async route=>{attempts.push({path:'/api/fictional-pricing/issue',body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});return route.fulfill({json:{id:'fictional-issued'}});});
 await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');
 expect(calls[0].body.draft).toMatchObject({issueDate:'2028-02-28',dueDate:'2028-03-29'});expect(calls[0].body.draft.methodPricing).toEqual(attempts[0].body.draft.methodPricing);expect(attempts[0].body.draft).toMatchObject({paymentTermDays:30,paymentTerms:'Fictional recurring review terms',methodPricing:[{method:'lightning',discountBps:1000},{method:'card',premiumBps:200}]});
});

test('SAT editor allows only whole-satoshi native method rules',async({page})=>{
 await editor(page,'sat');await expect(page.getByTestId('invoice-total')).toHaveText('1,208 sats');const preview=page.getByTestId('method-preview-lightning');await expect(preview).toContainText('100 sats');await expect(preview).toContainText('1,103 sats');
 await expect(page.getByLabel('Rule 1 method',{exact:true}).locator('option[value="card"]')).toHaveCount(0);await expect(page.getByLabel('Rule 1 method',{exact:true}).locator('option[value="bank"]')).toHaveCount(0);
});

for(const status of [408,503])test(`uncertain ${status} editor retry preserves exact priced body and key`,async({page})=>{
 await editor(page,'review');const attempts:Call[]=[];
 await page.route('**/api/fictional-pricing/issue',async route=>{attempts.push({path:'/api/fictional-pricing/issue',body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});return route.fulfill(attempts.length===1?{status,json:{error:'Fictional uncertain method-price issue'}}:{json:{id:'fictional-issued'}});});
 await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional uncertain');await expect(page.getByLabel('Rule 1 method',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Retry saved invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(attempts[0].body.draft.methodPricing).toHaveLength(2);
});

test('payer confirms before first request and reload resumes exact lock and installments',async({page})=>{
 const state=await publicFixture(page);
 await expect(page.getByTestId('checkout-due')).toHaveText('$2,835.00');await expect(page.getByText('Original issued total',{exact:true})).toBeVisible();
 const lightning=page.getByTestId('price-offer-lightning');await expect(lightning).toContainText('$200.00');await expect(lightning).toContainText('$125.00');await expect(lightning).toContainText('$2,625.00');await expect(page.getByTestId('price-offer-card')).toContainText('$2,877.00');
 await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toHaveCount(0);await lightning.getByRole('button',{name:'Select Lightning price',exact:true}).click();
 await page.getByRole('button',{name:'Confirm Lightning at $2,625.00',exact:true}).click();await page.waitForLoadState('networkidle');await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();await expect(page.getByTestId('price-offer-card')).toHaveCount(0);expect(state.confirmed[0].body).toEqual({method:'lightning',offerHash:'a'.repeat(64)});
 await expect(page.getByLabel('Payment amount (CAD)',{exact:true})).toHaveValue('2625.00');await expect(page.getByLabel('Payment method',{exact:true}).locator('option[value="lightning"]')).toBeAttached();await expect(page.getByLabel('Payment method',{exact:true}).locator('option')).toHaveText(['Lightning']);
 await page.getByLabel('Payment amount (CAD)',{exact:true}).fill('625.00');await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();await expect.poll(()=>state.calls.length).toBe(1);expect(state.calls[0].body).toEqual({method:'lightning',adapterId:'fictional-lightning',amount:62500,agreementId});
 await page.goto('/tests/fixtures/method-pricing-ui.html?view=checkout');await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();await expect(page.getByLabel('Payment amount (CAD)',{exact:true})).toHaveValue('2000.00');await expect(page.getByTestId('checkout-due')).toHaveText('$2,000.00');
 await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();await expect.poll(()=>state.calls.length).toBe(2);expect(state.calls[1].body).toEqual({method:'lightning',adapterId:'fictional-lightning',amount:200000,agreementId});expect(state.calls.every(call=>call.body.method==='lightning'&&call.body.agreementId===agreementId)).toBe(true);
});

for(const status of [408,503])test(`public confirmation ${status} retries one frozen body and key without optimistic payment`,async({page})=>{
 const state=await publicFixture(page);let reads=0;await page.route(`**/api/checkout/${token}`,route=>{reads++;return route.fallback();});
 await page.route(`**/api/checkout/${token}/method-agreement`,async route=>{const req=route.request(),call={path:new URL(req.url()).pathname,body:req.postDataJSON(),key:req.headers()['idempotency-key']};state.confirmed.push(call);if(state.confirmed.length===1)return route.fulfill({status,json:{error:'Fictional uncertain agreement response'}});state.agreement=agreement();return route.fulfill({status:201,json:{agreement:state.agreement}});});
 await page.getByTestId('price-offer-lightning').getByRole('button',{name:'Select Lightning price',exact:true}).click();await page.getByRole('button',{name:'Confirm Lightning at $2,625.00',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional uncertain');await expect(page.getByRole('button',{name:'Retry saved price confirmation',exact:true})).toBeVisible();await expect(page.getByText('Lightning price locked',{exact:true})).toHaveCount(0);expect(state.calls).toEqual([]);
 await page.getByRole('button',{name:'Retry saved price confirmation',exact:true}).click();await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();expect(state.confirmed).toHaveLength(2);expect(state.confirmed[1]).toEqual(state.confirmed[0]);expect(reads).toBeGreaterThan(1);
});

test('a stale confirmation result cannot cross into another checkout token',async({page})=>{
 const otherToken='fictional-other-token',firstCalls:Call[]=[],otherCalls:Call[]=[];let otherAgreement:any,release!:()=>void,firstFinished=false;const gate=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():undefined;
  if(path===`/api/checkout/${token}`&&req.method()==='GET')return route.fulfill({json:{invoice:invoice(),payment:null,pricingOffers:[offer('lightning')],adapters}});
  if(path===`/api/checkout/${otherToken}`&&req.method()==='GET'){const otherOffer={...offer('lightning'),offerHash:'c'.repeat(64)};return route.fulfill({json:{invoice:invoice(otherAgreement),payment:otherAgreement?{mode:'simulation',amountSats:262500,request:'fictional-other-payment'}:null,pricingOffers:otherAgreement?[]:[otherOffer],adapters}});}
  if(path===`/api/checkout/${token}/method-agreement`){firstCalls.push({path,body,key:req.headers()['idempotency-key']});await gate;firstFinished=true;return route.fulfill({status:201,json:{agreement:agreement()}});}
  if(path===`/api/checkout/${otherToken}/method-agreement`){otherCalls.push({path,body,key:req.headers()['idempotency-key']});otherAgreement={...agreement(),offerHash:'c'.repeat(64)};return route.fulfill({status:201,json:{agreement:otherAgreement}});}
  return route.fulfill({status:404,json:{error:`Unmocked fictional cross-token endpoint ${path}`}});});
 await page.goto('/tests/fixtures/method-pricing-ui.html?view=checkout&switch');await page.getByTestId('price-offer-lightning').getByRole('button',{name:'Select Lightning price',exact:true}).click();await page.getByRole('button',{name:'Confirm Lightning at $2,625.00',exact:true}).click();await expect.poll(()=>firstCalls.length).toBe(1);
 await page.getByRole('button',{name:'Switch checkout token',exact:true}).click();await expect(page.getByTestId('price-offer-lightning')).toBeVisible();await expect(page.getByRole('button',{name:'Retry saved price confirmation',exact:true})).toHaveCount(0);release();await expect.poll(()=>firstFinished).toBe(true);await expect(page.getByText('Lightning price locked',{exact:true})).toHaveCount(0);
 await page.getByTestId('price-offer-lightning').getByRole('button',{name:'Select Lightning price',exact:true}).click();await page.getByRole('button',{name:'Confirm Lightning at $2,625.00',exact:true}).click();await expect.poll(()=>otherCalls.length).toBe(1);await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();expect(firstCalls[0].body).toEqual({method:'lightning',offerHash:'a'.repeat(64)});expect(otherCalls[0].body).toEqual({method:'lightning',offerHash:'c'.repeat(64)});expect(otherCalls[0].path).toBe(`/api/checkout/${otherToken}/method-agreement`);expect(otherCalls[0].key).not.toBe(firstCalls[0].key);
});

test('saved public agreement also binds simulated pay without adding IDs to legacy branches',async({page})=>{
 const state=await publicFixture(page,{locked:true,live:false});await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Pay with simulated Lightning',exact:true}).click();await expect.poll(()=>state.calls.length).toBe(1);expect(state.calls[0].body).toEqual({method:'lightning',agreementId});
});

test('no offers or adapters and expired checkout fail honestly without request controls',async({page})=>{
 const state=await publicFixture(page,{offers:false,live:false});await expect(page.getByText('No method price offers are currently available. Ask the merchant to check the invoice link and available payment connections.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/Pay with simulated/})).toHaveCount(0);expect(state.confirmed).toEqual([]);expect(state.calls).toEqual([]);
 await page.unrouteAll();await page.route(`**/api/checkout/${token}`,route=>route.fulfill({status:410,json:{error:'This checkout link has expired.'}}));await page.goto('/tests/fixtures/method-pricing-ui.html?view=checkout');await expect(page.getByRole('alert')).toContainText('expired');await expect(page.getByRole('button',{name:/Confirm|Continue|Pay with/})).toHaveCount(0);
});

test('escaped locked public invoice, print and mobile keyboard preserve original and effective amounts',async({page})=>{
 await page.setViewportSize({width:390,height:844});await publicFixture(page,{locked:true});await expect(page.getByText('Fictional <img src=x onerror="window.__pricingExecuted=true"> labour',{exact:true})).toBeVisible();expect(await page.evaluate(()=>Boolean((window as any).__pricingExecuted))).toBe(false);await expect(page.locator('.checkout-invoice img')).toHaveCount(0);
 await expect(page.getByTestId('agreement-effective-total')).toHaveText('$2,625.00');await expect(page.getByTestId('agreement-effective-tax')).toHaveText('$125.00');await expect(page.getByTestId('checkout-due')).toHaveText('$2,625.00');
 const amount=page.getByLabel('Payment amount (CAD)',{exact:true});await amount.focus();await page.keyboard.press('Control+A');await page.keyboard.type('10.00');await expect(amount).toHaveValue('10.00');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.emulateMedia({media:'print'});await expect(page.getByText('Method price agreement',{exact:true})).toBeVisible();await expect(page.getByTestId('agreement-effective-total')).toHaveText('$2,625.00');await expect(page.locator('.checkout-payment')).toBeHidden();await page.screenshot({path:test.info().outputPath('locked-public-print-mobile.png'),fullPage:true});
});

test('public receipt prints immutable originals and agreement price without payer identity claims',async({page})=>{
 await page.route('**/api/receipts/fictional-receipt-token',route=>route.fulfill({json:{invoice:invoice(agreement(),62500),receipt:{number:'PAY-FICTIONAL-1',issuedAt:'2026-11-06T02:00:00Z',mode:'live',method:'lightning',amount:62500,currency:'CAD',invoiceNumber:'QL-FICTIONAL-PRICING',title:'Fictional labour and flights',customerName:'Fictional Customer'}}}));
 await page.goto('/tests/fixtures/method-pricing-ui.html?view=receipt');await expect(page.locator('.receipt-amount')).toContainText('$625.00');await expect(page.getByTestId('receipt-issued-total')).toHaveText('$2,835.00');await expect(page.getByTestId('receipt-effective-total')).toHaveText('$2,625.00');await expect(page.getByText('Method discount',{exact:true})).toBeVisible();await expect(page.getByText(/payer identity|wallet identity/i)).toHaveCount(0);
 await page.emulateMedia({media:'print'});await expect(page.getByText('Method price agreement',{exact:true})).toBeVisible();await expect(page.getByTestId('receipt-effective-total')).toHaveText('$2,625.00');
});

test('owner requires public confirmation then sends exact locked ID and method',async({page})=>{
 let calls=await ownerFixture(page,false);const picker=page.getByLabel('Invoice to receive',{exact:true});await expect(picker).toBeVisible();await picker.selectOption(invoiceId);await expect(page.getByRole('link',{name:'Open customer checkout to confirm price',exact:true})).toHaveAttribute('href',`/pay/${token}`);await expect(page.getByRole('button',{name:'Create live receiving request',exact:true})).toHaveCount(0);expect(calls).toEqual([]);
 await page.unrouteAll();calls=await ownerFixture(page,true);await page.getByLabel('Invoice to receive',{exact:true}).selectOption(invoiceId);await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();await expect(page.getByLabel('Receiving method',{exact:true}).locator('option')).toHaveText(['Lightning']);await expect(page.getByLabel('Receiving method',{exact:true}).locator('option[value="card"]')).toHaveCount(0);
 await page.getByRole('button',{name:'Create live receiving request',exact:true}).click();await expect.poll(()=>calls.length).toBe(1);expect(calls[0].body).toEqual({invoiceId,method:'lightning',adapterId:'fictional-lightning',agreementId});
});

test('ledger separates pending agreement, original and effective prices, and real credits',async({page})=>{
 const calls:Call[]=[];let locked=false;
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():undefined;if(req.method()==='POST')calls.push({path,body,key:req.headers()['idempotency-key']});
  if(path===`/api/invoices/${invoiceId}/ledger`){const current=invoice(locked?agreement():undefined);return route.fulfill({json:{invoice:current,balance:current.balance,entries:[{id:'fictional-credit',kind:'credit',amount:1000,currency:'CAD',createdAt:'2026-11-06T02:00:00Z',reason:'Fictional separate service credit'}]}});}
  if(path==='/api/receiving'&&req.method()==='GET')return route.fulfill({json:{adapters,requests:[]}});
  if(path==='/api/receiving'&&req.method()==='POST')return route.fulfill({status:201,json:{request:{id:'fictional-ledger-request',token:'fictional-ledger-receive',invoiceId,invoiceNumber:'QL-FICTIONAL-PRICING',method:body.method,adapterId:body.adapterId,agreementId:body.agreementId,amount:body.amount,currency:'CAD',mode:'live',status:'awaiting_payment',createdAt:'2026-11-06T02:00:00Z'}}});
  return route.fulfill({status:404,json:{error:`Unmocked fictional ledger endpoint ${path}`}});});
 await page.goto('/tests/fixtures/method-pricing-ui.html?view=ledger');await expect(page.getByText('Payer method price confirmation required',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Create payment request',exact:true})).toHaveCount(0);await expect(page.getByTestId('ledger-effectiveTotal')).toHaveText('$2,835.00');
 locked=true;await page.getByRole('button',{name:'Refresh balance',exact:true}).click();await page.waitForLoadState('networkidle');await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();await expect(page.getByTestId('ledger-total')).toHaveText('$2,835.00');await expect(page.getByTestId('ledger-effectiveTotal')).toHaveText('$2,625.00');await expect(page.getByRole('heading',{name:'Credit note',exact:true})).toBeVisible();await expect(page.getByText('Method price discount credit',{exact:true})).toHaveCount(0);
 await page.getByLabel('Payment request amount (CAD)',{exact:true}).fill('625.00');await expect(page.getByLabel('Receiving method',{exact:true}).locator('option')).toHaveText(['Lightning']);await page.getByRole('button',{name:'Create payment request',exact:true}).click();await expect.poll(()=>calls.length).toBe(1);expect(calls[0].body).toEqual({invoiceId,amount:62500,method:'lightning',adapterId:'fictional-lightning',agreementId});
});

test('a committed price with a failed authoritative reload retries the same confirmation identity',async({page})=>{
 const state=await publicFixture(page);let failed=false;
 await page.route(`**/api/checkout/${token}`,route=>{
  if(state.agreement&&!failed){failed=true;return route.fulfill({status:503,json:{error:'Fictional unavailable confirmation readback'}});}
  return route.fulfill({json:{invoice:invoice(state.agreement,state.paid),payment:state.agreement?{mode:'simulation',amountSats:state.agreement.referenceAmountSats,request:'fictional-payment-request'}:null,pricingOffers:state.agreement?[]:[offer('lightning'),offer('card')],adapters}});
 });
 await page.getByRole('button',{name:'Confirm Lightning at $2,625.00',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('price confirmation could not be verified');await expect(page.getByRole('button',{name:'Retry saved price confirmation',exact:true})).toBeVisible();expect(state.calls).toEqual([]);
 await page.getByRole('button',{name:'Retry saved price confirmation',exact:true}).click();await expect(page.getByText('Lightning price locked',{exact:true})).toBeVisible();expect(state.confirmed).toHaveLength(2);expect(state.confirmed[1]).toEqual(state.confirmed[0]);expect(state.calls).toEqual([]);
});
