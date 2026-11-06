import {test,expect} from '@playwright/test';
test('client mutations wait for the initial list and cannot be erased by a delayed empty response',async({page})=>{
 await page.request.post('/fixture/owner');let release!:()=>void,first=true;const held=new Promise<void>(r=>{release=r;});await page.route('**/api/clients',async route=>{if(first&&route.request().method()==='GET'){first=false;await held;return route.fulfill({json:{clients:[]}});}return route.continue();});
 await page.goto('/clients');await expect(page.getByRole('heading',{name:'Your clients.',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Save client',exact:true})).toBeDisabled();release();await page.getByLabel('Client name',{exact:true}).fill('Fictional retained client');await page.getByRole('button',{name:'Save client',exact:true}).click();await expect(page.getByRole('button',{name:'Edit Fictional retained client',exact:true})).toBeVisible();await page.reload();await expect(page.getByRole('button',{name:'Edit Fictional retained client',exact:true})).toBeVisible();
});
test('saving a note while older history is paginated preserves its order after loading more',async({page})=>{
 const {invoiceId}=await page.request.post('/fixture/owner').then(r=>r.json()),session=await page.request.get('/api/session').then(r=>r.json()),headers={'X-CSRF-Token':session.csrfToken,Origin:'http://localhost:4354'};
 for(let i=1;i<=60;i++){const response=await page.request.post(`/api/invoices/${invoiceId}/thread/messages`,{headers:{...headers,'Idempotency-Key':'fictional-note-'+i},data:{text:'Note '+String(i).padStart(3,'0')}});expect(response.status()).toBe(201);}
 await page.goto('/invoices/'+invoiceId+'/thread');await expect(page.locator('.business-thread .business-message-text')).toHaveCount(50);await page.getByLabel('Private note',{exact:true}).fill('Note 061');await page.getByRole('button',{name:'Save private note',exact:true}).click();await expect(page.getByText('Note 061',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Load more messages',exact:true}).click();await expect(page.locator('.business-thread .business-message-text')).toHaveCount(61);expect(await page.locator('.business-thread .business-message-text').allTextContents()).toEqual(Array.from({length:61},(_,i)=>'Note '+String(i+1).padStart(3,'0')));
});
test('gateway pairing is an explicit invoice action with a visible owner and confirmation code',async({page})=>{
 const {invoiceId}=await page.request.post('/fixture/owner').then(r=>r.json());let configured:unknown;let state:Record<string,unknown>={enabled:false,status:'disabled'};
 await page.route(`**/api/invoices/${invoiceId}/email-gateway`,async route=>{if(route.request().method()==='POST'){configured=route.request().postDataJSON();state={enabled:true,status:'pending',ownerPubkey:'a'.repeat(64),gatewayPubkey:'b'.repeat(64),groupId:'fictional-group',pairCode:'fictional-pairing-code',pairExpiresAt:new Date(Date.now()+600000).toISOString()};}await route.fulfill({json:{settings:state}});});
 await page.goto('/invoices/'+invoiceId+'/thread');await expect(page.getByRole('heading',{name:'Optional Marmot email gateway',exact:true})).toBeVisible();await page.getByLabel('Enable this invoice’s email gateway',{exact:true}).check();await page.getByLabel('Gateway owner public key',{exact:true}).fill('a'.repeat(64));await page.getByRole('button',{name:'Save gateway settings',exact:true}).click();
 await expect(page.getByLabel('Gateway pairing command',{exact:true})).toHaveValue('/pair fictional-pairing-code');expect(configured).toEqual({enabled:true,ownerPubkey:'a'.repeat(64)});await expect(page.getByText(/gateway can read bridged email/i)).toBeVisible();
});
test('uncertain invoice email can be reviewed without sending another copy',async({page})=>{
 const {invoiceId}=await page.request.post('/fixture/owner').then(r=>r.json());await page.request.post('/fixture/uncertain',{data:{ok:true}});await page.goto('/invoices/'+invoiceId+'/email');
 await page.getByLabel('Gmail sender address',{exact:true}).fill('merchant@example.test');await page.getByLabel('Google App Password',{exact:true}).fill('abcdefghijklmnop');await page.getByRole('button',{name:'Save and connect Gmail',exact:true}).click();
 await page.getByRole('button',{name:'Preview email',exact:true}).click();await page.getByRole('button',{name:'Send invoice from merchant@example.test',exact:true}).click();
 await expect(page.getByLabel('Email review result',{exact:true})).toBeVisible();
 await page.getByLabel('Email review result',{exact:true}).selectOption('confirmed_sent');
 await page.getByLabel('Email review note',{exact:true}).fill('Found the exact message in the sent mailbox.');
 const before=(await page.request.get('/fixture/submissions').then(r=>r.json())).submissions;
 await page.getByRole('button',{name:'Record email review',exact:true}).click();await expect(page.getByText('Review recorded. No email was sent.',{exact:true})).toBeVisible();
 expect((await page.request.get('/fixture/submissions').then(r=>r.json())).submissions).toBe(before);await page.reload();await expect(page.getByText(/^Confirmed sent after mailbox review/)).toBeVisible();await page.request.post('/fixture/uncertain',{data:{ok:false}});
});
test('private client book saves edits across reloads on mobile',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.request.post('/fixture/owner');await page.goto('/clients');
 await expect(page.getByRole('heading',{name:'Your clients.',exact:true})).toBeVisible();
 await page.getByLabel('Client name',{exact:true}).fill('Fictional Studio');
 await page.getByLabel('Client email',{exact:true}).fill('studio@example.test');
 await page.getByLabel('Preferred currency',{exact:true}).selectOption('KRW');
 await page.getByLabel('Client billing address',{exact:true}).fill('Fictional building\nSeoul');
 await page.getByRole('button',{name:'Save client',exact:true}).click();
 await expect(page.getByRole('status')).toContainText('Client saved');await page.reload();
 await page.getByRole('button',{name:'Edit Fictional Studio',exact:true}).click();
 await expect(page.getByLabel('Client email',{exact:true})).toHaveValue('studio@example.test');
 await expect(page.getByLabel('Preferred currency',{exact:true})).toHaveValue('KRW');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('invoice thread retains a multiline private note and leaves invoice unpaid',async({page})=>{
 const {invoiceId}=await page.request.post('/fixture/owner').then(r=>r.json());await page.goto('/invoices/'+invoiceId+'/thread');
 await expect(page.getByRole('heading',{name:'Invoice conversation.',exact:true})).toBeVisible();
 await page.getByLabel('Private note',{exact:true}).fill('Fictional private note\nConfirm the delivery date.');
 await page.getByRole('button',{name:'Save private note',exact:true}).click();
 await expect(page.getByText('Fictional private note\nConfirm the delivery date.',{exact:true})).toBeVisible();
 await page.reload();await expect(page.getByText('Fictional private note\nConfirm the delivery date.',{exact:true})).toBeVisible();
 await page.getByRole('link',{name:'Open invoice',exact:true}).click();await expect(page.getByText('Awaiting payment',{exact:true}).first()).toBeVisible();
});

for(const action of ['save','refresh'] as const)test(`a delayed gateway ${action} cannot display another invoice's pairing details`,async({page})=>{
 const {invoiceId:a}=await page.request.post('/fixture/owner').then(r=>r.json()),session=await page.request.get('/api/session').then(r=>r.json());const b=await page.request.post('/api/invoices',{headers:{'X-CSRF-Token':session.csrfToken,Origin:'http://localhost:4354','Idempotency-Key':'fictional-second-invoice'},data:{customerName:'Another fictional client',title:'Fictional second service',currency:'CAD',items:[{description:'Editing',quantity:1,unitAmount:1000}]}}).then(r=>r.json()).then(v=>v.id);expect(b).toBeTruthy();
 let release!:()=>void,entered!:()=>void,completed!:()=>void;const held=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>entered=r),done=new Promise<void>(r=>completed=r);
 await page.route(/\/api\/invoices\/[^/]+\/email-gateway(?:\/sync)?$/,async route=>{const request=route.request();if(request.method()==='POST'&&request.url().includes(a)){entered();await held;await route.fulfill({json:{settings:{enabled:true,status:'pending',gatewayPubkey:'b'.repeat(64),pairCode:'stale-first-invoice-code'}}});completed();return;}await route.fulfill({json:{settings:{enabled:request.url().includes(a),status:request.url().includes(a)?'paired':'disabled',ownerPubkey:request.url().includes(a)?'a'.repeat(64):undefined}}});});
 await page.goto('/invoices/'+a+'/thread');await expect(page.getByRole('button',{name:'Save gateway settings',exact:true})).toBeEnabled();if(action==='save'){await page.getByLabel('Enable this invoice’s email gateway',{exact:true}).uncheck();await page.getByRole('button',{name:'Save gateway settings',exact:true}).click();}else await page.getByRole('button',{name:'Refresh gateway status',exact:true}).click();await ready;
 await page.evaluate(id=>{history.pushState({},'',`/invoices/${id}/thread`);dispatchEvent(new PopStateEvent('popstate'));},b);await expect(page.getByRole('button',{name:'Save gateway settings',exact:true})).toBeEnabled();const response=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().includes(a)&&r.url().includes('email-gateway'));release();await done;await (await response).finished();await page.evaluate(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);});await expect(page.getByText(/another fictional client/i)).toBeVisible();await expect(page.getByLabel('Gateway pairing command',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Enable this invoice’s email gateway',{exact:true})).not.toBeChecked();
});
