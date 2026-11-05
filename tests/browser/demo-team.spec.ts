import {test,expect,type Page} from '@playwright/test';
import {writeFile} from 'node:fs/promises';
async function enter(page:Page){await page.goto('/');await page.getByRole('button',{name:'Hackathon demo',exact:true}).click();await page.getByLabel('Demo password',{exact:true}).fill('marmot');await page.getByRole('button',{name:'Enter hackathon demo',exact:true}).click();await expect(page).toHaveURL(/\/demo$/);}
test('the fictional demo has a browser entry to its client and accountant team',async({page})=>{test.skip(Boolean(process.env.QUIET_LEDGER_TEAM_URL),'Covered by the full actual-runtime case.');await enter(page);await expect(page.getByRole('link',{name:'Talk to the demo team',exact:true})).toBeVisible();});

test.afterEach(async({page})=>{if(!process.env.QUIET_LEDGER_TEAM_URL)return;await page.evaluate(async()=>{const session=await fetch('/api/session').then(r=>r.json());if(!session.hackathonDemo)return;await fetch('/api/hackathon-demo/agents/reset',{method:'POST',headers:{'content-type':'application/json','x-csrf-token':session.csrfToken},body:'{}'});}).catch(()=>{});});
test('actual browser, native MDK and Hermes keep conversation and ledger authority separate',async({page})=>{
  test.skip(!process.env.QUIET_LEDGER_TEAM_URL,'Requires the separately configured actual local or hosted agent service.');
  const started=Date.now(),metrics:{prepareSeconds?:number;replySeconds:number[];journeySeconds?:number}={replySeconds:[]};
  await enter(page);await page.goto('/demo/new');
  await page.getByLabel('Invoice title',{exact:true}).fill('Fictional Marmot workshop recording');
  await page.getByLabel('Invoice currency',{exact:true}).selectOption('KRW');
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('150000');
  await page.getByLabel('Discount (%)',{exact:true}).fill('10');await page.getByLabel('Premium (%)',{exact:true}).fill('6');
  await page.getByLabel('Issue date',{exact:true}).fill('2026-11-05');await page.getByLabel('Due date',{exact:true}).fill('2026-11-12');
  await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page).toHaveURL(/\/demo\/team$/);
  const preparationStarted=Date.now();
  await page.getByRole('button',{name:'Start the demo team',exact:true}).click();
  await expect(page.getByText('All three participants connected',{exact:true})).toBeVisible({timeout:90000});
  metrics.prepareSeconds=(Date.now()-preparationStarted)/1000;
  const history=page.getByRole('log',{name:'Demo team decrypted messages'});
  let firstMessage=true;
  async function send(role:string,text:string,reply:RegExp){const sent=Date.now();await page.getByRole('combobox',{name:'Talk to',exact:true}).selectOption(role);await page.getByLabel('Message the demo team',{exact:true}).fill(text);let release:(()=>void)|undefined;if(firstMessage){firstMessage=false;let reached!:()=>void;const held=new Promise<void>(resolve=>reached=resolve);const ready=new Promise<void>(resolve=>release=resolve);let armed=true;await page.route('**/api/hackathon-demo/agents',async route=>{if(armed&&route.request().method()==='GET'){armed=false;reached();await ready;}await route.continue();});await held;}await page.getByRole('button',{name:'Send message',exact:true}).click();release?.();await expect(history.getByText(reply)).toBeVisible({timeout:60000});metrics.replySeconds.push((Date.now()-sent)/1000);}
  await send('client','What does the fictional workshop include?',/Riley, the AI demo client.*Fictional Marmot workshop recording.*KRW 144,000/);
  await send('accountant','Please check the total and tax on this invoice.',/Jordan, the AI demo accountant.*subtotal KRW 150,000.*discount KRW 15,000.*premium KRW 9,000.*total KRW 144,000/i);
  await send('accountant','I paid. What payment status is recorded in the ledger?',/Jordan, the AI demo accountant.*No payment is recorded/);
  await expect(page.getByText('Awaiting payment',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Pause agents',exact:true}).click();await expect(page.getByRole('button',{name:'Resume agents',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Resume agents',exact:true}).click();
  await page.getByRole('button',{name:'Simulate payment',exact:true}).click();await expect(page.getByText('Simulated payment recorded',{exact:true})).toBeVisible();
  await send('accountant','What payment and receipt status is recorded now?',/Jordan, the AI demo accountant.*snapshot v3.*one simulated KRW 144,000 receipt/);
  await send('client','How does Marmot make this conversation private?',/Riley, the AI demo client.*MLS.*ciphertext.*AI provider/i);
  metrics.journeySeconds=(Date.now()-started)/1000;console.log('Actual native+Hermes timing '+JSON.stringify(metrics));if(process.env.QUIET_LEDGER_TEAM_METRICS)await writeFile(process.env.QUIET_LEDGER_TEAM_METRICS,JSON.stringify(metrics,null,2)+'\n');expect(metrics.journeySeconds).toBeLessThan(180);
  const count=await history.locator('li').count();expect(count).toBe(10);await page.evaluate(()=>window.scrollTo(0,0));if(process.env.QUIET_LEDGER_TEAM_SCREENSHOT)await page.screenshot({path:process.env.QUIET_LEDGER_TEAM_SCREENSHOT,fullPage:true});await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);if(process.env.QUIET_LEDGER_TEAM_MOBILE_SCREENSHOT)await page.screenshot({path:process.env.QUIET_LEDGER_TEAM_MOBILE_SCREENSHOT,fullPage:true});await page.setViewportSize({width:1280,height:900});
  await page.reload();await page.getByRole('button',{name:'Start the demo team',exact:true}).click();await expect(page.getByText('All three participants connected',{exact:true})).toBeVisible({timeout:60000});await expect(history.locator('li')).toHaveCount(count);
  await page.getByRole('button',{name:'Refresh messages',exact:true}).click();await expect(history.locator('li')).toHaveCount(count);
  await page.getByRole('button',{name:'Reset team',exact:true}).click();await expect(page.getByRole('button',{name:'Start the demo team',exact:true})).toBeEnabled();await expect(history.locator('li')).toHaveCount(0);
});


test('a stalled reply releases the composer and a worker issue releases quick prompts',async({page})=>{
 test.skip(!process.env.QUIET_LEDGER_TEAM_URL,'Requires actual native participants for browser state verification.');
 await enter(page);await page.getByRole('link',{name:'Talk to the demo team',exact:true}).click();
 await page.getByRole('button',{name:'Start the demo team',exact:true}).click();await expect(page.getByText('All three participants connected',{exact:true})).toBeVisible({timeout:90000});
 await page.clock.install();
 await page.getByLabel('Message the demo team',{exact:true}).fill('Please confirm the scope of this fictional invoice.');
 await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByText('Riley is reviewing…',{exact:true})).toBeVisible();
 await page.clock.fastForward(45001);
 await expect(page.getByRole('alert')).toContainText('not replied within 45 seconds');
 await expect(page.getByRole('button',{name:'Confirm scope · Riley',exact:true})).toBeEnabled();
 // A sanitized runtime failure must release waiting state without discarding its encrypted outbox.
 let mode:'issue'|'failure'|'rounds'='issue';
 await page.route('**/api/hackathon-demo/agents',async route=>{if(route.request().method()!=='GET')return route.continue();if(mode==='failure')return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Fictional delivery check unavailable.'})});const response=await route.fetch();const team=await response.json();await route.fulfill({response,json:{...team,...(mode==='rounds'?{roundsRemaining:0}:{issue:'A demo AI turn could not complete. Try another message or reset the team.'})}});});
 await page.getByLabel('Message the demo team',{exact:true}).fill('Please confirm the current invoice wording.');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.getByRole('alert')).toContainText('A demo AI turn could not complete');
 await expect(page.getByRole('button',{name:'Confirm scope · Riley',exact:true})).toBeEnabled();
 mode='failure';await page.getByLabel('Message the demo team',{exact:true}).fill('Please confirm the fictional delivery note.');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional delivery check unavailable.');await expect(page.getByRole('button',{name:'Confirm scope · Riley',exact:true})).toBeEnabled();
 mode='rounds';await page.getByRole('button',{name:'Refresh messages',exact:true}).click();await expect(page.getByText('This demo’s reply allowance is used. Choose Reset team to start a fresh conversation.',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Confirm scope · Riley',exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'Reset team',exact:true})).toBeEnabled();
 await page.clock.resume();
});
