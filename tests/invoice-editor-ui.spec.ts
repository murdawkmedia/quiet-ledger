import{test,expect,type Page}from'@playwright/test';
test('saved client fills invoice details without issuing or sending it',async({page})=>{
 await page.route('**/api/clients',route=>route.fulfill({json:{clients:[{id:'11111111-1111-4111-8111-111111111111',name:'Fictional saved client',email:'saved@example.test',billingAddress:'Fictional Studio\nSeoul',currency:'KRW',createdAt:'2026-11-06T00:00:00Z',updatedAt:'2026-11-06T00:00:00Z'}]}}));
 await page.route('**/api/invoice-templates',route=>route.fulfill({json:{templates:[]}}));
 let issued=0;await page.route('**/api/invoices',route=>{issued++;return route.fulfill({status:201,json:{id:'fictional'}});});
 await page.goto('/tests/fixtures/invoice-editor-ui.html');
 await page.getByRole('combobox',{name:'Saved client',exact:true}).selectOption('11111111-1111-4111-8111-111111111111');
 await expect(page.getByLabel('Customer name',{exact:true})).toHaveValue('Fictional saved client');
 await expect(page.getByLabel('Customer email',{exact:true})).toHaveValue('saved@example.test');
 await expect(page.getByLabel('Invoice currency',{exact:true})).toHaveValue('KRW');
 expect(issued).toBe(0);
});
const draft={customerName:'Fictional Marmot Lab',customerEmail:'',title:'Private workshop recording',currency:'KRW',items:[{description:'Fictional recording service',quantity:1,unitAmount:200000}],taxBps:0,discountBps:1000,premiumBps:500,issueDate:'2026-11-05',dueDate:'2026-11-20',acceptedMethods:['bitcoin'],note:'Pay within fifteen days.'};
async function fixture(page:Page){const calls:any[]=[];let templates=[{id:'fixture-template',label:'Marmot workshop client',draft}];await page.route('**/api/invoice-templates**',async route=>{const req=route.request();if(req.method()==='GET')return route.fulfill({json:{templates}});if(req.method()==='DELETE'){templates=[];return route.fulfill({json:{deleted:true}});}calls.push({url:req.url(),body:req.postDataJSON(),csrf:req.headers()['x-csrf-token']});await route.fulfill({json:{template:{id:'saved-fixture',...req.postDataJSON()}}});});await page.route('**/api/invoices',async route=>{calls.push({url:route.request().url(),body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});await route.fulfill({status:201,json:{id:'created-fixture'}});});await page.goto('/tests/fixtures/invoice-editor-ui.html');return calls;}
test('reusable client template restores dates, KRW amounts and explicit merchant adjustments',async({page})=>{const calls=await fixture(page);await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');await expect(page.getByLabel('Customer name',{exact:true})).toHaveValue(draft.customerName);await expect(page.getByLabel('Item 1 unit price',{exact:true})).toHaveValue('200000');await expect(page.getByLabel('Issue date',{exact:true})).toHaveValue('2026-11-05');await expect(page.getByLabel('Due date',{exact:true})).toHaveValue('2026-11-20');await expect(page.getByTestId('invoice-total')).toHaveText(/190,000/);await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');const saved=calls.find(call=>call.url.endsWith('/api/invoices'));const {customerEmail:_blank,...expected}=draft;expect(saved.body).toMatchObject(expected);expect(saved.key).toBeTruthy();});
test('template save and delete are explicit; choosing payment methods does not claim a connection',async({page})=>{const calls=await fixture(page);await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');await page.getByLabel('Template name',{exact:true}).fill('Fictional retained client');await page.getByRole('button',{name:'Save as new template',exact:true}).click();await expect(page.getByRole('status')).toContainText('Template saved');expect(calls[0].csrf).toBe('fictional-invoice-csrf');expect(calls[0].body.draft.currency).toBe('KRW');await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');await page.getByRole('button',{name:'Delete selected template',exact:true}).click();await expect(page.getByRole('combobox',{name:'Saved invoice template',exact:true})).toHaveValue('');await expect(page.getByText('Selecting a method does not connect a provider.',{exact:false})).toBeVisible();});

test('whole-won validation rejects fractions and demo create uses its narrow endpoint',async({page})=>{const calls=await fixture(page);await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');await page.getByLabel('Item 1 unit price',{exact:true}).fill('200000.50');await page.getByRole('button',{name:'Create invoice',exact:true}).click();await expect(page.getByRole('alert')).toContainText('whole-won');expect(calls).toHaveLength(0);let created:any;await page.route('**/api/hackathon-demo/invoices',async route=>{created={body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']};await route.fulfill({status:201,json:{invoice:{id:'fictional-demo-invoice'}}});});await page.goto('/tests/fixtures/invoice-editor-ui.html?demo');await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();await expect(page.locator('body')).toHaveAttribute('data-created','true');expect(created.body.customerName).toContain('fictional');expect(created.body.taxBps).toBe(0);expect(created.key).toBeTruthy();});

test('customer checkout shows adjustments and hides unaccepted payment choices',async({page})=>{await page.route('**/api/checkout/fictional-checkout',route=>route.fulfill({json:{invoice:{...draft,number:'QL-FIXTURE',subtotal:200000,discountAmount:20000,premiumAmount:10000,tax:0,total:190000,status:'open',amountSats:190000,createdAt:'2026-11-05T00:00:00Z'},payment:{mode:'simulation',amountSats:190000,request:'fictional'},adapters:[]}}));await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');await expect(page.getByText('Discount (10%)',{exact:true})).toBeVisible();await expect(page.getByText('Premium (5%)',{exact:true})).toBeVisible();await expect(page.getByText('Accepted methods: Bitcoin',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Cashu Private ecash',exact:true})).toHaveCount(0);const methods=page.getByRole('combobox',{name:'More payment methods',exact:true});await expect(methods.locator('option')).toHaveCount(2);await expect(methods).toHaveValue('bitcoin');await expect(page.getByRole('button',{name:'Pay with simulated Bitcoin',exact:true})).toBeVisible();});

test('mobile invoice form keeps date validation and template controls usable without horizontal scrolling', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  const calls = await fixture(page);
  await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');
  const due = page.getByLabel('Due date',{exact:true});
  await due.fill('2026-11-01');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  expect(calls).toHaveLength(0);
  expect(await due.evaluate(node => (node as HTMLInputElement).validity.rangeUnderflow)).toBe(true);
  await due.fill('2026-11-20');
  await page.getByRole('button',{name:'Update selected template',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('Template saved');
  expect(calls[0].body.id).toBe('fixture-template');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});


test('KRW checkout offers only connections supporting the invoice currency',async({page})=>{
  await page.route('**/api/checkout/fictional-checkout',route=>route.fulfill({json:{invoice:{...draft,acceptedMethods:['bitcoin','card'],number:'QL-FIXTURE',subtotal:200000,discountAmount:20000,premiumAmount:10000,tax:0,total:190000,status:'open',createdAt:'2026-11-05T00:00:00Z'},payment:{mode:'simulation',amountSats:190000,request:'fictional'},adapters:[{id:'dollar-card',mode:'live',configured:true,methods:['card'],supportedCurrencies:['CAD','USD']},{id:'btc',mode:'live',configured:true,methods:['bitcoin']}]}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');
  const methods=page.getByRole('combobox',{name:'Payment method',exact:true});
  await expect(methods.locator('option')).toHaveCount(1);
  await expect(methods).toHaveValue('bitcoin');
  await expect(methods.locator('option')).toHaveText(['Bitcoin']);
});

test('a slow initial template list preserves a template saved while it loads', async ({page}) => {
  let finishLoad!: () => void;
  const delayed = new Promise<void>(resolve => { finishLoad = resolve; });
  await page.route('**/api/invoice-templates', async route => {
    if (route.request().method() === 'GET') {
      await delayed;
      return route.fulfill({json:{templates:[]}});
    }
    await route.fulfill({json:{template:{id:'new-fictional-template',...route.request().postDataJSON()}}});
  });
  await page.goto('/tests/fixtures/invoice-editor-ui.html?demo');
  await page.getByLabel('Template name',{exact:true}).fill('Fictional slow-load client');
  await page.getByRole('button',{name:'Save as new template',exact:true}).click();
  const picker = page.getByRole('combobox',{name:'Saved invoice template',exact:true});
  await expect(picker).toHaveValue('new-fictional-template');
  const loaded = page.waitForResponse(response => response.url().endsWith('/api/invoice-templates') && response.request().method() === 'GET');
  finishLoad();
  await loaded;
  await expect(picker.locator('option[value="new-fictional-template"]')).toHaveText('Fictional slow-load client');
});

test('leaving the editor while creation is pending does not run its navigation callback', async ({page}) => {
  await fixture(page);
  await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');
  let finishCreate!: () => void;
  const delayed = new Promise<void>(resolve => { finishCreate = resolve; });
  let started!: () => void;
  const requested = new Promise<void>(resolve => { started = resolve; });
  await page.route('**/api/invoices', async route => {
    started();
    await delayed;
    await route.fulfill({status:201,json:{id:'created-fictional-invoice'}});
  });
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await requested;
  await page.getByRole('link',{name:'Cancel',exact:true}).click();
  await expect(page.getByText('Fixture destination',{exact:true})).toBeVisible();
  const completed = page.waitForResponse('**/api/invoices');
  finishCreate();
  await completed;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('body')).not.toHaveAttribute('data-created','true');
});

function checkoutFixture(overrides:Record<string,unknown> = {}) {
  return {invoice:{...draft,number:'QL-FIXTURE',subtotal:200000,discountAmount:20000,premiumAmount:10000,tax:0,total:190000,status:'open',createdAt:'2026-11-05T00:00:00Z',...overrides},payment:{mode:'simulation',amountSats:190000,request:'fictional'},adapters:[]};
}

test('a bank-only invoice keeps the legacy bank button in owner-review mode', async ({page}) => {
  const value = checkoutFixture({acceptedMethods:['bank']});
  await page.route('**/api/checkout/fictional-checkout', route => route.fulfill({json:value}));
  await page.route('**/api/checkout/fictional-checkout/pay', route => route.fulfill({json:{invoice:value.invoice,alreadyPaid:false,report:{id:'fictional-report',method:'bank_transfer',status:'reported',createdAt:'2026-11-05T00:00:00Z'}}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');
  await page.getByRole('button',{name:/^Bank /}).click();
  await expect(page.getByRole('button',{name:'Bank Owner review',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Report bank transfer payment',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Awaiting owner review.',exact:true})).toBeVisible();
  await expect(page.getByText('No paid receipt has been issued.',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'View payment receipt',exact:false})).toHaveCount(0);
});

for (const acceptedMethods of [undefined,['bank_transfer']]) {
  test(`legacy bank simulation remains available for ${acceptedMethods ? 'explicit legacy' : 'unrestricted'} terms`, async ({page}) => {
    await page.route('**/api/checkout/fictional-checkout', route => route.fulfill({json:checkoutFixture({acceptedMethods})}));
    await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');
    await page.getByRole('button',{name:'Bank Transfer simulation',exact:true}).click();
    await expect(page.getByRole('button',{name:'Pay with simulated bank transfer',exact:true})).toBeVisible();
  });
}

test('multi-line totals survive removing a line and explicit currency changes', async ({page}) => {
  const calls = await fixture(page);
  await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');
  await page.getByLabel('Invoice currency',{exact:true}).selectOption('CAD');
  await page.getByLabel('Item 1 quantity',{exact:true}).fill('3');
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('19.99');
  await page.getByRole('button',{name:'Add line item',exact:true}).click();
  await page.getByLabel('Item 2 description',{exact:true}).fill('Fictional second service');
  await page.getByLabel('Item 2 quantity',{exact:true}).fill('2');
  await page.getByLabel('Item 2 unit price',{exact:true}).fill('0.01');
  await page.getByLabel('Tax rate (%)',{exact:true}).fill('5');
  await page.getByLabel('Discount (%)',{exact:true}).fill('12.34');
  await page.getByLabel('Premium (%)',{exact:true}).fill('2.5');
  await expect(page.getByTestId('invoice-total')).toHaveText('$56.79');
  await page.getByRole('button',{name:'Remove item 1',exact:true}).click();
  await expect(page.getByLabel('Item 1 description',{exact:true})).toHaveValue('Fictional second service');
  await expect(page.getByLabel('Item 1 quantity',{exact:true})).toHaveValue('2');
  await expect(page.getByTestId('invoice-total')).toHaveText('$0.02');
  for (const currency of ['USD','EUR','GBP']) {
    await page.getByLabel('Invoice currency',{exact:true}).selectOption(currency);
    await expect(page.getByLabel('Item 1 unit price',{exact:true})).toHaveValue('0.01');
  }
  await page.getByLabel('Invoice currency',{exact:true}).selectOption('KRW');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('whole-won');
  expect(calls).toHaveLength(0);
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('200');
  await expect(page.getByTestId('invoice-total')).toHaveText(/379/);
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.locator('body')).toHaveAttribute('data-created','true');
  expect(calls[0].body).toMatchObject({currency:'KRW',items:[{description:'Fictional second service',quantity:2,unitAmount:200}],taxBps:500,discountBps:1234,premiumBps:250});
});

test('empty payment selections fail locally and invoice retries reuse the same request key', async ({page}) => {
  await fixture(page);
  await page.getByRole('combobox',{name:'Saved invoice template',exact:true}).selectOption('fixture-template');
  await page.getByLabel('Accept Bitcoin',{exact:true}).uncheck();
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Choose at least one');
  await page.getByLabel('Accept Bitcoin',{exact:true}).check();
  const attempts:{body:unknown;key:string|undefined}[] = [];
  await page.route('**/api/invoices', async route => {
    attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
    if (attempts.length === 1) return route.abort('connectionreset');
    await route.fulfill({status:201,json:{id:'saved-before-lost-response'}});
  });
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByLabel('Invoice title',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Retry saved invoice',exact:true}).click();
  await expect(page.locator('body')).toHaveAttribute('data-created','true');
  expect(attempts).toHaveLength(2);
  expect(attempts[0].key).toBeTruthy();
  expect(attempts[1]).toEqual(attempts[0]);
});

test('checkout filters each manual method by the invoice currency before offering it', async ({page}) => {
  const value = {...checkoutFixture({currency:'USD',acceptedMethods:['interac','wire']}),adapters:[{id:'fictional-manual',mode:'live',configured:true,methods:['interac','wire'],supportedCurrenciesByMethod:{interac:['CAD']}}]};
  await page.route('**/api/checkout/fictional-checkout', route => route.fulfill({json:value}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');
  const methods = page.getByRole('combobox',{name:'Payment method',exact:true});
  await expect(methods.locator('option')).toHaveText(['Wire transfer']);
  await expect(methods).toHaveValue('wire');
});

const receivingFixture = {
  id:'fictional-receiving',token:'fictional-receiving',invoiceId:'fictional-invoice',invoiceNumber:'QL-FIXTURE',method:'bitcoin',adapterId:'fictional-adapter',mode:'live',status:'awaiting_payment',amount:10000,currency:'CAD',expectedAtomic:'100000',createdAt:'2026-11-05T20:00:00Z',expiresAt:'2026-11-05T20:01:00Z',
  intent:{providerId:'fictional-provider',url:'https://pay.fixture.example/payment',request:'fictional-payment-address',network:'bitcoin',asset:'BTC',instructions:[{label:'Fictional instructions',value:'Fictional payment instruction contents'}]}
};

test('an open receiving page retires payment details when the request expires', async ({page}) => {
  await page.clock.install({time:new Date('2026-11-05T20:00:00Z')});
  await page.route('**/api/receive/fictional-receiving', route => route.fulfill({json:{request:receivingFixture}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
  await expect(page.getByRole('link',{name:'Open secure provider checkout',exact:false})).toBeVisible();
  await expect(page.getByText('fictional-payment-address',{exact:true})).toBeVisible();
  await page.clock.fastForward(61000);
  await expect(page.getByText('Payment request expired',{exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Open secure provider checkout',exact:false})).toHaveCount(0);
  await expect(page.getByText('fictional-payment-address',{exact:true})).toHaveCount(0);
  await expect(page.getByText('Fictional payment instruction contents',{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Check payment',exact:true})).toBeEnabled();
});

test('an already expired receiving request hides its payment instructions', async ({page}) => {
  await page.clock.install({time:new Date('2026-11-05T20:02:00Z')});
  await page.route('**/api/receive/fictional-receiving', route => route.fulfill({json:{request:receivingFixture}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
  await expect(page.getByText('Payment request expired',{exact:true})).toBeVisible();
  await expect(page.getByText('Fictional payment instruction contents',{exact:true})).toHaveCount(0);
});

test('configured live checkout never advertises a simulation that the server rejects',async({page})=>{
 await page.route('**/api/checkout/fictional-checkout',route=>route.fulfill({json:{invoice:{...draft,acceptedMethods:['bitcoin'],number:'QL-LIVE-SOAK',subtotal:200000,tax:0,total:200000,status:'open',createdAt:'2026-11-05T00:00:00Z'},payment:{mode:'simulation',amountSats:200000,request:'fictional'},adapters:[{id:'live-bitcoin',mode:'live',configured:true,methods:['bitcoin']}]}}));
 await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');
 await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toBeEnabled();
 await expect(page.getByRole('button',{name:'Try simulation',exact:true})).toHaveCount(0);
});

test('live connections that cannot serve this currency cannot fall back to simulated payment',async({page})=>{
 await page.route('**/api/checkout/fictional-checkout',route=>route.fulfill({json:{invoice:{...draft,acceptedMethods:['card'],number:'QL-LIVE-CURRENCY-SOAK',subtotal:200000,tax:0,total:200000,status:'open',createdAt:'2026-11-05T00:00:00Z'},payment:{mode:'simulation',amountSats:200000,request:'fictional'},adapters:[{id:'live-card',mode:'live',configured:true,methods:['card'],supportedCurrencies:['CAD','USD']}]}}));
 await page.goto('/tests/fixtures/invoice-editor-ui.html?checkout');
 await expect(page.getByText('No configured live payment method matches this invoice. Ask the merchant for another connection or a supported invoice currency.',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toBeDisabled();
});

// Fictional validated-adapter result: never use this payload with a wallet.
const cashuRequest = {...receivingFixture,method:'lightning',intent:{providerId:'fictional-lightning-provider',request:'lightning:lnbc100u1fixtureonly',network:'mainnet',asset:'BTC',cashuWalletHandoff:true}};

test('Cashu wallet guidance copies and scans the original Lightning request without allocating or paying',async({page})=>{
  const mutations:string[]=[];
  await page.clock.install({time:new Date('2026-11-05T20:00:00Z')});
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{document.body.dataset.copiedRequest=value;}}});});
  page.on('request',request=>{if(request.method()!=='GET')mutations.push(request.url());});
  await page.route('**/api/receive/fictional-receiving',route=>route.fulfill({json:{request:cashuRequest}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
  const button=page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true});
  await expect(button).toHaveAttribute('aria-expanded','false');
  await button.focus();await page.keyboard.press('Enter');
  await expect(button).toHaveAttribute('aria-expanded','true');
  const qr=page.getByRole('img',{name:'Scan this Lightning invoice in your Cashu wallet',exact:true});
  await expect(qr).toBeVisible();
  const QRCode=await import('qrcode');
  const expected=QRCode.create(cashuRequest.intent.request,{errorCorrectionLevel:'M'}).modules;
  // Node PNG compression differs from Chromium canvas. Compare the actual
  // rendered module pixels, including the quiet zone, rather than PNG bytes.
  const pixels=await qr.evaluate((element,size)=>{
    const image=element as HTMLImageElement,canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;
    const context=canvas.getContext('2d')!;context.drawImage(image,0,0);const pixels=context.getImageData(0,0,canvas.width,canvas.height).data;
    const scale=canvas.width/(size+8),modules:number[]=[];
    for(let row=-4;row<size+4;row++)for(let col=-4;col<size+4;col++){
      const x=Math.floor((col+4.5)*scale),y=Math.floor((row+4.5)*scale);modules.push(pixels[(y*canvas.width+x)*4]<128?1:0);
    }return modules;
  },expected.size);
  const modules:number[]=[];for(let row=-4;row<expected.size+4;row++)for(let col=-4;col<expected.size+4;col++)modules.push(row<0||col<0||row>=expected.size||col>=expected.size?0:expected.data[row*expected.size+col]);
  expect(pixels).toEqual(modules);
  await page.getByRole('button',{name:'Copy Lightning invoice for Cashu wallet',exact:true}).click();
  await expect(page.locator('body')).toHaveAttribute('data-copied-request',cashuRequest.intent.request);
  await expect(page.getByText('Your receipt will say Lightning.',{exact:true})).toBeVisible();
  expect(mutations).toEqual([]);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.clock.fastForward(61000);
  await expect(button).toHaveCount(0);await expect(qr).toHaveCount(0);
});

for(const [label,change] of Object.entries({
  'test request':{mode:'test'},'on-chain request':{method:'bitcoin'},'pending creation':{status:'creation_pending'},
  'owner review':{reviewReason:'Independent review needed'},'uncertain creation':{creationUncertain:true},
  'manual receiver':{intent:{...cashuRequest.intent,cashuWalletHandoff:undefined}},
  'test network':{intent:{...cashuRequest.intent,network:'testnet'}},
  'invalid request':{intent:{...cashuRequest.intent,request:'lightning:lnurl1fictional'}},
  'zero amount':{expectedAtomic:'0'},
}))test(`Cashu wallet guidance is absent for ${label}`,async({page})=>{
  await page.clock.install({time:new Date('2026-11-05T20:00:00Z')});
  await page.route('**/api/receive/fictional-receiving',route=>route.fulfill({json:{request:{...cashuRequest,...change}}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
  await expect(page.getByRole('heading',{level:1})).toBeVisible();
  await expect(page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true})).toHaveCount(0);
});

test('Cashu handoff retires at the actual BOLT11 expiry before the outer request window',async({page})=>{
  await page.clock.install({time:new Date('2026-11-05T20:00:00Z')});
  await page.route('**/api/receive/fictional-receiving',route=>route.fulfill({json:{request:{...cashuRequest,intent:{...cashuRequest.intent,expiresAt:'2026-11-05T20:00:10Z'}}}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
  const button=page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true});await button.click();
  await expect(page.getByRole('img',{name:'Scan this Lightning invoice in your Cashu wallet',exact:true})).toBeVisible();
  await page.clock.fastForward(11000);
  await expect(page.getByText('Payment request expired',{exact:true})).toBeVisible();await expect(button).toHaveCount(0);
  await expect(page.locator('.receiving-address')).toHaveCount(0);
});

test('Cashu guide keeps exact copy available when its Lightning invoice is too large for QR',async({page})=>{
  const payload='lightning:lnbc'+'a'.repeat(6000);
  await page.clock.install({time:new Date('2026-11-05T20:00:00Z')});
  await page.addInitScript(()=>{Object.defineProperty(navigator,'clipboard',{value:{writeText:async(value:string)=>{document.body.dataset.copiedRequest=value;}}});});
  await page.route('**/api/receive/fictional-receiving',route=>route.fulfill({json:{request:{...cashuRequest,intent:{...cashuRequest.intent,request:payload}}}}));
  await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
  await page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true}).click();
  await expect(page.getByRole('status')).toHaveText('QR unavailable. Copy the Lightning invoice instead.');
  await page.getByRole('button',{name:'Copy Lightning invoice for Cashu wallet',exact:true}).click();
  expect(await page.locator('body').getAttribute('data-copied-request')).toBe(payload);
});

test('a delayed QR module cannot revive an expired Cashu handoff',async({page})=>{
  let release!:()=>void,started!:()=>void;
  const held=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{started=resolve;});
  await page.clock.install({time:new Date('2026-11-05T20:00:00Z')});
  await page.route('**/api/receive/fictional-receiving',route=>route.fulfill({json:{request:{...cashuRequest,intent:{...cashuRequest.intent,expiresAt:'2026-11-05T20:00:10Z'}}}}));
  await page.route('**/*qrcode*',async route=>{started();await held;await route.continue();});
  try{
    await page.goto('/tests/fixtures/invoice-editor-ui.html?receive');
    await page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true}).click();await requested;
    await page.clock.fastForward(11000);await expect(page.getByText('Payment request expired',{exact:true})).toBeVisible();
    const loaded=page.waitForResponse(response=>response.url().includes('qrcode'));release();await loaded;
    await expect(page.getByRole('button',{name:'Pay from a Cashu wallet',exact:true})).toHaveCount(0);
    await expect(page.getByRole('img',{name:'Scan this Lightning invoice in your Cashu wallet',exact:true})).toHaveCount(0);
  }finally{release();}
});
