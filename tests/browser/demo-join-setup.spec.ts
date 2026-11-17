import {test,expect} from '@playwright/test';
test.afterEach(async({page})=>{await page.request.post('/api/hackathon-demo/agents/reset');});
test('each room join constructs one participant and keeps the same identity and isolated rooms',async({page,context})=>{
 await context.addCookies([{name:'ql_fixture_client',value:'241',url:'http://localhost:4352'}]);
 await page.route('**/demo-agent-engine.ts',async route=>{
  const response=await route.fetch();const body=await response.text();
  expect(body).toContain('function createDemoHumanParticipant');
  await route.fulfill({response,body:body+'\nconst originalParticipantFactory=createDemoHumanParticipant;createDemoHumanParticipant=async function(...args){window.__fictionalParticipantCreations=(window.__fictionalParticipantCreations??0)+1;return originalParticipantFactory(...args);};\n'});
 });
 await page.goto('/');await page.getByRole('button',{name:'Hackathon demo',exact:true}).click();
 await page.getByLabel('Demo password',{exact:true}).fill('marmot');await page.getByRole('button',{name:'Enter hackathon demo',exact:true}).click();
 await expect(page).toHaveURL(/\/demo$/);await page.goto('/demo/team');
 await page.getByRole('button',{name:'Start conversation',exact:true}).click();
 await expect(page.getByText('You and Riley connected',{exact:true})).toBeVisible();
 const creations=()=>page.evaluate(()=>Number((window as unknown as {__fictionalParticipantCreations?:number}).__fictionalParticipantCreations));
 expect(await creations()).toBe(1);
 const first=await page.request.get('/api/hackathon-demo/agents').then(r=>r.json());
 for(const [index,name] of ['Jordan','Group','Riley'].entries()){
  await page.getByRole('tab',{name,exact:true}).click();
  await expect(page.getByText(name==='Group'?'You, Riley and Jordan connected':`You and ${name} connected`,{exact:true})).toBeVisible();
  expect(await creations()).toBe(index+2);
 }
 const final=await page.request.get('/api/hackathon-demo/agents').then(r=>r.json());
 expect(final.humanPubkey).toBe(first.humanPubkey);expect(final.leaseId).toBe(first.leaseId);
 expect(final.rooms.client.groupId).toBe(first.rooms.client.groupId);
 expect(new Set(Object.values(final.rooms).map((room:any)=>room.groupId)).size).toBe(3);
});
