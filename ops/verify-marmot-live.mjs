// Creates one isolated, fictional demo visit. Never enters a real account or provider.
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {chromium} from '@playwright/test';
const origin=process.env.QUIET_LEDGER_ORIGIN;
assert(origin,'Set QUIET_LEDGER_ORIGIN to the exact test installation origin.');
const target=new URL(origin);
assert(target.origin===origin&&(target.protocol==='https:'||(target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname))),'Use an exact HTTPS or loopback HTTP test origin.');
const artifacts=resolve(process.env.QUIET_LEDGER_DEMO_ARTIFACTS??'.runtime/live-marmot-artifacts');
await mkdir(artifacts,{recursive:true});
const browser=await chromium.launch({headless:true,executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE??'/usr/bin/chromium'});
const page=await browser.newPage({viewport:{width:1540,height:1050}});
const errors=[],external=[],sockets=[],events=[];
page.on('pageerror',error=>errors.push(error.message));page.on('websocket',socket=>sockets.push(new URL(socket.url()).origin));
page.on('request',request=>{const url=new URL(request.url());if(['http:','https:'].includes(url.protocol)&&url.origin!==origin)external.push(url.origin);if(request.method()==='POST'&&url.pathname.endsWith('/conversation/events'))events.push(request.postDataJSON().event);});
const visible=async locator=>{await locator.waitFor({state:'visible',timeout:30000});};
async function click(name){const button=page.getByRole('button',{name,exact:true});await visible(button);await button.click();}
async function prepare(){await click('Prepare demo');await visible(page.getByText('Both participants connected',{exact:true}));}
try{
  await page.goto(origin,{waitUntil:'networkidle'});await click('Hackathon demo');await page.getByLabel('Demo password',{exact:true}).fill('marmot');await click('Enter hackathon demo');
  await page.waitForURL('**/demo');await visible(page.getByRole('heading',{name:'A private conversation. A clear paper trail.',exact:true}));
  const session=await(await page.request.get(origin+'/api/session')).json();assert.equal(session.hackathonDemo,true);
  const before=await(await page.request.get(origin+'/api/hackathon-demo')).json();assert.equal(before.invoice.status,'open');assert.equal(before.invoice.settlementMode,'simulation');
  // Save opaque test identifiers immediately so a partial run is recoverable.
  const progress={created_at:new Date().toISOString(),demo_account_id:session.accountId,invoice_id:before.invoice.id};
  await writeFile(resolve(artifacts,'created-demo-visit.json'),JSON.stringify(progress,null,2)+'\n');
  console.log('One fictional demo visit created; opaque IDs saved in the private acceptance artifact.');
  await prepare();
  const merchant=page.getByRole('log',{name:'Merchant decrypted messages',exact:true}),customer=page.getByRole('log',{name:'Customer decrypted messages',exact:true});
  assert.equal(new Set(events.filter(event=>event.kind===30443).map(event=>event.pubkey)).size,2);
  assert.equal(await page.getByRole('button',{name:'Send receipt notice',exact:true}).isDisabled(),true);
  await click('Send private update');await visible(customer.getByText('A private update is available. Review it in Quiet Ledger.',{exact:true}));
  await click('Acknowledge update');await visible(merchant.getByText('I acknowledge the private update.',{exact:true}));
  await click('Request review');await visible(merchant.getByText('Please review the details in Quiet Ledger.',{exact:true}));
  await click('Simulate payment');await visible(page.getByText('Simulated payment recorded',{exact:true}));
  await click('Send receipt notice');await visible(customer.getByText('A receipt is ready. Open it in Quiet Ledger.',{exact:true}));
  await page.screenshot({path:resolve(artifacts,'demo-desktop.png'),fullPage:true,animations:'disabled'});
  const after=await(await page.request.get(origin+'/api/hackathon-demo')).json();assert.equal(after.invoice.status,'paid');assert.equal(after.invoice.settlementMode,'simulation');
  const publicInvoice=await page.request.get(origin+'/api/checkout/'+after.checkoutToken);assert.equal(publicInvoice.status(),200);assert.equal((await publicInvoice.json()).hackathonDemo,true);
  const denied=await page.request.post(origin+'/api/checkout/'+after.checkoutToken+'/pay',{headers:{Origin:origin,'X-CSRF-Token':session.csrfToken},data:{method:'cashu'}});assert.equal(denied.status(),403);
  assert.equal((await page.request.get(origin+'/api/account/connections')).status(),403);
  await page.reload({waitUntil:'networkidle'});await prepare();
  for(const value of ['A private update is available. Review it in Quiet Ledger.','I acknowledge the private update.','Please review the details in Quiet Ledger.','A receipt is ready. Open it in Quiet Ledger.']){
    assert.equal(await merchant.getByText(value,{exact:true}).count(),1);assert.equal(await customer.getByText(value,{exact:true}).count(),1);assert(!JSON.stringify(events).includes(value));
  }
  assert(!JSON.stringify(events).includes(before.invoice.title));assert(!JSON.stringify(events).includes(before.invoice.customerName));
  await page.setViewportSize({width:390,height:844});await page.getByRole('tab',{name:'Customer',exact:true}).click();await visible(customer);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:resolve(artifacts,'demo-mobile.png'),fullPage:true,animations:'disabled'});
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(sockets,[]);
  await click('Open navigation');await click('Leave workspace');await visible(page.getByRole('button',{name:'Hackathon demo',exact:true}));
  const result={...progress,origin,passed_at:new Date().toISOString(),actual_marmot_sdk:true,distinct_messaging_identities:2,opposite_participants_decrypted:['update','acknowledge','review','receipt-notice'],simulation_receipt:true,reload_exactly_once:true,demo_financial_and_provider_denials:true,no_external_http_or_websocket:true,no_browser_errors:true,mobile_no_overflow:true,logout:true,published_event_kinds:[...new Set(events.map(event=>event.kind))]};
  await writeFile(resolve(artifacts,'live-acceptance.json'),JSON.stringify(result,null,2)+'\n');console.log('Hosted fictional demo, real encrypted messaging, isolation, reload, mobile and logout checks passed.');
}finally{await browser.close();}
