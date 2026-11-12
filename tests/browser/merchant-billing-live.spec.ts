import {test,expect,type Page} from '@playwright/test';
import {randomUUID} from 'node:crypto';
import {startMerchantBillingFixture,merchantBillingOwnerToken} from '../merchant-billing-app.js';
import type {Invoice} from '../../shared/contracts.js';

// Real browser -> real Express/SQLite app mounted from `createApp`, serving the built
// client with the new /billing routes and checkout projection. The live payment is a
// controlled synthetic bank request settled only by the owner's explicit manual
// review inside the app UI. No external URL is opened, intercepted or fetched.
const deliverableUrl='https://files.fictional.invalid/final-cut.mp4';
const deliverableUrlV2='https://files.fictional.invalid/final-cut-v2.mp4';

async function currentInvoice(page:Page,origin:string):Promise<Invoice>{
  const list=await(await page.request.get(origin+'/api/invoices')).json();
  const invoice=list.invoices.find((row:Invoice)=>row.title==='Final cut delivery');
  expect(invoice).toBeTruthy();
  return invoice;
}

test('owner billing journey: milestone invoice, paid-gated deliverable link and revocation',async({page},info)=>{
  test.setTimeout(120000);
  const fixture=await startMerchantBillingFixture(),errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  try{
    // Sign in with the fictional fixed owner token; the Billing nav entry is owner-only.
    await page.goto(fixture.origin);
    await page.getByRole('button',{name:'I have an owner token',exact:true}).click();
    await page.getByLabel('Owner token',{exact:true}).fill(merchantBillingOwnerToken);
    await page.getByRole('button',{name:'Open private workspace',exact:true}).click();
    await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
    await page.getByRole('link',{name:'Billing',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Projects & milestones.',exact:true})).toBeVisible();

    // Project and milestone planning records through the real router.
    await page.getByLabel('New project name',{exact:true}).fill('Fictional merchant project');
    await page.getByRole('button',{name:'Add project',exact:true}).click();
    const project=page.locator('.billing-project').filter({hasText:'Fictional merchant project'});
    await expect(project).toBeVisible();
    await page.getByLabel('Milestone label',{exact:true}).fill('Final cut delivery');
    await page.getByLabel('Planned amount',{exact:true}).fill('1250.00');
    await page.getByLabel('Milestone project',{exact:true}).selectOption({label:'Fictional merchant project'});
    await page.getByRole('button',{name:'Add milestone',exact:true}).click();
    const milestone=project.locator('.billing-milestone').filter({hasText:'Final cut delivery'});
    await expect(milestone).toBeVisible();
    await expect(milestone.getByText('No invoice linked yet.',{exact:true})).toBeVisible();

    // The existing immutable InvoiceEditor is prefilled from the milestone (pathname
    // route only) and issues exactly one invoice that is linked back to the milestone.
    await milestone.getByRole('button',{name:'Create invoice',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Invoice "Final cut delivery"',exact:true})).toBeVisible();
    await expect(page.getByLabel('Invoice title',{exact:true})).toHaveValue('Final cut delivery');
    await expect(page.getByLabel('Item 1 description',{exact:true})).toHaveValue('Final cut delivery');
    await expect(page.getByLabel('Item 1 unit price',{exact:true})).toHaveValue('1250.00');
    await expect(page.getByLabel('Invoice currency',{exact:true})).toHaveValue('CAD');
    await page.getByLabel('Customer name',{exact:true}).fill('Marmot Field Lab (fictional)');
    await page.getByRole('button',{name:'Create invoice',exact:true}).click();
    await expect(page).toHaveURL(/\/billing$/);
    await expect(milestone.getByText(/No invoice linked yet/)).toHaveCount(0);
    const invoice=await currentInvoice(page,fixture.origin);
    await expect(milestone.locator('.billing-milestone-main').getByText(new RegExp(invoice.number))).toBeVisible();

    // A deliverable link is saved on the issued invoice and starts Locked.
    await page.getByLabel('Deliverable invoice',{exact:true}).selectOption(invoice.id);
    await page.getByLabel('Deliverable label',{exact:true}).fill('Final recording (MP4)');
    await page.getByLabel('Delivery link',{exact:true}).fill(deliverableUrl);
    await page.getByRole('button',{name:'Add deliverable',exact:true}).click();
    // Deliverables render both in the standalone section and inside each milestone
    // row; scope to the standalone "Deliverables" panel for a unique row.
    const deliverable=page.locator('section.panel').filter({has:page.getByRole('heading',{name:'Deliverables',exact:true})}).locator('.billing-deliverable').filter({hasText:'Final recording (MP4)'});
    await expect(deliverable.getByText('Locked',{exact:true})).toBeVisible();
    await expect(deliverable.getByText('Not shown until an authoritative live payment covers the invoice.')).toBeVisible();

    // Payer checkout before payment: no deliverable link or URL anywhere in the DOM.
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);
    await expect(page.getByText('Live checkout',{exact:true})).toBeVisible();
    await expect(page.getByRole('link',{name:'Final recording (MP4)'})).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain('files.fictional.invalid');

    // Controlled live payment: the payer requests the bank method; the synthetic
    // provider always requires review, so only the owner's explicit in-app
    // confirmation can record the live receipt.
    await page.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('bank');
    await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
    await expect(page).toHaveURL(/\/receive\/[^/]+$/);
    await expect(page.getByRole('heading',{name:'A place for your payment.',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'Check payment',exact:true}).click();
    await expect(page.getByRole('heading',{name:'Awaiting payment review.',exact:true})).toBeVisible();
    await page.goto(fixture.origin+'/payment-methods');
    const card=page.locator('.receiving-card').filter({hasText:invoice.number});
    await expect(card).toBeVisible();
    await card.getByRole('button',{name:'Review a manually verified payment',exact:true}).click();
    await card.getByLabel(/Received transaction reference/).fill('FICTIONAL-MERCHANT-BANK-REFERENCE');
    await card.getByLabel('Verification note',{exact:true}).fill('Synthetic fixture: independently checked the exact received currency, amount and invoice.');
    await card.getByLabel('I verified the exact asset, network, amount and invoice',{exact:true}).check();
    await card.getByRole('button',{name:'Confirm independently verified payment',exact:true}).click();
    await expect(card.getByText('Verified',{exact:true})).toBeVisible();

    // Explicit release after the verified live payment readies the link.
    await page.goto(fixture.origin+'/billing');
    await deliverable.getByRole('button',{name:'Release',exact:true}).click();
    await expect(deliverable.getByText('Released',{exact:true})).toBeVisible();
    await expect(deliverable.getByText('Verified paid — shown on checkout while released.')).toBeVisible();

    // The paid checkout keeps its receipt card and also shows the released link as a
    // plain HTTPS anchor in a new tab; nothing is fetched, proxied or iframed.
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);
    await expect(page.getByRole('heading',{name:'Payment recorded.',exact:true})).toBeVisible();
    const link=page.getByRole('link',{name:'Final recording (MP4)',exact:true});
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href',deliverableUrl);
    await expect(link).toHaveAttribute('target','_blank');
    await expect(link).toHaveAttribute('rel',/(?:^|\s)noopener(?:\s|$)/);
    await expect(link).toHaveAttribute('rel',/(?:^|\s)noreferrer(?:\s|$)/);
    await expect(page.locator('a[href^="https://files.fictional.invalid"]')).toHaveCount(1);
    await expect(page.getByText(/cannot revoke, watermark or expire that destination/)).toBeVisible();
    await page.screenshot({path:info.outputPath('merchant-billing-released-checkout.png'),fullPage:true});

    // Editing the destination URL clears the release; the payer sees nothing until a
    // new explicit release, and the new URL is the only one that can reappear.
    await page.goto(fixture.origin+'/billing');
    await deliverable.getByLabel('New delivery link for Final recording (MP4)').fill(deliverableUrlV2);
    await deliverable.getByRole('button',{name:'Update link',exact:true}).click();
    await expect(deliverable.getByText('Locked',{exact:true})).toBeVisible();
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);
    await expect(page.getByRole('link',{name:'Final recording (MP4)'})).toHaveCount(0);
    expect(await page.locator('body').textContent()).not.toContain('files.fictional.invalid');
    await page.goto(fixture.origin+'/billing');
    await deliverable.getByRole('button',{name:'Release',exact:true}).click();
    await expect(deliverable.getByText('Released',{exact:true})).toBeVisible();
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);
    await expect(page.getByRole('link',{name:'Final recording (MP4)',exact:true})).toHaveAttribute('href',deliverableUrlV2);

    // Revoking the invoice links removes the public checkout capability entirely, and
    // no invoice UUID resolves as a checkout or deliverable route.
    const session=await(await page.request.get(fixture.origin+'/api/session')).json();
    await page.request.post(`${fixture.origin}/api/invoices/${invoice.id}/revoke-links`,{headers:{'X-CSRF-Token':session.csrfToken,'Idempotency-Key':randomUUID()}});
    await page.goto(`${fixture.origin}/pay/${invoice.token}`);
    await expect(page.getByRole('heading',{name:'We couldn’t open this invoice.',exact:true})).toBeVisible();
    await page.goto(`${fixture.origin}/pay/${invoice.id}`);
    await expect(page.getByRole('heading',{name:'We couldn’t open this invoice.',exact:true})).toBeVisible();

    await page.setViewportSize({width:390,height:844});
    await page.goto(fixture.origin+'/billing');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:info.outputPath('merchant-billing-projects-mobile.png'),fullPage:true});
    expect(errors).toEqual([]);
  }finally{
    await page.goto('about:blank').catch(()=>{});
    await fixture.close();
  }
});
