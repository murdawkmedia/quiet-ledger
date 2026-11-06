import {test,expect,type Page} from '@playwright/test';
test.beforeEach(async({page})=>{page.on('pageerror',error=>{throw error;});});
const legacy={customerName:'Fictional terms client',title:'Fictional terms service',currency:'CAD',items:[{description:'Fictional service',quantity:1,unitAmount:10000}],issueDate:'2026-01-10',dueDate:'2026-01-25',taxBps:0,note:'Fictional legacy note'};
const relative={...legacy,issueDate:'2024-01-01',dueDate:'2024-01-31',paymentTermDays:30,paymentTerms:'Fictional monthly terms'};
type Call={url:string;body:any;key?:string};
async function fixture(page:Page,query=''){
 const calls:Call[]=[];
 await page.route('**/api/clients',r=>r.fulfill({json:{clients:[]}}));
 await page.route('**/api/invoice-templates',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{templates:[{id:'legacy',label:'Fictional calendar template',draft:legacy},{id:'relative',label:'Fictional relative template',draft:relative}]}});
  calls.push({url:route.request().url(),body:route.request().postDataJSON()});
  await route.fulfill({json:{template:{id:'saved',...route.request().postDataJSON()}}});
 });
 await page.route('**/api/hackathon-demo/invoices',async route=>{calls.push({url:route.request().url(),body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});await route.fulfill({json:{invoice:{id:'fictional-created'}}});});
 await page.goto('/tests/fixtures/payment-terms-ui.html'+query);return calls;
}
for(const [issue,days,due] of [['2028-02-28','30','2028-03-29'],['2026-01-31','30','2026-03-02'],['2026-03-07','30','2026-04-06'],['2026-12-31','60','2027-03-01'],['2028-02-29','90','2028-05-29'],['2026-11-01','0','2026-11-01']]){
 test(`relative ${days} days from ${issue} yields calendar date ${due}`,async({page})=>{
  const calls=await fixture(page);await page.getByLabel('Issue date',{exact:true}).fill(issue);
  await page.getByLabel('Payment schedule',{exact:true}).selectOption(days);
  await expect(page.getByLabel('Due date',{exact:true})).toHaveValue(due);
  await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();
  await expect(page.locator('body')).toHaveAttribute('data-created','true');
  expect(calls[0].body).toMatchObject({issueDate:issue,dueDate:due,paymentTermDays:Number(days)});
 });
}
test('issue edits recompute relative terms and a calendar override returns to absolute dates',async({page})=>{
 const calls=await fixture(page);await page.getByLabel('Issue date',{exact:true}).fill('2028-02-28');await page.getByLabel('Payment schedule',{exact:true}).selectOption('30');
 await page.getByLabel('Issue date',{exact:true}).fill('2028-03-01');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2028-03-31');
 await page.getByLabel('Due date',{exact:true}).fill('2028-04-15');await expect(page.getByLabel('Payment schedule',{exact:true})).toHaveValue('calendar');
 await page.getByLabel('Issue date',{exact:true}).fill('2028-03-02');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2028-04-15');
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');
 expect(calls[0].body.dueDate).toBe('2028-04-15');expect(calls[0].body).not.toHaveProperty('paymentTermDays');
});
test('custom days and separate client terms round-trip through a saved template and invoice payload',async({page})=>{
 await page.clock.install({time:new Date('2028-02-28T18:00:00Z')});const calls=await fixture(page);await page.getByLabel('Issue date',{exact:true}).fill('2028-02-28');await page.getByLabel('Payment schedule',{exact:true}).selectOption('custom');
 await page.getByLabel('Custom payment days',{exact:true}).fill('15');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2028-03-14');
 await page.getByLabel('Payment terms',{exact:true}).fill('  Fictional terms: pay after review.\nNo actual payment.  ');
 await page.getByLabel('Payment terms / customer note',{exact:true}).fill('Fictional legacy customer note');await page.getByLabel('Template name',{exact:true}).fill('Fictional custom terms');
 await page.getByRole('button',{name:'Save as new template',exact:true}).click();await expect(page.getByRole('status')).toContainText('Template saved');
 expect(calls[0].body.draft).toMatchObject({paymentTermDays:15,dueDate:'2028-03-14',paymentTerms:'Fictional terms: pay after review.\nNo actual payment.',note:'Fictional legacy customer note'});
 await page.getByLabel('Payment terms',{exact:true}).fill('Fictional changed text');await page.getByLabel('Custom payment days',{exact:true}).fill('99');await page.getByLabel('Saved invoice template',{exact:true}).selectOption('saved');await expect(page.getByLabel('Custom payment days',{exact:true})).toHaveValue('15');await expect(page.getByLabel('Payment terms',{exact:true})).toHaveValue('Fictional terms: pay after review.\nNo actual payment.');
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(calls[1].body).toEqual(calls[0].body.draft);
});
test('custom day bounds block malformed submission and allow zero and the maximum',async({page})=>{
 const calls=await fixture(page);await page.getByLabel('Issue date',{exact:true}).fill('2026-11-06');await page.getByLabel('Payment schedule',{exact:true}).selectOption('custom');
 const days=page.getByLabel('Custom payment days',{exact:true});
 for(const value of ['','-1','1.5','3651']){await days.fill(value);await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();expect(calls).toHaveLength(0);expect(await days.evaluate(n=>(n as HTMLInputElement).checkValidity())).toBe(false);}
 await days.fill('3650');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2036-11-03');await days.fill('0');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2026-11-06');
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(calls[0].body.paymentTermDays).toBe(0);
});
test('relative template reuse rebases to today while legacy calendar template retains its dates',async({page})=>{
 await page.clock.install({time:new Date('2028-02-28T18:00:00Z')});const calls=await fixture(page);
 await page.getByLabel('Saved invoice template',{exact:true}).selectOption('relative');await expect(page.getByLabel('Issue date',{exact:true})).toHaveValue('2028-02-28');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2028-03-29');await expect(page.getByLabel('Payment terms',{exact:true})).toHaveValue(relative.paymentTerms);
 await page.getByLabel('Saved invoice template',{exact:true}).selectOption('legacy');await expect(page.getByLabel('Payment schedule',{exact:true})).toHaveValue('calendar');await expect(page.getByLabel('Issue date',{exact:true})).toHaveValue(legacy.issueDate);await expect(page.getByLabel('Due date',{exact:true})).toHaveValue(legacy.dueDate);await expect(page.getByLabel('Payment terms',{exact:true})).toHaveValue('');expect(calls).toEqual([]);
});
test('mobile controls support keyboard entry with no overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});await fixture(page);const schedule=page.getByLabel('Payment schedule',{exact:true});await schedule.focus();await page.keyboard.press('End');await page.keyboard.press('Enter');await expect(schedule).toHaveValue('custom');
 expect(await page.locator('.invoice-dates-grid').evaluate(n=>getComputedStyle(n).gridTemplateColumns.split(' ').length)).toBe(1);await page.getByLabel('Custom payment days',{exact:true}).fill('45');await page.getByLabel('Payment terms',{exact:true}).fill('Fictional mobile terms');await page.screenshot({path:test.info().outputPath('mobile-terms.png'),fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('review initialization happens once and custom submit receives the edited draft and stable retry key',async({page})=>{
 const attempts:Call[]=[];await page.route('**/api/fictional-review/issue',async route=>{attempts.push({url:route.request().url(),body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});if(attempts.length===1)return route.abort('connectionreset');await route.fulfill({json:{id:'fictional-review-issued'}});});
 await fixture(page,'?review');await expect(page.getByLabel('Invoice title',{exact:true})).toHaveValue('Fictional review draft');await expect(page.getByLabel('Payment schedule',{exact:true})).toHaveValue('30');await expect(page.getByLabel('Item 1 unit price',{exact:true})).toHaveValue('123.45');
 await page.getByRole('button',{name:'Replace parent draft',exact:true}).click();await expect(page.getByLabel('Invoice title',{exact:true})).toHaveValue('Fictional review draft');
 await page.getByLabel('Payment terms',{exact:true}).fill('Fictional reviewed terms');await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await page.getByRole('button',{name:'Retry saved invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(attempts[0].key).toBeTruthy();expect(attempts[0].body.draft).toMatchObject({paymentTermDays:30,paymentTerms:'Fictional reviewed terms',dueDate:'2028-03-29',note:'Fictional legacy note'});
});
test('public invoice and print show escaped client terms independently from the legacy note',async({page})=>{
 const terms='Fictional <img src=x onerror="window.__termsExecuted=true"> terms\nSecond fictional line.';
 await page.route('**/api/checkout/fictional-terms',route=>route.fulfill({json:{invoice:{...relative,paymentTerms:terms,number:'QL-FICTIONAL-TERMS',subtotal:10000,tax:0,total:10000,status:'open',createdAt:'2026-11-06T00:00:00Z'},payment:{mode:'simulation',amountSats:1,request:'fictional'},adapters:[]}}));
 await fixture(page,'?checkout');const section=page.getByRole('region',{name:'Payment terms',exact:true});await expect(section).toContainText(terms);await expect(section.locator('img')).toHaveCount(0);expect(await page.evaluate(()=>Boolean((window as any).__termsExecuted))).toBe(false);await expect(page.getByText(legacy.note,{exact:true})).toBeVisible();
 await page.emulateMedia({media:'print'});await expect(section).toBeVisible();await page.screenshot({path:test.info().outputPath('print-terms.png'),fullPage:true});expect(await section.locator('p').last().evaluate(n=>getComputedStyle(n).whiteSpace)).toBe('pre-wrap');
});
for(const review of [false,true])for(const status of [408,503])test(`unknown ${status} ${review?'review':'standard'} creation freezes the saved payload until its exact retry succeeds`,async({page})=>{
 const attempts:Call[]=[];const endpoint=review?'**/api/fictional-review/issue':'**/api/hackathon-demo/invoices';
 await fixture(page,review?'?review':'');
 await page.route(endpoint,async route=>{attempts.push({url:route.request().url(),body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});if(attempts.length===1)return route.fulfill({status,json:{error:'Fictional uncertain response'}});await route.fulfill({json:review?{id:'fictional-review-issued'}:{invoice:{id:'fictional-created'}}});});
 await page.getByLabel('Invoice title',{exact:true}).fill('Fictional saved terms');await page.getByRole('button',{name:review?'Create invoice':'Create demo invoice',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('Fictional uncertain response');await expect(page.getByLabel('Invoice title',{exact:true})).toBeDisabled();await expect(page.getByLabel('Saved invoice template',{exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Retry saved invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);expect(attempts[0].key).toBeTruthy();
});
test('definite validation failure permits correction and a fresh submission key',async({page})=>{
 const calls=await fixture(page);let first=true;await page.route('**/api/hackathon-demo/invoices',async route=>{calls.push({url:route.request().url(),body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});if(first){first=false;return route.fulfill({status:400,json:{error:'Fictional definite rejection'}});}await route.fulfill({json:{invoice:{id:'fictional-created'}}});});
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional definite rejection');await expect(page.getByLabel('Invoice title',{exact:true})).toBeEnabled();await page.getByLabel('Invoice title',{exact:true}).fill('Fictional corrected invoice');await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(calls[1].key).not.toBe(calls[0].key);
});
