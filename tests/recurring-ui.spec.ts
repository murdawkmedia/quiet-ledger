import {test,expect,type Page} from '@playwright/test';
const templateId='00000000-0000-4000-8000-000000000053';
const draftInput={customerName:'Fictional Studio',title:'Fictional monthly service',currency:'CAD',items:[{description:'Fictional work',quantity:1,unitAmount:10000}],paymentTermDays:30};
async function fixture(page:Page,legacy=false){
 const state={plans:[] as any[],drafts:[] as any[],mutations:[] as {path:string;body:any;key?:string;csrf?:string}[],failPrepare:false};
 await page.route('**/api/**',async route=>{const req=route.request(),path=new URL(req.url()).pathname,body=req.method()==='POST'?req.postDataJSON():undefined;
  if(req.method()==='POST')state.mutations.push({path,body,key:req.headers()['idempotency-key'],csrf:req.headers()['x-csrf-token']});
  if(path==='/api/invoice-templates')return route.fulfill({json:{templates:[{id:templateId,label:'Fictional saved template',draft:legacy?{...draftInput,paymentTermDays:undefined,issueDate:'2025-01-01',dueDate:'2025-01-16'}:draftInput}]}});
  if(path==='/api/recurring/plans'&&req.method()==='POST'){const plan={...body,id:'fictional-plan',templateLabel:'Fictional saved template',templateDraft:draftInput,dueOffsetDays:body.dueOffsetDays??30,paused:false,createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z'};state.plans.unshift(plan);return route.fulfill({status:201,json:{plan}});}
  if(path==='/api/recurring/plans')return route.fulfill({json:{plans:state.plans}});
  if(path==='/api/recurring/drafts')return route.fulfill({json:{drafts:state.drafts}});
  if(path==='/api/recurring/prepare'){if(state.failPrepare){state.failPrepare=false;return route.fulfill({status:503,json:{error:'Fictional uncertain prepare response'}});}const row={id:'fictional-draft',planId:'fictional-plan',planLabel:'Fictional retained plan',periodIndex:0,periodDate:'2026-11-06',status:'draft',draft:draftInput,createdAt:'2026-11-06T00:00:00Z'};const created=state.drafts.length?[]:[row];state.drafts.push(...created);return route.fulfill({json:{drafts:created,createdCount:created.length,hasMore:false,asOf:'2026-11-06'}});}
  if(path==='/api/recurring/plans/fictional-plan/pause'){state.plans[0].paused=body.paused;return route.fulfill({json:{plan:state.plans[0]}});}
  return route.fulfill({status:404,json:{error:'Unmapped fictional endpoint'}});
 });return state;
}
const open=(page:Page)=>page.goto('/tests/fixtures/recurring-ui.html');
async function create(page:Page){await page.getByLabel('Saved invoice template',{exact:true}).selectOption(templateId);await page.getByLabel('Plan name',{exact:true}).fill('Fictional retained plan');await page.getByLabel('First issue date',{exact:true}).fill('2026-11-06');await page.getByRole('button',{name:'Save recurring plan',exact:true}).click();await expect(page.getByText('Fictional retained plan',{exact:true})).toBeVisible();}

test('loading is read-only; deliberate prepare creates review links and no invoice requests',async({page})=>{const state=await fixture(page);await open(page);await expect(page.getByRole('heading',{name:'Recurring drafts.',exact:true})).toBeVisible();expect(state.mutations).toHaveLength(0);await create(page);expect(state.mutations[0].body).toMatchObject({templateId,startDate:'2026-11-06',frequency:{type:'monthly'}});await page.getByRole('button',{name:'Prepare due drafts',exact:true}).click();await expect(page.getByRole('link',{name:'Review draft',exact:true})).toHaveAttribute('href','/recurring/drafts/fictional-draft');expect(state.mutations.every(row=>!row.path.includes('/issue')&&row.key&&row.csrf==='fictional-recurring-csrf')).toBe(true);});

test('fixed-day frequency and explicit legacy date conversion are submitted',async({page})=>{const state=await fixture(page,true);await open(page);await page.getByLabel('Saved invoice template',{exact:true}).selectOption(templateId);await expect(page.getByText(/absolute due date/i)).toBeVisible();await page.getByLabel('Days until payment is due',{exact:true}).fill('15');await page.getByLabel('Plan name',{exact:true}).fill('Fictional fortnight');await page.getByLabel('Frequency',{exact:true}).selectOption('days');await page.getByLabel('Repeat every (days)',{exact:true}).fill('14');await page.getByRole('button',{name:'Save recurring plan',exact:true}).click();await expect(page.getByText('Fictional fortnight',{exact:true})).toBeVisible();expect(state.mutations[0].body).toMatchObject({frequency:{type:'days',intervalDays:14},dueOffsetDays:15});});

test('uncertain preparation keeps exact action and key for deliberate retry',async({page})=>{const state=await fixture(page);await open(page);await create(page);state.failPrepare=true;await page.getByRole('button',{name:'Prepare due drafts',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Fictional uncertain prepare response');await page.getByRole('button',{name:'Retry saved action',exact:true}).click();await expect(page.getByRole('link',{name:'Review draft',exact:true})).toBeVisible();const requests=state.mutations.filter(row=>row.path==='/api/recurring/prepare');expect(requests).toHaveLength(2);expect(requests[0]).toEqual(requests[1]);});

test('pause and resume retain prepared drafts and mobile layout fits',async({page})=>{const state=await fixture(page);await page.setViewportSize({width:390,height:844});await open(page);await create(page);await page.getByRole('button',{name:'Prepare due drafts',exact:true}).click();await page.getByRole('button',{name:'Pause Fictional retained plan',exact:true}).click();await expect(page.getByRole('button',{name:'Resume Fictional retained plan',exact:true})).toBeVisible();await expect(page.getByRole('link',{name:'Review draft',exact:true})).toBeVisible();expect(state.plans[0].paused).toBe(true);await page.getByRole('button',{name:'Resume Fictional retained plan',exact:true}).click();expect(state.plans[0].paused).toBe(false);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);await page.screenshot({path:'.runtime/recurring-ui-mobile.png',fullPage:true});});

for(const kind of ['create','prepare'] as const)test(`HTTP408 retains the ${kind} body and key after a committed outcome`,async({page})=>{
 const state=await fixture(page),attempts:{body:unknown;key?:string}[]=[];await open(page);if(kind==='prepare')await create(page);
 const endpoint=kind==='create'?'/api/recurring/plans':'/api/recurring/prepare';
 await page.route('**'+endpoint,async route=>{
  if(route.request().method()!=='POST')return route.fallback();
  attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
  if(attempts.length===1)return route.fulfill({status:408,json:{error:'Fictional edge timeout after commit'}});
  return route.fulfill({status:kind==='create'?201:200,json:kind==='create'?{plan:{...attempts[0].body as object,id:'fictional-plan',templateLabel:'Fictional saved template',templateDraft:draftInput,paused:false,createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z'}}:{drafts:[],createdCount:0,hasMore:false,asOf:'2026-11-06'}});
 });
 if(kind==='create'){await page.getByLabel('Saved invoice template',{exact:true}).selectOption(templateId);await page.getByLabel('Plan name',{exact:true}).fill('Fictional 408 retry');await page.getByRole('button',{name:'Save recurring plan',exact:true}).click();}else await page.getByRole('button',{name:'Prepare due drafts',exact:true}).click();
 const retry=page.getByRole('button',{name:'Retry saved action',exact:true});await expect(retry).toBeVisible();await expect(page.getByRole('button',{name:kind==='create'?'Save recurring plan':'Prepare due drafts',exact:true})).toBeDisabled();await retry.click();await expect.poll(()=>attempts.length).toBe(2);expect(attempts[1]).toEqual(attempts[0]);
});
