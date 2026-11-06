import {expect,test,type Page} from '@playwright/test';

// Synthetic in-memory API: browser tests never contact a provider or live account.
const id='00000000-0000-4000-8000-000000000047';
const ledgerPath=`/invoices/${id}/ledger`;
const issued={id,token:'fictional-checkout',number:'QL-FIXTURE-47',title:'Fictional design work',customerName:'Fictional Customer',currency:'CAD',items:[{description:'Design service',quantity:1,unitAmount:10000}],taxBps:0,subtotal:10000,tax:0,total:10000,totalCad:10000,amountSats:100000,status:'open',acceptedMethods:['lightning','wire'],createdAt:'2026-11-06T00:00:00Z'};
const adapter={id:'fictional-receiver',label:'Fictional receiver',mode:'live',configured:true,methods:['lightning','wire','interac'],supportedCurrenciesByMethod:{interac:['CAD']}};
type Entry={id:string;kind:'payment'|'credit'|'void';amount:number;currency:string;createdAt:string;reason?:string;method?:string;verification?:string;receiptToken?:string;receiptNumber?:string};
async function fixture(page:Page,changes:Record<string,unknown>={}){
  const invoice={...issued,...changes};
  const state={invoice,paid:0,credited:0,voided:false,entries:[] as Entry[],requests:[] as Record<string,any>[],mutations:[] as {path:string;body:any;key?:string}[],demo:false};
  function view(){const due=state.voided?0:Math.max(0,invoice.total-state.paid-state.credited);return {invoice:{...invoice,status:state.paid>=invoice.total?'paid':'open',balance:balance()},balance:balance(),entries:state.entries};function balance(){return {total:invoice.total,paid:state.paid,credited:state.credited,due,overpaid:Math.max(0,state.paid+state.credited-invoice.total),currency:invoice.currency,state:state.voided?'void':due===0?state.credited?'credited':'paid':state.paid?'partially_paid':'unpaid',mode:'live'};}}
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,body=request.method()==='POST'?request.postDataJSON():undefined;
    if(request.method()==='POST')state.mutations.push({path,body,key:request.headers()['idempotency-key']});
    if(path==='/api/session')return route.fulfill({json:{authenticated:true,role:state.demo?'demo':'owner',csrfToken:'fictional-csrf',privateScenarioAvailable:false}});
    if(path==='/api/dashboard')return route.fulfill({json:{invoices:[view().invoice],payouts:[],activity:[],totals:{invoicedCad:10000,receivedCad:0,availableCad:0,spentCad:0}}});
    if(path===`/api/invoices/${id}/ledger`)return route.fulfill({json:view()});
    if(path==='/api/receiving'&&request.method()==='GET')return route.fulfill({json:{adapters:[adapter],requests:state.requests}});
    if(path==='/api/receiving'&&request.method()==='POST'){
      const row={id:`fictional-request-${state.requests.length+1}`,token:`fictional-receive-${state.requests.length+1}`,invoiceId:id,invoiceNumber:invoice.number,method:body.method,adapterId:body.adapterId,amount:body.amount,currency:invoice.currency,expectedAtomic:'25000',mode:'live',status:'awaiting_payment',createdAt:'2026-11-06T00:00:00Z',expiresAt:'2099-11-06T01:00:00Z',intent:{providerId:'fictional-provider',request:'fictional-only-do-not-pay',network:'mainnet',asset:'BTC'}};
      state.requests.unshift(row);return route.fulfill({status:201,json:{request:row}});
    }
    if(path===`/api/invoices/${id}/credits`){state.credited+=body.amount;state.entries.push({id:'fictional-credit',kind:'credit',amount:body.amount,currency:invoice.currency,createdAt:'2026-11-06T01:00:00Z',reason:body.reason});return route.fulfill({json:view()});}
    if(path===`/api/invoices/${id}/void`){state.voided=true;state.entries.push({id:'fictional-void',kind:'void',amount:10000,currency:invoice.currency,createdAt:'2026-11-06T01:00:00Z',reason:body.reason});return route.fulfill({json:view()});}
    if(path==='/api/checkout/fictional-checkout')return route.fulfill({json:{invoice:view().invoice,payment:{mode:'simulation',amountSats:100000,request:'fictional'},adapters:[adapter]}});
    if(path==='/api/checkout/fictional-checkout/receiving')return route.fulfill({json:{request:{token:'fictional-public-receive'}}});
    const receive=state.requests.find(row=>path.startsWith(`/api/receive/${row.token}`));
    if(receive){if(path.endsWith('/check')&&!receive.receipt){state.paid+=receive.amount;receive.status='paid';receive.receipt={number:`PAY-${state.entries.length+1}`,amount:receive.amount,currency:invoice.currency,mode:'live',method:receive.method,verifiedAt:'2026-11-06T01:00:00Z'};state.entries.push({id:receive.id,kind:'payment',amount:receive.amount,currency:invoice.currency,createdAt:receive.receipt.verifiedAt,method:receive.method,verification:'provider',receiptToken:`fictional-receipt-${state.entries.length+1}`,receiptNumber:receive.receipt.number});}return route.fulfill({json:{request:receive}});}
    if(path.startsWith('/api/receipts/')){const entry=state.entries.find(row=>path.endsWith(row.receiptToken??'never'));return route.fulfill({json:{invoice:view().invoice,receipt:{number:entry?.receiptNumber,amount:entry?.amount,currency:invoice.currency,mode:'live',method:entry?.method,issuedAt:entry?.createdAt,invoiceNumber:invoice.number,title:invoice.title,customerName:invoice.customerName}}});}
    return route.fulfill({status:404,json:{error:`Unmocked synthetic endpoint ${path}`}});
  });
  return {state,view};
}
async function open(page:Page,path=ledgerPath){await page.goto(`/tests/fixtures/invoice-ledger-ui.html?path=${encodeURIComponent(path)}`);}

test('owner follows a deposit and final payment into two individual receipts',async({page})=>{
  const {state}=await fixture(page);await open(page,'/invoices');
  await page.getByRole('link',{name:'Ledger',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Invoice ledger',exact:true})).toBeVisible();
  await page.getByLabel('Payment request amount (CAD)',{exact:true}).fill('25.00');
  await page.getByRole('button',{name:'Create payment request',exact:true}).click();
  expect(state.mutations.at(-1)?.body).toMatchObject({invoiceId:id,amount:2500,method:'lightning',adapterId:adapter.id});
  await page.getByRole('link',{name:'Open payment request',exact:true}).first().click();
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await expect(page.locator('.receipt-amount')).toContainText('$25.00');
  await page.getByRole('link',{name:'quiet ledger',exact:true}).click();
  await page.getByRole('link',{name:'Ledger',exact:true}).click();
  await expect(page.getByTestId('ledger-due')).toHaveText('$75.00');
  await expect(page.getByTestId('ledger-paid')).toHaveText('$25.00');
  await page.getByRole('button',{name:'Create payment request',exact:true}).click();
  await expect(page.getByRole('link',{name:'Open payment request',exact:true}).first()).toHaveAttribute('href','/receive/fictional-receive-2');
  await page.getByRole('link',{name:'Open payment request',exact:true}).first().click();
  await page.getByRole('button',{name:'Check payment',exact:true}).click();
  await page.getByRole('link',{name:'quiet ledger',exact:true}).click();
  await page.getByRole('link',{name:'Ledger',exact:true}).click();
  await expect(page.getByTestId('ledger-due')).toHaveText('$0.00');
  await expect(page.getByRole('link',{name:/^Receipt PAY-/})).toHaveCount(2);
  await expect(page.getByRole('button',{name:'Create payment request',exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Receipt PAY-1',exact:true}).click();
  await expect(page.locator('.receipt-amount')).toContainText('$25.00');
  expect(state.entries.map(row=>row.amount)).toEqual([2500,7500]);
});

test('credit closes a balance without payment or a receipt',async({page})=>{
  const {state}=await fixture(page);await open(page);
  await page.getByLabel('Credit amount (CAD)',{exact:true}).fill('100.00');
  await page.getByLabel('Credit reason',{exact:true}).fill('Fictional service cancellation');
  await page.getByRole('button',{name:'Record credit note',exact:true}).click();
  await expect(page.getByTestId('ledger-credited')).toHaveText('$100.00');
  await expect(page.getByTestId('ledger-paid')).toHaveText('$0.00');
  await expect(page.getByText('Credited',{exact:true}).first()).toBeVisible();
  await expect(page.getByRole('link',{name:/^Receipt /})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Create payment request',exact:true})).toHaveCount(0);
  expect(state.entries[0]).toMatchObject({kind:'credit',reason:'Fictional service cancellation'});
});

test('void requires an explicit confirmation and leaves no paid receipt',async({page})=>{
  const {state}=await fixture(page);await open(page);
  await page.getByLabel('Void reason',{exact:true}).fill('Fictional duplicate invoice');
  await expect(page.getByRole('button',{name:'Void unpaid invoice',exact:true})).toBeDisabled();
  await page.getByRole('checkbox',{name:'I confirm this unpaid invoice should be voided.'}).check();
  await page.getByRole('button',{name:'Void unpaid invoice',exact:true}).click();
  await expect(page.getByText('Void',{exact:true}).first()).toBeVisible();
  await expect(page.getByTestId('ledger-paid')).toHaveText('$0.00');
  await expect(page.getByRole('link',{name:/^Receipt /})).toHaveCount(0);
  expect(state.mutations.at(-1)?.body).toEqual({reason:'Fictional duplicate invoice'});
});

test('partly paid invoices cannot offer unpaid void and show actual overpayment',async({page})=>{
  const {state}=await fixture(page);state.paid=12000;await open(page);
  await expect(page.getByTestId('ledger-overpaid')).toHaveText('$20.00');
  await expect(page.getByRole('button',{name:'Void unpaid invoice',exact:true})).toHaveCount(0);
});

test('public checkout shows original total and collects only a chosen part of the remaining due',async({page})=>{
  const {state}=await fixture(page);state.paid=2500;await open(page,'/pay/fictional-checkout');
  await expect(page.getByTestId('checkout-due')).toHaveText('$75.00');
  await expect(page.getByText('Original total',{exact:true})).toBeVisible();
  await page.getByLabel('Payment amount (CAD)',{exact:true}).fill('20.25');
  await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
  expect(state.mutations.at(-1)?.body).toEqual({amount:2025,method:'lightning',adapterId:adapter.id});
});

for(const kind of ['credit','void'] as const)test(`public ${kind} has no payment controls or fabricated receipt`,async({page})=>{
  const {state}=await fixture(page);if(kind==='credit')state.credited=10000;else state.voided=true;
  await open(page,'/pay/fictional-checkout');
  await expect(page.getByRole('heading',{name:kind==='credit'?'Invoice credited.':'Invoice voided.',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toHaveCount(0);
  await expect(page.getByRole('link',{name:'View payment receipt',exact:false})).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});

test('an uncertain checkout request keeps its amount and idempotency key across balance refresh',async({page})=>{
  const {state}=await fixture(page);const attempts:{body:unknown;key?:string}[]=[];
  await page.route('**/api/checkout/fictional-checkout/receiving',async route=>{
    attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
    if(attempts.length===1){state.paid=5000;return route.abort('connectionreset');}
    return route.fulfill({json:{request:{token:'fictional-public-receive'}}});
  });
  await open(page,'/pay/fictional-checkout');
  await page.getByLabel('Payment amount (CAD)',{exact:true}).fill('25.00');
  await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.getByTestId('checkout-due')).toHaveText('$50.00');
  await expect(page.getByLabel('Payment amount (CAD)',{exact:true})).toHaveValue('25.00');
  await expect(page.getByLabel('Payment amount (CAD)',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Retry saved payment request',exact:true}).click();
  expect(attempts).toHaveLength(2);expect(attempts[0].key).toBeTruthy();expect(attempts[1]).toEqual(attempts[0]);
});

test('stale public amount rejection refreshes the balance and never retries with a new amount automatically',async({page})=>{
  const {state}=await fixture(page);let calls=0;
  await page.route('**/api/checkout/fictional-checkout/receiving',async route=>{calls++;state.paid=7500;return route.fulfill({status:409,json:{error:'Amount exceeds current balance.'}});});
  await open(page,'/pay/fictional-checkout');await page.getByLabel('Payment amount (CAD)',{exact:true}).fill('50.00');
  await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
  await expect(page.getByTestId('checkout-due')).toHaveText('$25.00');
  await expect(page.getByLabel('Payment amount (CAD)',{exact:true})).toHaveValue('50.00');
  await page.getByRole('button',{name:'Continue with live payment',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('current amount due');expect(calls).toBe(1);
});

test('KRW uses whole units and unsupported or disallowed methods stay hidden',async({page})=>{
  const {state}=await fixture(page,{currency:'KRW',acceptedMethods:['wire','interac']});await open(page);
  await expect(page.getByRole('combobox',{name:'Receiving method',exact:true}).locator('option')).toHaveText(['Wire transfer']);
  await page.getByLabel('Payment request amount (KRW)',{exact:true}).fill('200.50');
  await page.getByRole('button',{name:'Create payment request',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('whole-won');expect(state.mutations).toEqual([]);
});

test('records CSV downloads the server CSV attachment as text',async({page})=>{
  await fixture(page);
  await page.route('**/api/invoice-ledger/export.csv',route=>route.fulfill({contentType:'text/csv; charset=utf-8',headers:{'content-disposition':'attachment; filename="fictional-ledger.csv"'},body:'invoice,total_minor\r\nQL-FIXTURE-47,10000\r\n'}));
  await open(page,'/records');const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'Export invoice balances (CSV)',exact:true}).click();
  const saved=await download;expect(saved.suggestedFilename()).toBe('fictional-ledger.csv');
  const stream=await saved.createReadStream();const chunks:Buffer[]=[];for await(const chunk of stream!)chunks.push(Buffer.from(chunk));
  expect(Buffer.concat(chunks).toString()).toBe('invoice,total_minor\r\nQL-FIXTURE-47,10000\r\n');
});

test('demo invoice rows keep their original flow without owner ledger controls',async({page})=>{
  const {state}=await fixture(page);state.demo=true;await open(page,'/invoices');
  await expect(page.getByRole('heading',{name:'Invoices, kept simple.',exact:true})).toBeVisible();
  await expect(page.getByRole('link',{name:'Ledger',exact:true})).toHaveCount(0);
  expect(state.mutations).toEqual([]);
});

test('ledger works by keyboard on a narrow screen without horizontal page overflow',async({page})=>{
  await fixture(page);await page.setViewportSize({width:390,height:844});await open(page);
  const amount=page.getByLabel('Payment request amount (CAD)',{exact:true});await amount.focus();await page.keyboard.press('Control+A');await page.keyboard.type('0');
  await page.getByRole('button',{name:'Create payment request',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('positive amount');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});


test('an external request prevents unpaid void even after its displayed expiry',async({page})=>{
  const {state}=await fixture(page);state.requests.push({id:'fictional-old-request',token:'fictional-old-request',invoiceId:id,invoiceNumber:issued.number,mode:'live',status:'awaiting_payment',amount:10000,currency:'CAD',method:'lightning',expiresAt:'2020-01-01T00:00:00Z'});
  await open(page);
  await page.getByLabel('Void reason',{exact:true}).fill('Fictional cancellation');
  await page.getByRole('checkbox',{name:'I confirm this unpaid invoice should be voided.'}).check();
  await expect(page.getByRole('button',{name:'Void unpaid invoice',exact:true})).toBeDisabled();
  await expect(page.getByText('Existing external payment requests cannot be cancelled by voiding this invoice.',{exact:true})).toBeVisible();
});

test('uncertain owner credit keeps a single immutable operation after it closed the balance',async({page})=>{
  const {state,view}=await fixture(page);const attempts:{body:unknown;key?:string}[]=[];
  await page.route(`**/api/invoices/${id}/credits`,async route=>{
    attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
    if(attempts.length===1){state.credited=10000;return route.abort('connectionreset');}
    return route.fulfill({json:view()});
  });
  await open(page);await page.getByLabel('Credit reason',{exact:true}).fill('Fictional lost response');
  await page.getByRole('button',{name:'Record credit note',exact:true}).click();
  await expect(page.getByTestId('ledger-due')).toHaveText('$0.00');
  await page.getByRole('button',{name:'Retry saved credit note',exact:true}).click();
  await expect(page.getByText('Credit note recorded. No payment receipt was created.',{exact:true})).toBeVisible();
  expect(attempts).toHaveLength(2);expect(attempts[0].key).toBeTruthy();expect(attempts[1]).toEqual(attempts[0]);
});

test('mixed payments and credits retain the real paid amount on public closure',async({page})=>{
  const {state}=await fixture(page);state.paid=2500;state.credited=7500;await open(page,'/pay/fictional-checkout');
  await expect(page.getByRole('heading',{name:'Invoice credited.',exact:true})).toBeVisible();
  await expect(page.getByText('Payments recorded',{exact:true})).toBeVisible();
  await expect(page.getByText('$25.00',{exact:true})).toBeVisible();
  await expect(page.getByText('$75.00',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toHaveCount(0);
});


test('a partially settled live invoice cannot fall back to simulated payment without a connection',async({page})=>{
  const {state,view}=await fixture(page);state.paid=2500;
  await page.route('**/api/checkout/fictional-checkout',route=>route.fulfill({json:{invoice:view().invoice,payment:{mode:'simulation',amountSats:100000,request:'fictional'},adapters:[]}}));
  await open(page,'/pay/fictional-checkout');
  await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toBeDisabled();
  await expect(page.getByRole('button',{name:'Pay with simulated Cashu',exact:true})).toHaveCount(0);
});

test('payment methods omit credited invoices from receiving and label partial balances truthfully',async({page})=>{
  const {state,view}=await fixture(page);state.paid=2500;
  await page.route('**/api/payment-methods',route=>route.fulfill({json:{adapters:[adapter],defaultMode:'live'}}));
  await page.route('**/api/payment-reports',route=>route.fulfill({json:{reports:[]}}));
  await open(page,'/payment-methods');
  const picker=page.getByRole('combobox',{name:'Invoice to receive',exact:true});
  await expect(picker.locator('option').last()).toContainText('$75.00');
  state.credited=7500;
  await page.getByRole('link',{name:'Invoices',exact:true}).click();
  await page.getByRole('link',{name:'Payment methods',exact:true}).click();
  await expect(picker.locator('option')).toHaveCount(1);
});

test('denied CSV export reports the error without creating a download',async({page})=>{
  await fixture(page);let downloads=0;page.on('download',()=>downloads++);
  await page.route('**/api/invoice-ledger/export.csv',route=>route.fulfill({status:403,json:{error:'Owner access required.'}}));
  await open(page,'/records');await page.getByRole('button',{name:'Export invoice balances (CSV)',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Owner access required.');expect(downloads).toBe(0);
});


test('a saved receiving link survives a failed list refresh without allowing another allocation',async({page})=>{
  await fixture(page);let reads=0;
  await page.route('**/api/receiving*',async route=>{
    if(route.request().method()!=='GET')return route.fallback();
    if(++reads===1)return route.fulfill({json:{adapters:[adapter],requests:[]}});
    return route.fulfill({status:503,json:{error:'Fictional read outage.'}});
  });
  await open(page);await page.getByRole('button',{name:'Create payment request',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('Payment requests could not be refreshed.');
  await expect(page.getByRole('link',{name:'Open payment request',exact:true})).toHaveAttribute('href','/receive/fictional-receive-1');
  await expect(page.getByRole('button',{name:'Create payment request',exact:true})).toBeDisabled();
});

test('credited invoices do not appear as awaiting payment or in the open collection filter',async({page})=>{
  const {state}=await fixture(page);state.credited=10000;await open(page,'/invoices');
  await expect(page.locator('.invoice-summary>span').nth(1)).toContainText('0Awaiting payment');
  await page.getByRole('button',{name:'Open',exact:true}).click();
  await expect(page.locator('table.data-table tbody tr')).toHaveCount(0);
});


test('retrying an initial checkout read initializes the live payment amount and connection',async({page})=>{
  const {view}=await fixture(page);let reads=0;
  await page.route('**/api/checkout/fictional-checkout',route=>++reads===1?route.fulfill({status:503,json:{error:'Fictional temporary read failure.'}}):route.fulfill({json:{invoice:view().invoice,payment:{mode:'simulation',amountSats:100000,request:'fictional'},adapters:[adapter]}}));
  await open(page,'/pay/fictional-checkout');await page.getByRole('button',{name:'Try again',exact:true}).click();
  await expect(page.getByRole('button',{name:'Continue with live payment',exact:true})).toBeEnabled();
  await expect(page.getByLabel('Payment amount (CAD)',{exact:true})).toHaveValue('100.00');
});


for(const kind of ['owner','public'] as const)test(`${kind} uncertain conflict retains the exact receiving identity`,async({page})=>{
 const {state}=await fixture(page),attempts:{body:any;key?:string}[]=[];
 const endpoint=kind==='owner'?'/api/receiving':'/api/checkout/fictional-checkout/receiving';
 await page.route('**'+endpoint,async route=>{
  if(route.request().method()!=='POST')return route.fallback();
  attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
  return route.fulfill({status:attempts.length===1?502:409,json:{error:'Creation is uncertain. Recover the original provider request before creating another.',code:'RECEIVING_UNCERTAIN'}});
 });
 await open(page,kind==='owner'?ledgerPath:'/pay/fictional-checkout');
 await page.getByLabel(kind==='owner'?'Payment request amount (CAD)':'Payment amount (CAD)',{exact:true}).fill('20.00');
 await page.getByRole('button',{name:kind==='owner'?'Create payment request':'Continue with live payment',exact:true}).click();
 const retry=page.getByRole('button',{name:'Retry saved payment request',exact:true});
 await expect(retry).toBeVisible();await retry.click();await expect(retry).toBeVisible();
 await retry.click();await expect.poll(()=>attempts.length).toBe(3);expect(attempts[1]).toEqual(attempts[0]);expect(attempts[2]).toEqual(attempts[0]);expect(state.requests).toEqual([]);
});


test('invoice requests follow the invoice filter and all cursor pages',async({page})=>{
 await fixture(page);const calls:string[]=[];
 await page.route('**/api/receiving**',async route=>{
  const url=new URL(route.request().url());calls.push(url.search);
  const valid=url.searchParams.get('invoiceId')===id;
  return route.fulfill({json:{adapters:[adapter],requests:valid&&url.searchParams.has('cursor')?[{id:'fictional-old-request',token:'fictional-old-token',invoiceId:id,method:'lightning',amount:3000,currency:'CAD',mode:'live',status:'awaiting_payment'}]:[],nextCursor:valid&&!url.searchParams.has('cursor')?'fictional-next':null}});
 });
 await open(page);await expect(page.getByRole('link',{name:'Open payment request',exact:true})).toHaveAttribute('href','/receive/fictional-old-token');
 await expect(page.getByText('Existing external payment requests cannot be cancelled by voiding this invoice.')).toBeVisible();expect(calls).toHaveLength(2);
});
