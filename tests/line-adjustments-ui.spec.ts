import {test,expect,type Page} from '@playwright/test';

type Call={body:any;key?:string};
const legacy={customerName:'Fictional adjustment customer',title:'Fictional adjustment service',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000},{description:'Fictional flights',quantity:1,unitAmount:80000}],discountBps:500,issueDate:'2026-01-10',dueDate:'2026-01-25',taxBps:0};
test.beforeEach(async({page})=>{page.on('pageerror',error=>{throw error;});});

async function fixture(page:Page,query=''){
 const calls:Call[]=[];
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[]}}));
 await page.route('**/api/invoice-templates',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{templates:[{id:'legacy',label:'Fictional legacy template',draft:legacy}]}});
  const body=route.request().postDataJSON();calls.push({body});return route.fulfill({json:{template:{id:'saved',...body}}});
 });
 await page.route('**/api/hackathon-demo/invoices',async route=>{calls.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});await route.fulfill({json:{invoice:{id:'fictional-created'}}});});
 await page.goto('/tests/fixtures/line-adjustments-ui.html'+query);
 return calls;
}

async function labourAndFlights(page:Page){
 await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional labour');
 await page.getByLabel('Item 1 unit price',{exact:true}).fill('2000.00');
 await page.getByRole('button',{name:'Add line item',exact:true}).click();
 await page.getByLabel('Item 2 description',{exact:true}).fill('Fictional flights');
 await page.getByLabel('Item 2 unit price',{exact:true}).fill('800.00');
 await page.getByLabel('Item 2 type',{exact:true}).selectOption('expense');
 await page.getByLabel('Discount (%)',{exact:true}).fill('5');
}

test('new lines default to eligible services and flights remain at cost with a five percent discount',async({page})=>{
 const calls=await fixture(page);
 await expect(page.getByLabel('Item 1 type',{exact:true})).toHaveValue('service');
 await expect(page.getByLabel('Item 1 apply discounts/premiums',{exact:true})).toBeChecked();
 await labourAndFlights(page);
 await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).not.toBeChecked();
 await expect(page.getByTestId('invoice-total')).toHaveText('$2,700.00');
 await expect(page.getByText('Discounts and premiums apply only to eligible lines before tax.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();
 await expect(page.locator('body')).toHaveAttribute('data-created','true');
 expect(calls[0].body.items).toEqual([{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service',adjustmentEligible:true},{description:'Fictional flights',quantity:1,unitAmount:80000,kind:'expense',adjustmentEligible:false}]);
});

test('each type resets its default while both service and expense eligibility can be overridden',async({page})=>{
 await fixture(page);await labourAndFlights(page);
 const flight=page.getByLabel('Item 2 apply discounts/premiums',{exact:true}),labour=page.getByLabel('Item 1 apply discounts/premiums',{exact:true});
 await flight.check();await expect(page.getByTestId('invoice-total')).toHaveText('$2,660.00');
 await labour.uncheck();await expect(page.getByTestId('invoice-total')).toHaveText('$2,760.00');
 await page.getByLabel('Premium (%)',{exact:true}).fill('10');await expect(page.getByTestId('invoice-total')).toHaveText('$2,840.00');
 await page.getByLabel('Item 2 type',{exact:true}).selectOption('service');await expect(flight).toBeChecked();
 await page.getByLabel('Item 2 type',{exact:true}).selectOption('expense');await expect(flight).not.toBeChecked();
 await expect(page.getByTestId('invoice-total')).toHaveText('$2,800.00');
 await page.getByLabel('Item 1 type',{exact:true}).selectOption('expense');await page.getByLabel('Item 1 type',{exact:true}).selectOption('service');await expect(labour).toBeChecked();
 await page.getByLabel('Tax rate (%)',{exact:true}).fill('5');await expect(page.getByTestId('invoice-total')).toHaveText('$3,045.00');
});

test('legacy templates remain eligible and saved templates preserve explicit overrides and accepted methods',async({page})=>{
 const calls=await fixture(page);await page.getByLabel('Saved invoice template',{exact:true}).selectOption('legacy');
 await expect(page.getByLabel('Item 2 type',{exact:true})).toHaveValue('service');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).toBeChecked();await expect(page.getByTestId('invoice-total')).toHaveText('$2,660.00');
 await page.getByLabel('Item 1 apply discounts/premiums',{exact:true}).uncheck();await page.getByLabel('Item 2 type',{exact:true}).selectOption('expense');await page.getByLabel('Item 2 apply discounts/premiums',{exact:true}).check();
 await page.getByLabel('Offer all payment methods',{exact:true}).uncheck();await page.getByLabel('Accept Lightning',{exact:true}).uncheck();await page.getByLabel('Accept Bank transfer',{exact:true}).uncheck();
 await page.getByLabel('Template name',{exact:true}).fill('Fictional override template');await page.getByRole('button',{name:'Save as new template',exact:true}).click();await expect(page.getByRole('status')).toContainText('Template saved');
 expect(calls[0].body.draft.items).toMatchObject([{kind:'service',adjustmentEligible:false},{kind:'expense',adjustmentEligible:true}]);expect(calls[0].body.draft.acceptedMethods).toEqual(['bitcoin']);
 await page.getByLabel('Item 2 type',{exact:true}).selectOption('service');await page.getByLabel('Saved invoice template',{exact:true}).selectOption('saved');
 await expect(page.getByLabel('Item 1 apply discounts/premiums',{exact:true})).not.toBeChecked();await expect(page.getByLabel('Item 2 type',{exact:true})).toHaveValue('expense');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).toBeChecked();
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(calls[1].body).toEqual(calls[0].body.draft);
});

test('review initialDraft keeps exact dates and line flags through parent rerenders and custom submit',async({page})=>{
 const attempts:Call[]=[];await page.route('**/api/fictional-lines/issue',async route=>{attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});await route.fulfill({json:{id:'fictional-review-issued'}});});
 await fixture(page,'?review');await expect(page.getByTestId('invoice-total')).toHaveText('$2,700.00');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).not.toBeChecked();
 await page.getByRole('button',{name:'Replace parent draft',exact:true}).click();await expect(page.getByLabel('Invoice title',{exact:true})).toHaveValue('Fictional review draft');await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).not.toBeChecked();
 await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');
 expect(attempts[0].body.draft).toMatchObject({issueDate:'2028-02-28',dueDate:'2028-03-29',paymentTermDays:30,paymentTerms:'Fictional review terms',items:[{kind:'service',adjustmentEligible:true},{kind:'expense',adjustmentEligible:false}]});expect(attempts[0].key).toBeTruthy();
});

for(const status of [408,503])test(`uncertain ${status} saves freeze line choices and retry the same payload and key`,async({page})=>{
 await fixture(page);await labourAndFlights(page);const attempts:Call[]=[];
 await page.route('**/api/hackathon-demo/invoices',async route=>{attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});await route.fulfill(attempts.length===1?{status,json:{error:'Fictional uncertain save'}}:{json:{invoice:{id:'fictional-created'}}});});
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional uncertain save');
 await expect(page.getByLabel('Item 2 type',{exact:true})).toBeDisabled();await expect(page.getByLabel('Item 2 apply discounts/premiums',{exact:true})).toBeDisabled();await expect(page.getByLabel('Saved invoice template',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Retry saved invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(attempts[1]).toEqual(attempts[0]);expect(attempts[0].body.items[1]).toMatchObject({kind:'expense',adjustmentEligible:false});expect(attempts[0].key).toBeTruthy();
});

test('mobile line type and eligibility remain keyboard accessible without overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);await labourAndFlights(page);
 const type=page.getByLabel('Item 2 type',{exact:true}),eligible=page.getByLabel('Item 2 apply discounts/premiums',{exact:true});
 await type.focus();await page.keyboard.press('Home');await expect(type).toHaveValue('service');await page.keyboard.press('Tab');await expect(eligible).toBeFocused();await page.keyboard.press('Space');await expect(eligible).not.toBeChecked();
 await page.screenshot({path:test.info().outputPath('mobile-line-adjustments.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});

test('public invoice and print explain excluded lines while rendering immutable stored totals and escaped text',async({page})=>{
 const description='Fictional <img src=x onerror="window.__lineExecuted=true"> flights';
 await page.route('**/api/checkout/fictional-lines',route=>route.fulfill({json:{invoice:{...legacy,items:[{...legacy.items[0],kind:'service',adjustmentEligible:true},{...legacy.items[1],description,kind:'expense',adjustmentEligible:false}],number:'QL-FICTIONAL-LINES',subtotal:280000,discountAmount:10000,premiumAmount:0,tax:0,total:270123,status:'open',createdAt:'2026-11-06T00:00:00Z'},payment:{mode:'simulation',amountSats:1,request:'fictional'},adapters:[]}}));
 await fixture(page,'?checkout');await expect(page.getByTestId('checkout-due')).toHaveText('$2,701.23');
 await expect(page.locator('.checkout-items').getByText('Service / labour · Discounts/premiums apply',{exact:true})).toBeVisible();await expect(page.locator('.checkout-items').getByText('Expense / reimbursement · Excluded from discounts/premiums',{exact:true})).toBeVisible();
 await expect(page.getByText('Discounts and premiums apply only to eligible lines before tax.',{exact:true})).toBeVisible();await expect(page.getByText(description,{exact:true})).toBeVisible();await expect(page.locator('.checkout-items img')).toHaveCount(0);expect(await page.evaluate(()=>Boolean((window as any).__lineExecuted))).toBe(false);
 await page.emulateMedia({media:'print'});await expect(page.getByText('Expense / reimbursement · Excluded from discounts/premiums',{exact:true})).toBeVisible();await expect(page.getByTestId('checkout-due')).toHaveText('$2,701.23');await page.screenshot({path:test.info().outputPath('print-line-adjustments.png'),fullPage:true});
});
