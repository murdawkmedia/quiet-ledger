import {test,expect,type Locator,type Page,type Route} from '@playwright/test';

// Fictional stateful loopback backend behind Playwright route mocks. It mirrors
// the real /api/billing projections and rules (caps aside): encrypted-record
// shapes, project delete only when empty, URL edits clearing release, and the
// paid gate staying closed without an authoritative live payment. No network.
const NOW='2026-11-08T12:00:00Z';
const INVOICE_ID='22222222-2222-4222-8222-222222222222';
const INVOICE2_ID='77777777-7777-4777-8777-777777777777';
const PROJECT_ID='33333333-3333-4333-8333-333333333333';
const MILESTONE_ID='44444444-4444-4444-8444-444444444444';
const DELIVERABLE_ID='55555555-5555-4555-8555-555555555555';
const CREATED_INVOICE_ID='66666666-6666-4666-8666-666666666666';
const invoice={id:INVOICE_ID,number:'INV-BILLING-1',title:'Final cut delivery',customerName:'Fictional Studio',currency:'CAD',items:[{description:'Final cut delivery',quantity:1,unitAmount:125000,kind:'service',adjustmentEligible:true}],subtotal:125000,taxBps:0,tax:0,discountBps:0,premiumBps:0,total:125000,status:'open',createdAt:NOW,issueDate:'2026-11-08',dueDate:'2026-12-08',paymentTermDays:30};
const unpaidInvoice={...invoice,id:INVOICE2_ID,number:'INV-BILLING-2'};
const createdInvoice={...invoice,id:CREATED_INVOICE_ID,number:'INV-BILLING-NEW'};
const paidSummary={id:INVOICE_ID,number:'INV-BILLING-1',currency:'CAD',total:125000,effectiveTotal:125000,paid:125000,due:0,state:'paid',mode:'live'};
// Every interaction below is keyboard-only: focus, typing, Enter and arrow keys.

async function kbdType(page:Page,field:Locator,text:string){await field.focus();await page.keyboard.press('ControlOrMeta+a');await page.keyboard.type(text);}
async function kbdSubmit(page:Page,control:Locator){await control.focus();await page.keyboard.press('Enter');}
async function kbdNextOption(page:Page,select:Locator){await select.focus();await page.keyboard.press('ArrowDown');}

async function backend(page:Page,options:{linkFailures?:number;seedMilestone?:boolean}={}){
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>void dialog.accept());
  const projects:{id:string;name:string;createdAt:string}[]=[];
  const milestones:{id:string;projectId:string|null;label:string;amount:number;currency:string;invoiceId:string|null;createdAt:string;updatedAt:string}[]=[];
  const deliverables:{id:string;invoiceId:string;label:string;url:string;released:boolean;createdAt:string;updatedAt:string}[]=[];
  if(options.seedMilestone)milestones.push({id:MILESTONE_ID,projectId:null,label:'Final cut delivery',amount:125000,currency:'CAD',invoiceId:null,createdAt:NOW,updatedAt:NOW});
  const mutations:{method:string;path:string;key?:string;csrf?:string;body:any}[]=[],invoicePosts:{key?:string;draft:any}[]=[],linkPatches:{key?:string;invoiceId:string}[]=[];
  let linkAttempts=0;
  const deliverableView=(row:(typeof deliverables)[number])=>({id:row.id,invoiceId:row.invoiceId,invoiceNumber:row.invoiceId===INVOICE_ID?invoice.number:unpaidInvoice.number,label:row.label,released:row.released,releaseReady:row.invoiceId===INVOICE_ID,createdAt:row.createdAt,updatedAt:row.updatedAt});
  const milestoneView=(row:(typeof milestones)[number])=>({id:row.id,projectId:row.projectId,label:row.label,amount:row.amount,currency:row.currency,createdAt:row.createdAt,updatedAt:row.updatedAt,invoice:row.invoiceId===INVOICE_ID?paidSummary:row.invoiceId===INVOICE2_ID?{...paidSummary,id:INVOICE2_ID,number:'INV-BILLING-2',paid:0,due:125000,state:'unpaid'}:undefined,deliverables:deliverables.filter(d=>d.invoiceId===row.invoiceId).map(deliverableView)});
  const overview=()=>({projects:projects.map(p=>({id:p.id,name:p.name,createdAt:p.createdAt,milestones:milestones.filter(m=>m.projectId===p.id).map(milestoneView)})),looseMilestones:milestones.filter(m=>!m.projectId).map(milestoneView),deliverables:deliverables.map(deliverableView)});
  const record=(route:Route)=>{const req=route.request();mutations.push({method:req.method(),path:new URL(req.url()).pathname,key:req.headers()['idempotency-key'],csrf:req.headers()['x-csrf-token'],body:req.postDataJSON()});};
  await page.route('**/api/billing/projects',route=>{const req=route.request();
    if(req.method()==='GET')return route.fulfill({json:overview()});
    record(route);const body=req.postDataJSON();const project={id:PROJECT_ID,name:body.name,createdAt:NOW};projects.push(project);
    return route.fulfill({status:201,json:{project:{id:project.id,name:project.name,createdAt:project.createdAt,milestones:[]}}});});
  await page.route('**/api/billing/projects/*',route=>{const req=route.request(),id=req.url().split('/').pop()!;record(route);
    if(req.method()==='PATCH'){const body=req.postDataJSON();const row=projects.find(v=>v.id===id);if(row)row.name=body.name;return route.fulfill({json:{project:{id,name:body.name,createdAt:NOW,milestones:[]}}});}
    if(req.method()==='DELETE'){if(milestones.some(m=>m.projectId===id))return route.fulfill({status:409,json:{error:'Delete the milestones first.'}});const index=projects.findIndex(v=>v.id===id);if(index>=0)projects.splice(index,1);return route.fulfill({json:{deleted:true}});}
    return route.fulfill({status:405,json:{error:'Unsupported method.'}});});
  await page.route('**/api/billing/milestones',route=>{const req=route.request();record(route);const body=req.postDataJSON();
    if(body.projectId&&body.projectId!==PROJECT_ID)return route.fulfill({status:400,json:{error:'Choose one of your projects.'}});
    const milestone={id:MILESTONE_ID,projectId:body.projectId??null,label:body.label,amount:body.amount,currency:body.currency,invoiceId:body.invoiceId??null,createdAt:NOW,updatedAt:NOW};milestones.push(milestone);
    return route.fulfill({status:201,json:{milestone:milestoneView(milestone)}});});
  await page.route('**/api/billing/milestones/*',route=>{const req=route.request(),id=req.url().split('/').pop()!;
    if(req.method()==='GET'){const row=milestones.find(v=>v.id===id);return row?route.fulfill({json:{milestone:milestoneView(row)}}):route.fulfill({status:404,json:{error:'Milestone not found.'}});}
    if(req.method()==='DELETE'){record(route);const index=milestones.findIndex(v=>v.id===id);if(index>=0)milestones.splice(index,1);return route.fulfill({json:{deleted:true}});}
    record(route);const body=req.postDataJSON();
    if(body.invoiceId!==undefined){
      linkPatches.push({key:req.headers()['idempotency-key'],invoiceId:body.invoiceId});
      if(linkAttempts++<(options.linkFailures??0))return route.fulfill({status:500,json:{error:'Linking failed fictionally.'}});
      const row=milestones.find(v=>v.id===id);if(row)row.invoiceId=body.invoiceId;
      return route.fulfill({json:{milestone:row?milestoneView(row):null}});
    }
    const row=milestones.find(v=>v.id===id);if(row){row.label=body.label??row.label;row.updatedAt=NOW;}
    return route.fulfill({json:{milestone:row?milestoneView(row):null}});});
  await page.route('**/api/billing/deliverables',route=>{const req=route.request();record(route);const body=req.postDataJSON();
    if(body.invoiceId!==INVOICE_ID&&body.invoiceId!==INVOICE2_ID)return route.fulfill({status:400,json:{error:'Choose one of your invoices.'}});
    if(typeof body.url!=='string'||!body.url.startsWith('https://'))return route.fulfill({status:400,json:{error:'Enter a valid https:// delivery link without credentials.'}});
    const deliverable={id:deliverables.length?DELIVERABLE_ID.concat('2'):DELIVERABLE_ID,invoiceId:body.invoiceId,label:body.label,url:body.url,released:false,createdAt:NOW,updatedAt:NOW};deliverables.push(deliverable);
    return route.fulfill({status:201,json:{deliverable:deliverableView(deliverable)}});});
  await page.route('**/api/billing/deliverables/*/release',route=>{record(route);const id=route.request().url().split('/').slice(-2)[0],row=deliverables.find(v=>v.id===id);if(row)row.released=true;
    return route.fulfill({json:{deliverable:row?deliverableView(row):null}});});
  await page.route('**/api/billing/deliverables/*',route=>{const req=route.request(),id=req.url().split('/').pop()!;
    if(req.method()==='PATCH'){record(route);const body=req.postDataJSON();const row=deliverables.find(v=>v.id===id);
      if(row){if(body.url!==undefined){row.url=body.url;row.released=false;}if(body.label!==undefined)row.label=body.label;row.updatedAt=NOW;}
      return route.fulfill({json:{deliverable:row?deliverableView(row):null}});}
    if(req.method()==='DELETE'){record(route);const index=deliverables.findIndex(v=>v.id===id);if(index>=0)deliverables.splice(index,1);return route.fulfill({json:{deleted:true}});}
    return route.fulfill({status:405,json:{error:'Unsupported method.'}});});
  await page.route('**/api/invoices',route=>{const req=route.request();
    if(req.method()==='GET')return route.fulfill({json:{invoices:[invoice,unpaidInvoice]}});
    invoicePosts.push({key:req.headers()['idempotency-key'],draft:req.postDataJSON()});
    return route.fulfill({status:201,json:createdInvoice});});
  await page.route('**/api/clients',route=>route.fulfill({json:{clients:[]}}));
  await page.route('**/api/invoice-templates',route=>route.fulfill({json:{templates:[]}}));
  return {mutations,invoicePosts,linkPatches,errors};
}

test('keyboard-only planning CRUD keeps the paid gate and forwarded-link limits visible',async({page})=>{
  const f=await backend(page);
  await page.goto('/tests/fixtures/billing-ui.html');
  await expect(page.getByRole('heading',{name:'Projects & milestones.',exact:true})).toBeVisible();
  await expect(page.getByText('No projects yet. Add one above, or save a milestone without a project below.',{exact:true})).toBeVisible();
  await kbdType(page,page.getByLabel('New project name',{exact:true}),'Studio retainer · Q4');
  await kbdSubmit(page,page.getByRole('button',{name:'Add project',exact:true}));
  await expect(page.getByRole('heading',{name:'Studio retainer · Q4',exact:true})).toBeVisible();
  await expect(page.locator('.success-message')).toContainText('Project created.');
  await kbdType(page,page.getByLabel('Project name for Studio retainer · Q4',{exact:true}),'Studio retainer · 2027');
  await kbdSubmit(page,page.getByRole('button',{name:'Save name',exact:true}));
  await expect(page.getByRole('heading',{name:'Studio retainer · 2027',exact:true})).toBeVisible();
  await kbdType(page,page.getByLabel('Milestone label',{exact:true}),'Final cut delivery');
  await kbdType(page,page.getByLabel('Planned amount',{exact:true}),'1250.00');
  await kbdNextOption(page,page.getByLabel('Milestone project',{exact:true}));
  await kbdSubmit(page,page.getByRole('button',{name:'Add milestone',exact:true}));
  await expect(page.getByText('Planned $1,250.00',{exact:true})).toBeVisible();
  await expect(page.getByText('No invoice linked yet.',{exact:true})).toBeVisible();
  await expect(page.getByText('Milestones without a project',{exact:true})).toHaveCount(0);
  await kbdType(page,page.getByLabel('Label for Final cut delivery',{exact:true}),'Final cut v2');
  await kbdSubmit(page,page.getByRole('button',{name:'Save label',exact:true}));
  await expect(page.getByRole('button',{name:'Delete milestone Final cut v2',exact:true})).toBeVisible();
  await kbdNextOption(page,page.getByLabel('Deliverable invoice',{exact:true}));
  await kbdType(page,page.getByLabel('Deliverable label',{exact:true}),'Final recording (MP4)');
  await kbdType(page,page.getByLabel('Delivery link',{exact:true}),'https://files.fictional.example/final-cut.mp4');
  await kbdSubmit(page,page.getByRole('button',{name:'Add deliverable',exact:true}));
  await expect(page.getByText('Final recording (MP4)',{exact:true})).toBeVisible();
  await expect(page.getByText('Locked',{exact:true})).toBeVisible();
  await expect(page.getByText('Verified paid — shown on checkout while released.',{exact:true})).toBeVisible();
  await expect(page.getByText('On INV-BILLING-1',{exact:true})).toBeVisible();
  await expect(page.getByText('Forwarded links have no take-back.',{exact:false})).toBeVisible();
  await kbdSubmit(page,page.getByRole('button',{name:'Release',exact:true}));
  await expect(page.getByText('Released',{exact:true})).toBeVisible();
  await expect(page.getByText('Verified paid — shown on checkout while released.',{exact:true})).toBeVisible();
  await kbdNextOption(page,page.getByLabel('Deliverable invoice',{exact:true}));
  await kbdType(page,page.getByLabel('Deliverable label',{exact:true}),'Draft recording (MP4)');
  await kbdType(page,page.getByLabel('Delivery link',{exact:true}),'https://files.fictional.example/final-cut-draft.mp4');
  await kbdSubmit(page,page.getByRole('button',{name:'Add deliverable',exact:true}));
  await expect(page.getByText('Draft recording (MP4)',{exact:true})).toBeVisible();
  await expect(page.getByText('Not shown until an authoritative live payment covers the invoice.',{exact:true})).toBeVisible();
  await expect(page.getByText('On INV-BILLING-2',{exact:true})).toBeVisible();
  await kbdSubmit(page,page.getByRole('button',{name:'Delete deliverable Draft recording (MP4)',exact:true}));
  await expect(page.getByText('Draft recording (MP4)',{exact:true})).toHaveCount(0);
  await kbdType(page,page.getByLabel('New delivery link for Final recording (MP4)',{exact:true}),'https://files.fictional.example/final-cut-v2.mp4');
  await kbdSubmit(page,page.getByRole('button',{name:'Update link',exact:true}));
  await expect(page.getByText('Locked',{exact:true})).toBeVisible();
  await expect(page.locator('.success-message')).toContainText('Delivery link updated. Release was cleared');
  await kbdSubmit(page,page.getByRole('button',{name:'Delete deliverable Final recording (MP4)',exact:true}));
  await expect(page.getByText('No deliverables yet. Add an invoice-linked https link above.',{exact:true})).toBeVisible();
  await kbdSubmit(page,page.getByRole('button',{name:'Delete milestone Final cut v2',exact:true}));
  await expect(page.locator('.success-message')).toContainText('Milestone deleted.');
  await kbdSubmit(page,page.getByRole('button',{name:'Delete project Studio retainer · 2027',exact:true}));
  await expect(page.getByText('No projects yet. Add one above, or save a milestone without a project below.',{exact:true})).toBeVisible();
  expect(f.mutations.map(call=>`${call.method} ${call.path}`)).toEqual([
    `POST /api/billing/projects`,`PATCH /api/billing/projects/${PROJECT_ID}`,
    'POST /api/billing/milestones',`PATCH /api/billing/milestones/${MILESTONE_ID}`,
    'POST /api/billing/deliverables',`POST /api/billing/deliverables/${DELIVERABLE_ID}/release`,
    'POST /api/billing/deliverables',`DELETE /api/billing/deliverables/${DELIVERABLE_ID}2`,
    `PATCH /api/billing/deliverables/${DELIVERABLE_ID}`,`DELETE /api/billing/deliverables/${DELIVERABLE_ID}`,
    `DELETE /api/billing/milestones/${MILESTONE_ID}`,`DELETE /api/billing/projects/${PROJECT_ID}`]);
  expect(f.mutations.every(call=>call.csrf==='fictional-billing-csrf'&&call.key)).toBe(true);
  expect(f.invoicePosts).toHaveLength(0);
  expect(f.errors).toEqual([]);
});

test('a milestone prefills the invoice editor and a failed link never issues a second invoice',async({page})=>{
  const f=await backend(page,{linkFailures:1,seedMilestone:true});
  await page.goto(`/tests/fixtures/billing-ui.html?milestone=${MILESTONE_ID}`);
  await expect(page.getByRole('heading',{name:'Invoice "Final cut delivery"',exact:true})).toBeVisible();
  await expect(page.getByLabel('Invoice title',{exact:true})).toHaveValue('Final cut delivery');
  await expect(page.getByLabel('Invoice currency',{exact:true})).toHaveValue('CAD');
  await expect(page.getByLabel('Item 1 description',{exact:true})).toHaveValue('Final cut delivery');
  await expect(page.getByLabel('Item 1 unit price',{exact:true})).toHaveValue('1250.00');
  await kbdType(page,page.getByLabel('Customer name',{exact:true}),'Fictional Studio');
  await kbdSubmit(page,page.getByRole('button',{name:'Create invoice',exact:true}));
  await expect(page.getByRole('heading',{name:'The invoice is issued.',exact:true})).toBeVisible();
  await expect(page.getByText(`Invoice ${createdInvoice.number} was created for Fictional Studio. It was not linked to the milestone yet.`,{exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Linking failed fictionally.');
  expect(await page.evaluate(()=>'created' in document.body.dataset)).toBe(false);
  expect(f.invoicePosts).toHaveLength(1);
  await kbdSubmit(page,page.getByRole('button',{name:'Retry link',exact:true}));
  await expect.poll(()=>page.evaluate(()=>'created' in document.body.dataset)).toBe(true);
  expect(f.invoicePosts).toHaveLength(1);
  expect(f.invoicePosts[0].key).toBeTruthy();
  expect(f.linkPatches.map(call=>call.key)).toEqual([`billing-link-${MILESTONE_ID}-${CREATED_INVOICE_ID}`,`billing-link-${MILESTONE_ID}-${CREATED_INVOICE_ID}`]);
  expect(f.errors).toEqual([]);
});

test('an uncertain project save retries the same operation key without duplicate rows on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await backend(page);
 const keys:string[]=[],projects:{id:string;name:string;createdAt:string;milestones:unknown[]}[]=[];
 const saved=new Map<string,(typeof projects)[number]>();
 await page.route('**/api/billing/projects',route=>{
  const req=route.request();if(req.method()==='GET')return route.fulfill({json:{projects,looseMilestones:[],deliverables:[]}});
  const key=req.headers()['idempotency-key'];keys.push(key);
  let project=saved.get(key);if(!project){project={id:projects.length?INVOICE_ID:PROJECT_ID,name:req.postDataJSON().name,createdAt:NOW,milestones:[]};saved.set(key,project);projects.push(project);}
  if(keys.length===1)return route.fulfill({status:503,json:{error:'Fictional uncertain save. Retry the same project.'}});
  return route.fulfill({status:201,json:{project}});
 });
 await page.goto('/tests/fixtures/billing-ui.html');
 await page.getByLabel('New project name',{exact:true}).fill('Fictional retry project');
 await page.getByRole('button',{name:'Add project',exact:true}).click();
 await expect(page.getByText('Fictional uncertain save. Retry the same project.',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Add project',exact:true}).click();
 await expect(page.getByRole('heading',{name:'Fictional retry project',exact:true})).toHaveCount(1);
 expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(projects).toHaveLength(1);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
});
