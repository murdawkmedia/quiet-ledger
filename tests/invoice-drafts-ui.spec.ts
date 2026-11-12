import {test,expect,type Page,type Route} from '@playwright/test';

// Fictional route-mocked backend mirroring the real /api/invoice-drafts
// service rules: versioned raw snapshots, natural-replay saves that retry the
// exact payload, exactly-once issue with an idempotency key, and immutable
// issued drafts. Everything stays on loopback; no network, no real records.

const NOW='2026-11-11T12:00:00Z';
const ABSOLUTE_ID='22222222-2222-4222-8222-222222222222';
const TERM_ID='33333333-3333-4333-8333-333333333333';
const LIST_ID='11111111-1111-4111-8111-111111111111';
const ISSUED_LIST_ID='55555555-5555-4555-8555-555555555555';
const INVOICE_ID='44444444-4444-4444-8444-444444444444';
const absoluteSource={id:ABSOLUTE_ID,number:'QL-FICTIONAL-ABS',token:'fictional-absolute-token',title:'Fictional issued workshop',customerName:'Fictional Studio',customerEmail:'studio@example.test',currency:'CAD',items:[{description:'Fictional labour',quantity:1,unitAmount:200000,kind:'service' as const,adjustmentEligible:true},{description:'Fictional fixed flights',quantity:1,unitAmount:80000,kind:'expense' as const,adjustmentEligible:false}],taxBps:500,discountBps:0,premiumBps:0,subtotal:280000,tax:14000,total:294000,status:'open',createdAt:NOW,issueDate:'2026-10-02',dueDate:'2026-10-24',paymentTerms:'Fictional terms.',note:'Fictional note.',billing:{sellerName:'Fictional Seller'}};
const termSource={...absoluteSource,id:TERM_ID,number:'QL-FICTIONAL-TERM',dueDate:'2026-12-08',paymentTermDays:30};
const today=()=>{const now=new Date();return new Date(now.getTime()-now.getTimezoneOffset()*60000).toISOString().slice(0,10);};

interface StoredRow{revision:number;status:'draft'|'issued';invoiceId?:string;snapshot:any;createdAt:string;updatedAt:string}
interface Backend{puts:{path:string;body:any;csrf?:string}[];issues:{path:string;body:any;key?:string}[];deletes:string[];errors:string[]}

async function backend(page:Page,options:{saveFailures?:number;issueFailures?:number;conflict?:boolean;seed?:{id:string;revision:number;snapshot:any;status?:'draft'|'issued';invoiceId?:string}[]}={}){
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  const store=new Map<string,StoredRow>();
  for(const row of options.seed??[])store.set(row.id,{revision:row.revision,status:row.status??'draft',invoiceId:row.invoiceId,snapshot:row.snapshot,createdAt:NOW,updatedAt:NOW});
  const puts:Backend['puts']=[],issues:Backend['issues']=[],deletes:string[]=[];
  let saveFailures=options.saveFailures??0,issueFailures=options.issueFailures??0;
  const summary=(id:string)=>{const row=store.get(id)!;return {id,revision:row.revision,createdAt:row.createdAt,updatedAt:row.updatedAt,status:row.status,invoiceId:row.invoiceId,title:row.snapshot.title??'',customerName:row.snapshot.customerName??'',currency:row.snapshot.currency};};
  await page.route('**/api/invoice-drafts',route=>route.fulfill({json:{drafts:[...store.keys()].map(summary)}}));
  await page.route('**/api/invoice-drafts/**',route=>{
    const req=route.request(),segments=new URL(req.url()).pathname.split('/'),id=segments[3]??'';
    if(req.method()==='GET'){const row=store.get(id);return row?route.fulfill({json:{draft:{...summary(id),snapshot:row.snapshot}}}):route.fulfill({status:404,json:{error:'Saved draft not found.'}});}
    if(req.method()==='DELETE'){deletes.push(id);const row=store.get(id);if(!row)return route.fulfill({status:404,json:{error:'Saved draft not found.'}});if(row.status==='issued')return route.fulfill({status:409,json:{error:'This draft has already been issued. Its saved invoice remains unchanged.'}});store.delete(id);return route.fulfill({json:{deleted:true}});}
    if(req.method()==='PUT'){
      const body=req.postDataJSON();puts.push({path:new URL(req.url()).pathname,body,csrf:req.headers()['x-csrf-token']});
      if(options.conflict)return route.fulfill({status:409,json:{error:'This draft was saved again elsewhere. Reopen it to continue from the saved version.'}});
      if(saveFailures-->0)return route.fulfill({status:500,json:{error:'Fictional save failure.'}});
      const row=store.get(id),content=JSON.stringify(body.snapshot);
      if(row){
        if(row.status==='issued')return route.fulfill({status:409,json:{error:'This draft has already been issued. Its saved invoice remains unchanged.'}});
        if(content===JSON.stringify(row.snapshot)&&(body.expectedRevision===row.revision||body.expectedRevision===row.revision-1))return route.fulfill({json:{draft:summary(id)}});
        if(body.expectedRevision!==row.revision)return route.fulfill({status:409,json:{error:'This draft was saved again elsewhere. Reopen it to continue from the saved version.'}});
        row.snapshot=body.snapshot;row.revision++;row.updatedAt=NOW;return route.fulfill({json:{draft:summary(id)}});
      }
      if(body.expectedRevision!==0)return route.fulfill({status:404,json:{error:'This saved draft no longer exists. It may have been discarded in another window.'}});
      store.set(id,{revision:1,status:'draft',snapshot:body.snapshot,createdAt:NOW,updatedAt:NOW});return route.fulfill({json:{draft:summary(id)}});
    }
    if(req.method()==='POST'){ // /issue
      const body=req.postDataJSON();issues.push({path:new URL(req.url()).pathname,body,key:req.headers()['idempotency-key']});
      if(issueFailures-->0)return route.fulfill({status:500,json:{error:'Fictional issue failure.'}});
      const row=store.get(id);if(!row)return route.fulfill({status:404,json:{error:'Saved draft not found.'}});
      row.status='issued';row.invoiceId=INVOICE_ID;
      return route.fulfill({json:{invoice:{...absoluteSource,id:INVOICE_ID,issueDate:body.invoice.issueDate,title:body.invoice.title,customerName:body.invoice.customerName,items:body.invoice.items},draft:summary(id)}});
    }
    return route.fulfill({status:405,json:{error:'Unsupported method.'}});
  });
  await page.route('**/api/invoices/*',route=>{const id=new URL(route.request().url()).pathname.split('/').pop()!;return route.fulfill({json:id===TERM_ID?termSource:absoluteSource});});
  await page.route('**/api/clients',route=>route.fulfill({json:{clients:[]}}));
  await page.route('**/api/invoice-templates',route=>route.fulfill({json:{templates:[]}}));
  return {puts,issues,deletes,errors};
}

const listSnapshot={version:1,customerName:'Fictional List Client',customerEmail:'',title:'Fictional list draft',issueDate:'2026-11-11',dueDate:'',currency:'CAD',tax:'5',discount:'0',premium:'0',note:'',lines:[{id:'list-line-1',description:'Fictional list labour',quantity:'1',price:'100.00',kind:'service',adjustmentEligible:true}],schedule:'calendar',customDays:'',paymentTerms:'',allMethods:true,accepted:[],methodRules:[],clientId:'',billing:{},carriedLineIds:[]};

async function fillBasics(page:Page){
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional Draft Client');
  await page.getByLabel('Invoice title',{exact:true}).fill('Fictional saved draft');
  await page.getByLabel('Item 1 description').fill('Fictional labour');
  await page.getByLabel('Item 1 unit price').fill('125.00');
}

test('fresh owner editor autosaves privately, moves to its draft route and restores on reload',async({page})=>{
  const api=await backend(page);
  await page.goto('/invoices/new');
  await fillBasics(page);
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft saved');
  expect(api.puts).toHaveLength(1);
  expect(api.puts[0].csrf).toBe('fictional-invoice-drafts-csrf');
  expect(api.puts[0].body.expectedRevision).toBe(0);
  expect(api.puts[0].body.snapshot.version).toBe(1);
  expect(api.puts[0].body.snapshot.customerName).toBe('Fictional Draft Client');
  await expect(page).toHaveURL(/\/drafts\/[0-9a-f-]{36}$/);
  expect(await page.evaluate(()=>Number.isSafeInteger(history.state?.quietLedgerNavigationIndex))).toBe(true);
  await page.reload();
  await expect(page.getByLabel('Customer name',{exact:true})).toHaveValue('Fictional Draft Client');
  await expect(page.getByLabel('Item 1 description')).toHaveValue('Fictional labour');
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft saved');
  expect(api.puts).toHaveLength(1); // restoring exact content does not save again
  expect(api.errors).toEqual([]);
});

test('a pristine blank draft is never sent to the server',async({page})=>{
  const api=await backend(page);
  await page.goto('/invoices/new');
  await expect(page.getByTestId('draft-save-status-text')).toHaveText('No changes yet');
  await page.waitForTimeout(2200);
  expect(api.puts).toHaveLength(0);
  expect(api.errors).toEqual([]);
});

test('an unresolved save retries the exact payload and revision, then recovers',async({page})=>{
  const api=await backend(page,{saveFailures:1});
  await page.goto('/invoices/new');
  await fillBasics(page);
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft save unresolved');
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft saved');
  expect(api.puts).toHaveLength(2);
  expect(api.puts[1].body).toEqual(api.puts[0].body);
  expect(api.errors).toEqual([]);
});

test('a conflicting save surfaces an honest error and never claims saved',async({page})=>{
  const api=await backend(page,{conflict:true});
  await page.goto('/invoices/new');
  await fillBasics(page);
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft not saved: This draft was saved again elsewhere');
  await expect(page).toHaveURL(/\/invoices\/new$/);
  expect(api.puts.length).toBeGreaterThanOrEqual(1);
  expect(api.errors).toEqual([]);
});

test('duplicating an issued invoice resets dates, marks carried expenses and gates issuing on review',async({page})=>{
  const api=await backend(page);
  await page.goto('/invoices/new?duplicate='+ABSOLUTE_ID);
  await expect(page.getByText('absolute due date was cleared',{exact:false})).toBeVisible();
  await expect(page.getByLabel('Issue date',{exact:true})).toHaveValue(today());
  await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('');
  const review=page.getByTestId('carried-expense-review');
  await expect(review).toBeVisible();
  await expect(review.getByText('Fictional fixed flights',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'Create invoice',exact:true})).toBeDisabled();
  await page.getByTestId('carried-expense-ack').check();
  await expect(page.getByRole('button',{name:'Create invoice',exact:true})).toBeEnabled();
  // Editing a carried expense changes the fingerprint and reopens the review.
  await page.getByLabel('Item 2 description').fill('Fictional amended flights');
  await expect(page.getByTestId('carried-expense-ack')).not.toBeChecked();
  await expect(page.getByRole('button',{name:'Create invoice',exact:true})).toBeDisabled();
  await page.getByTestId('carried-expense-ack').check();
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.getByTestId('invoices-page')).toBeVisible();
  expect(api.issues).toHaveLength(1);
  expect(api.issues[0].key).toBeTruthy();
  expect(api.issues[0].body.invoice.customerName).toBe('Fictional Studio');
  expect(api.issues[0].body.invoice.issueDate).toBe(today());
  expect(api.issues[0].body.invoice.dueDate).toBeUndefined();
  expect(api.issues[0].body.invoice.id).toBeUndefined();
  expect(api.issues[0].body.invoice.items[1]).toMatchObject({description:'Fictional amended flights',kind:'expense',adjustmentEligible:false});
  expect(api.puts.length).toBeGreaterThanOrEqual(1); // issuing saves the reviewed draft first
  expect(api.errors).toEqual([]);
});

test('a duplicated Net 30 invoice keeps its relative terms and recomputes the due date',async({page})=>{
  await backend(page);
  await page.goto('/invoices/new?duplicate='+TERM_ID);
  await expect(page.getByLabel('Payment schedule',{exact:true})).toHaveValue('30');
  await expect(page.getByLabel('Issue date',{exact:true})).toHaveValue(today());
  const due=new Date(today()+'T00:00:00');due.setDate(due.getDate()+30);
  await expect(page.getByText('Due '+due.toISOString().slice(0,10),{exact:false})).toBeVisible();
});

test('carried review controls stay locked while an issue is in flight',async({page})=>{
  const api=await backend(page),dialogs:string[]=[];
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
  let release!:()=>void,started!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;}),inFlight=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/invoice-drafts/*/issue',async route=>{started();await gate;await route.fallback();});
  await page.goto('/invoices/new?duplicate='+ABSOLUTE_ID);
  await page.getByTestId('carried-expense-ack').check();
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await inFlight;
  try{
    await expect(page.getByTestId('carried-expense-ack')).toBeDisabled();
    await expect(page.getByTestId('carried-expense-remove')).toBeDisabled();
  }finally{release();}
  await expect(page.getByTestId('invoices-page')).toBeVisible();
  expect(dialogs).toEqual([]);expect(api.issues).toHaveLength(1);expect(api.errors).toEqual([]);
});

test('an unresolved issue retries the exact reviewed invoice and idempotency key',async({page})=>{
  const api=await backend(page,{issueFailures:1});
  await page.goto('/invoices/new?duplicate='+ABSOLUTE_ID);
  await page.getByTestId('carried-expense-ack').check();
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.getByRole('button',{name:'Retry saved invoice',exact:true})).toBeVisible();
  await expect(page.getByTestId('carried-expense-ack')).toBeDisabled();
  await expect(page.getByTestId('carried-expense-remove')).toBeDisabled();
  await page.getByRole('button',{name:'Retry saved invoice',exact:true}).click();
  await expect(page.getByTestId('invoices-page')).toBeVisible();
  expect(api.issues).toHaveLength(2);
  expect(api.issues[1].key).toBe(api.issues[0].key);
  expect(api.issues[1].body).toEqual(api.issues[0].body);
  expect(api.errors).toEqual([]);
});

test('the saved-drafts list restores without saving, discards once and keeps issued drafts immutable',async({page})=>{
  const api=await backend(page,{seed:[{id:LIST_ID,revision:3,snapshot:listSnapshot},{id:ISSUED_LIST_ID,revision:1,snapshot:{...listSnapshot,title:'Fictional issued draft'},status:'issued',invoiceId:INVOICE_ID}]});
  await page.goto('/drafts');
  const rows=page.getByTestId('saved-draft-row');
  await expect(rows).toHaveCount(2);
  await page.getByRole('link',{name:'Fictional list draft',exact:true}).click();
  await expect(page.getByLabel('Customer name',{exact:true})).toHaveValue('Fictional List Client');
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft saved');
  expect(api.puts).toHaveLength(0); // a restored, unedited draft saves nothing
  await page.goto('/drafts');
  const issuedRow=rows.filter({hasText:'Fictional issued draft'});
  await expect(issuedRow).toContainText('Issued');
  await expect(issuedRow.getByTestId('saved-draft-discard')).toHaveCount(0);
  await rows.filter({hasText:'Fictional list draft'}).getByTestId('saved-draft-discard').click();
  await expect(rows).toHaveCount(1);
  expect(api.deletes).toEqual([LIST_ID]);
  expect(api.errors).toEqual([]);
});

test('leaving with unsaved changes asks first and can be refused',async({page})=>{
  const dialogs:string[]=[];let accept=false;
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await (accept?dialog.accept():dialog.dismiss());});
  await backend(page);
  await page.goto('/invoices/new');
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional Guarded Client');
  await page.getByRole('link',{name:'Cancel',exact:true}).click();
  await expect(page.getByTestId('draft-save-status-text')).toHaveText('Unsaved changes');
  await expect(page).toHaveURL(/\/invoices\/new/);
  expect(dialogs).toHaveLength(1);
  accept=true;
  await page.getByRole('link',{name:'Cancel',exact:true}).click();
  await expect(page.getByTestId('invoices-page')).toBeVisible();
});

test('a save finishing after departure never changes a different new editor URL',async({page})=>{
  await backend(page);
  let release:(()=>void)|undefined,hold=true;
  await page.route('**/api/invoice-drafts/**',async route=>{
    if(hold&&route.request().method()==='PUT'){hold=false;await new Promise<void>(resolve=>{release=resolve;});}
    await route.fallback();
  });
  page.on('dialog',dialog=>dialog.accept());
  await page.goto('/invoices/new');
  const saving=page.waitForRequest(request=>request.method()==='PUT'&&request.url().includes('/api/invoice-drafts/'));
  await fillBasics(page);await saving;
  await page.getByRole('link',{name:'Cancel',exact:true}).click();
  await expect(page.getByTestId('invoices-page')).toBeVisible();
  await page.getByRole('link',{name:'Create invoice',exact:true}).click();
  await expect(page.getByLabel('Customer name',{exact:true})).toHaveValue('');
  const completed=page.waitForResponse(response=>response.request().method()==='PUT'&&response.url().includes('/api/invoice-drafts/'));
  release!();await completed;
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  await expect(page).toHaveURL(/\/invoices\/new$/);
  await expect(page.getByTestId('draft-save-status-text')).toHaveText('No changes yet');
});

for(const direction of ['back','forward'] as const)test(`browser ${direction} preserves unsaved edits when departure is declined`,async({page})=>{
  let accept=false;
  const dialogs:string[]=[];
  page.on('dialog',async dialog=>{dialogs.push(dialog.message());await(accept?dialog.accept():dialog.dismiss());});
  await backend(page,{conflict:true});
  if(direction==='back'){
    await page.goto('/invoices');
    await page.getByRole('link',{name:'Create invoice',exact:true}).click();
  }else{
    await page.goto('/invoices/new');
    await page.getByRole('link',{name:'Cancel',exact:true}).click();
    await page.goBack();
  }
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional history-preserved edit');
  await expect(page.getByTestId('draft-save-status-text')).toContainText('Draft not saved');
  await(direction==='back'?page.goBack():page.goForward());
  await expect(page).toHaveURL(/\/invoices\/new$/);
  await expect(page.getByLabel('Customer name',{exact:true})).toHaveValue('Fictional history-preserved edit');
  expect(dialogs).toHaveLength(1);
  accept=true;
  await(direction==='back'?page.goBack():page.goForward());
  await expect(page.getByTestId('invoices-page')).toBeVisible();
  expect(dialogs).toHaveLength(2);
});
