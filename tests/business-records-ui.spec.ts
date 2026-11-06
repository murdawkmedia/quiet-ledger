import {test,expect,type Page} from '@playwright/test';
import {previewInvoiceCsv,CSV_PREVIEW_HEADERS} from '../shared/csv-preview';
const csv=[CSV_PREVIEW_HEADERS.join(','),'INV-FICTIONAL-CAD,Fictional Studio,Fictional work,CAD,10,3,2,5,0,partially_paid,live,2026-11-06,2026-12-06','INV-NEW,Fictional Studio,"=HYPERLINK(""https://fictional.invalid"",""test"")",KRW,144001,0,0,144001,0,unpaid,simulation,,'].join('\n');
async function setup(page:Page){
 const calls:{path:string;body:any;csrf?:string}[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/business-records/statement',route=>{const req=route.request();calls.push({path:'statement',body:req.postDataJSON(),csrf:req.headers()['x-csrf-token']});return route.fulfill({json:{invoices:[{invoice:{id:'11111111-1111-4111-8111-111111111111',number:'INV-FICTIONAL-CAD',title:'Fictional studio service',customerName:'Fictional Studio',currency:'CAD',items:[{description:'Service',quantity:1,unitAmount:1000}],subtotal:1000,taxBps:0,tax:0,total:1000,status:'open',createdAt:'2026-11-06T12:00:00Z',issueDate:'2026-11-06',dueDate:'2026-12-06',paymentTermDays:30,paymentTerms:'Fictional agreed Net 30'},balance:{total:1000,paid:300,credited:200,due:500,overpaid:0,currency:'CAD',state:'partially_paid',mode:'live'},entries:[{id:'fictional-credit',kind:'credit',amount:200,currency:'CAD',createdAt:'2026-11-06T12:00:00Z',reason:'Fictional scope reduction'}]}],summary:[{currency:'CAD',mode:'live',invoiceCount:1,issued:1000,paid:300,credited:200,voided:0,due:500,overpaid:0}]}});});
 await page.route('**/api/business-records/csv-preview',route=>{const req=route.request();calls.push({path:'csv-preview',body:req.postDataJSON(),csrf:req.headers()['x-csrf-token']});try{return route.fulfill({json:previewInvoiceCsv(req.postDataJSON().csv,[{number:'INV-FICTIONAL-CAD'}])});}catch(e){return route.fulfill({status:400,json:{error:(e as Error).message}});}});
 await page.goto('/tests/fixtures/business-records-ui.html');return {calls,errors};
}
test('statement requires explicit selection, displays original terms and downloads a local preview',async({page})=>{
 const f=await setup(page),build=page.getByRole('button',{name:'Build statement preview',exact:true});await expect(build).toBeDisabled();
 await page.getByRole('checkbox',{name:/INV-FICTIONAL-CAD/}).check();await build.click();
 await expect(page.getByRole('heading',{name:'Statement preview',exact:true})).toBeVisible();await expect(page.getByText('Fictional agreed Net 30',{exact:true})).toBeVisible();await expect(page.getByText('Fictional scope reduction',{exact:true})).toBeVisible();
 expect(f.calls).toEqual([{path:'statement',body:{invoiceIds:['11111111-1111-4111-8111-111111111111']},csrf:'fictional-business-tools-csrf'}]);
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download statement JSON',exact:true}).click();expect((await download).suggestedFilename()).toBe('quiet-ledger-statement.json');
 await page.getByRole('checkbox',{name:/INV-FICTIONAL-KRW/}).check();await expect(page.getByRole('heading',{name:'Statement preview',exact:true})).toHaveCount(0);expect(f.errors).toEqual([]);
});
test('CSV records are labelled and inert, whole won stays exact, and editing clears the preview',async({page})=>{
 const f=await setup(page);await page.getByLabel('Invoice balance CSV',{exact:true}).fill(csv);await page.getByRole('button',{name:'Preview CSV',exact:true}).click();
 await expect(page.getByText('Preview only; no records imported',{exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'Existing number',exact:true})).toBeVisible();await expect(page.getByRole('cell',{name:'New candidate',exact:true})).toBeVisible();
 await expect(page.getByRole('cell',{name:/144,001/}).first()).toBeVisible();await expect(page.getByText('=HYPERLINK("https://fictional.invalid","test")',{exact:true})).toBeVisible();await expect(page.locator('a[href*="fictional.invalid"]')).toHaveCount(0);
 expect(f.calls).toHaveLength(1);expect(f.calls[0].csrf).toBe('fictional-business-tools-csrf');await page.getByLabel('Invoice balance CSV',{exact:true}).fill('changed');await expect(page.getByRole('heading',{name:'CSV preview results',exact:true})).toHaveCount(0);expect(f.errors).toEqual([]);
});
test('malformed CSV shows a reason and a mobile preview stays inside the viewport',async({page})=>{
 await page.setViewportSize({width:390,height:844});const f=await setup(page);
 await page.getByLabel('Invoice balance CSV',{exact:true}).fill('"unclosed');await page.getByRole('button',{name:'Preview CSV',exact:true}).click();await expect(page.getByRole('alert')).toContainText('unclosed');
 await page.getByLabel('Invoice balance CSV',{exact:true}).fill(csv);await page.getByRole('button',{name:'Preview CSV',exact:true}).click();await expect(page.getByRole('heading',{name:'CSV preview results',exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(f.errors).toEqual([]);
});
