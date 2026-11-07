import {expect,test,type Page} from '@playwright/test';

// Fictional intercepted responses only; no account, provider or wallet is used.
const balances=[
  {currency:'CAD',mode:'live',invoiceCount:3,issued:30000,effective:28000,methodDiscount:2000,methodPremium:0,methodTaxAdjustment:0,paid:11000,credited:2000,voided:10000,due:7000,overpaid:2000},
  {currency:'CAD',mode:'simulation',invoiceCount:1,issued:12345,effective:12345,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0,paid:2345,credited:1000,voided:0,due:9000,overpaid:0},
  {currency:'USD',mode:'live',invoiceCount:1,issued:25000,effective:25000,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0,paid:0,credited:5000,voided:20000,due:0,overpaid:0},
  {currency:'KRW',mode:'live',invoiceCount:1,issued:123456,effective:123456,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0,paid:120000,credited:3456,voided:0,due:0,overpaid:0},
];
const invoice={id:'00000000-0000-4000-8000-000000000048',token:'fictional-currency-checkout',number:'QL-CURRENCY-48',title:'Fictional currency report work',customerName:'Fictional Customer',currency:'USD',items:[{description:'Fictional service',quantity:1,unitAmount:25000}],taxBps:0,subtotal:25000,tax:0,total:25000,totalCad:999999,amountSats:999999,status:'open',createdAt:'2026-11-06T00:00:00Z'};
async function fixture(page:Page,{report=balances,missing=false,demo=false}:{report?:typeof balances;missing?:boolean;demo?:boolean}={}){
  const mutations:string[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin==='http://127.0.0.1:4348'?route.continue():route.abort());
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()!=='GET'){mutations.push(`${request.method()} ${path}`);return route.fulfill({status:405,json:{error:'Read-only fictional fixture.'}});}
    if(path==='/api/session')return route.fulfill({json:{authenticated:true,role:demo?'demo':'owner',csrfToken:'fictional-csrf',privateScenarioAvailable:false}});
    if(path==='/api/dashboard')return route.fulfill({json:{invoices:[invoice],payouts:[],activity:[],totals:{invoicedCad:999999,receivedCad:12345,availableCad:2345,spentCad:0},...(!missing?{currencyBalances:report}:{})}});
    return route.fulfill({status:404,json:{error:`Unmocked fictional endpoint ${path}`}});
  });
  return {mutations,errors};
}
async function open(page:Page,path='/'){await page.goto(`/tests/fixtures/invoice-ledger-ui.html?path=${encodeURIComponent(path)}`);}
function exactAmount(currency:string,value:string){return new RegExp(`^${currency}\\s${value.replaceAll('.','\\.').replaceAll(',','\\,')}$`);}

for(const path of ['/','/records'])test(`${path} shows authoritative currency rows and separates simulation`,async({page},testInfo)=>{
  const state=await fixture(page);await open(page,path);
  const table=page.getByRole('table',{name:'Invoice balances by currency',exact:true});
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Currency','Mode','Invoices','Issued','Effective','Payment value','Credits','Voided balance','Due','Overpaid']);
  await expect(table.getByRole('row')).toHaveCount(5);
  const cad=table.getByRole('row').filter({has:page.getByText('Live',{exact:true})}).filter({has:page.getByRole('rowheader',{name:'CAD',exact:true})});
  await expect(cad.getByRole('cell')).toHaveText(['Live','3',exactAmount('CAD','300.00'),exactAmount('CAD','280.00'),exactAmount('CAD','110.00'),exactAmount('CAD','20.00'),exactAmount('CAD','100.00'),exactAmount('CAD','70.00'),exactAmount('CAD','20.00')]);
  const simulation=table.getByRole('row').filter({has:page.getByText('Simulation',{exact:true})});
  await expect(simulation).toContainText('CAD');
  await expect(simulation.getByRole('cell').nth(2)).toHaveText(exactAmount('CAD','123.45'));
  const usd=table.getByRole('row').filter({has:page.getByRole('rowheader',{name:'USD',exact:true})});
  await expect(usd.getByRole('cell').nth(2)).toHaveText(exactAmount('USD','250.00'));
  await expect(usd.getByRole('cell').nth(6)).toHaveText(exactAmount('USD','200.00'));
  const won=table.getByRole('row').filter({has:page.getByRole('rowheader',{name:'KRW',exact:true})});
  await expect(won.getByRole('cell').nth(2)).toHaveText(exactAmount('KRW','123,456'));
  await expect(won.getByRole('cell').nth(4)).toHaveText(exactAmount('KRW','120,000'));
  await expect(won.getByRole('cell').nth(5)).toHaveText(exactAmount('KRW','3,456'));
  await expect(page.getByText('Payment value is allocated to invoices; it is not a wallet balance.',{exact:true})).toBeVisible();
  expect(state.mutations).toEqual([]);expect(state.errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('currency-report-desktop.png'),fullPage:true});
});

for(const path of ['/','/records'])for(const missing of [true,false])test(`${path} ${missing?'missing':'empty'} report never infers balances from invoices`,async({page})=>{
  const state=await fixture(page,{missing,report:[]});await open(page,path);
  await expect(page.getByRole('heading',{name:'Invoice balances by currency',exact:true})).toBeVisible();
  await expect(page.getByText(missing?'Currency balances are unavailable. Refresh to request the report from the server.':'No invoice balances to report yet.',{exact:true})).toBeVisible();
  await expect(page.getByRole('table',{name:'Invoice balances by currency',exact:true})).toHaveCount(0);
  expect(state.mutations).toEqual([]);expect(state.errors).toEqual([]);
});

for(const path of ['/','/records'])test(`${path} currency table scrolls by keyboard on mobile without page overflow`,async({page},testInfo)=>{
  const state=await fixture(page);await page.setViewportSize({width:390,height:844});await open(page,path);
  const report=page.getByRole('region',{name:'Invoice balances table',exact:true});
  await expect(report).toBeVisible();await report.focus();await expect(report).toBeFocused();
  expect(await report.evaluate(node=>node.scrollWidth>node.clientWidth)).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect.poll(()=>report.evaluate(node=>node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  expect(state.mutations).toEqual([]);expect(state.errors).toEqual([]);
  await page.screenshot({path:testInfo.outputPath('currency-report-mobile.png'),fullPage:true});
});

test('owner legacy summaries state the CAD reference basis without a collected percentage',async({page})=>{
  const state=await fixture(page);await open(page);
  await expect(page.getByText('Payment value · CAD reference',{exact:true})).toBeVisible();
  await expect(page.getByText('Issued · CAD reference',{exact:true})).toBeVisible();
  await expect(page.getByText('Unpaid foreign-currency invoices use fixed references; settled invoices may use saved receipt quotes. SAT invoices are excluded; no sats-to-fiat conversion is applied.',{exact:true})).toBeVisible();
  await expect(page.getByText('Saved receiving quotes for live payments; simulation values otherwise.',{exact:true})).toBeVisible();
  await expect(page.getByText('CAD reference comparison',{exact:true})).toBeVisible();
  await expect(page.getByText('Collected',{exact:true})).toHaveCount(0);
  await page.getByRole('link',{name:'Invoices',exact:true}).click();
  await expect(page.getByText(/Received · CAD reference$/)).toBeVisible();
  await expect(page.getByText('Saved receiving quotes for live payments; simulation values otherwise.',{exact:true})).toBeVisible();
  expect(state.mutations).toEqual([]);expect(state.errors).toEqual([]);
});

test('demo dashboard keeps familiar labels and has no owner currency report',async({page})=>{
  const state=await fixture(page,{demo:true});await open(page);
  await expect(page.getByText('Payments received · CAD equivalent',{exact:true})).toBeVisible();
  await expect(page.getByText('Collected',{exact:true})).toBeVisible();
  await expect(page.getByRole('heading',{name:'Invoice balances by currency',exact:true})).toHaveCount(0);
  expect(state.mutations).toEqual([]);expect(state.errors).toEqual([]);
});

test('safe-integer currency amounts retain their last minor unit',async({page})=>{
  const state=await fixture(page,{report:[{currency:'CAD',mode:'live',invoiceCount:1,issued:Number.MAX_SAFE_INTEGER,effective:Number.MAX_SAFE_INTEGER,methodDiscount:0,methodPremium:0,methodTaxAdjustment:0,paid:0,credited:0,voided:0,due:Number.MAX_SAFE_INTEGER,overpaid:0}]});await open(page);
  const table=page.getByRole('table',{name:'Invoice balances by currency',exact:true});
  await expect(table.getByRole('cell').nth(2)).toHaveText(exactAmount('CAD','90,071,992,547,409.91'));
  expect(state.mutations).toEqual([]);expect(state.errors).toEqual([]);
});
