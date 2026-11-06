import {test,expect} from '@playwright/test';
for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
 test(`invoice email checkboxes stay compact with readable labels at ${viewport.width}px`,async({page})=>{
  await page.setViewportSize(viewport);
  const {invoiceId}=await page.request.post('/fixture/owner').then(response=>response.json());
  await page.goto('/invoices/'+invoiceId+'/email');
  await expect(page.getByRole('heading',{name:'Email your invoice.',exact:true})).toBeVisible();
  const rows=page.locator('.invoice-email-checkbox');await expect(rows).toHaveCount(1);
  const boxes=await rows.evaluateAll(labels=>labels.map(label=>{const input=label.querySelector('input')!;return{inputWidth:input.getBoundingClientRect().width,inputHeight:input.getBoundingClientRect().height,labelHeight:label.getBoundingClientRect().height};}));
  console.log(JSON.stringify({viewport:viewport.width,checkboxes:boxes}));
  for(const box of boxes){expect(box.inputWidth).toBeGreaterThanOrEqual(14);expect(box.inputWidth).toBeLessThanOrEqual(24);expect(box.inputHeight).toBeLessThanOrEqual(24);expect(box.labelHeight).toBeLessThan(100);}
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect((await page.getByLabel('Invoice email recipients',{exact:true}).boundingBox())!.width).toBeGreaterThan(150);
 });
}
test('a private owner saves recipients and Gmail, previews a copy and submits once through the mock transport',async({page})=>{
 const login=await page.request.post('/fixture/owner');const {invoiceId}=await login.json();await page.goto('/invoices/'+invoiceId+'/email');
 await expect(page.getByLabel('Invoice email recipients',{exact:true})).toHaveValue('client@example.test');await page.getByLabel('My invoice copy address',{exact:true}).fill('merchant@example.test');
 await page.getByRole('button',{name:'Add common recipient',exact:true}).click();await page.getByLabel('Saved contact 1 name',{exact:true}).fill('Fictional accountant');await page.getByLabel('Saved contact 1 email',{exact:true}).fill('accountant@example.test');
 await page.getByRole('button',{name:'Save email settings',exact:true}).click();await expect(page.getByLabel('Common recipients',{exact:true}).locator('option')).toContainText(['Choose a saved or previous invoice contact','Fictional accountant · accountant@example.test','Fictional client · client@example.test']);
 await page.getByLabel('Gmail sender address',{exact:true}).fill('merchant@example.test');await page.getByLabel('Google App Password',{exact:true}).fill('abcdefghijklmnop');await page.getByRole('button',{name:'Save and connect Gmail',exact:true}).click();await expect(page.getByText('Gmail authenticated. No test email was sent.',{exact:true})).toBeVisible();await expect(page.getByLabel('Google App Password',{exact:true})).toHaveValue('');
 await page.getByLabel('Send a copy to myself',{exact:false}).check();await page.getByRole('button',{name:'Preview email',exact:true}).click();await expect(page.getByRole('region',{name:'Invoice email preview'})).toContainText('merchant@example.test');
 await page.getByRole('button',{name:'Send invoice from merchant@example.test',exact:true}).click();await expect(page.getByText('Gmail accepted the message for every recipient. Delivery and reading are not verified.',{exact:true})).toBeVisible();
 expect((await page.request.get('/fixture/submissions').then(r=>r.json())).submissions).toBe(1);await page.reload();await expect(page.getByRole('heading',{name:'Recent submissions.',exact:true})).toBeVisible();await expect(page.getByText('Accepted by Gmail',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Prepare mail app draft',exact:true}).click();await expect(page.getByRole('link',{name:'Open email app',exact:true})).toHaveAttribute('href',/^mailto:client%40example\.test\?.*subject=/);await page.request.post('/fixture/verification',{data:{ok:false}});await page.getByRole('button',{name:'Save and connect Gmail',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Gmail could not authenticate this connection.');await expect(page.getByText('Saved · not verified',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:/Send invoice from/})).toHaveCount(0);await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('demo opens invoice email from the saved list but only offers fictional preview and planned Marmot copy',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'Hackathon demo',exact:true}).click();await page.getByLabel('Demo password',{exact:true}).fill('marmot');await page.getByRole('button',{name:'Enter hackathon demo',exact:true}).click();await page.getByRole('link',{name:'Demo invoices',exact:true}).click();await page.getByRole('link',{name:'Email',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Preview the invoice email.',exact:true})).toBeVisible();await page.getByLabel('Invoice email recipients',{exact:true}).fill('client@example.test');await page.getByRole('button',{name:'Preview email',exact:true}).click();await expect(page.getByText('Preview ready. No email has been sent.',{exact:true})).toBeVisible();await expect(page.getByLabel('Google App Password',{exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:/Send invoice from/})).toHaveCount(0);await expect(page.getByRole('link',{name:'Open email app',exact:true})).toHaveCount(0);await expect(page.getByLabel(/Marmot/)).toBeDisabled();
});
