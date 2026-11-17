import {test,expect,type Page} from '@playwright/test';
import {finalizeEvent,getPublicKey,type EventTemplate} from 'nostr-tools/pure';

// Built-app journey for external-wallet Cashu receiving. Every account, wallet,
// mint and transfer below is fictional: no wallet, mint, relay or provider is
// contacted, the "transfer" is a controlled fiction, and no funded acceptance
// is claimed. The fixture counts any transport attempt and fails it.
const origin='http://localhost:4336';
const instructions='FICTIONAL transfer channel: open the shared fictional Minibits group and send the ecash to the merchant there.';
const privateLabel='Private fictional Cashu workspace label';
const mint='https://mint.minibits.cash/Bitcoin';

async function syntheticSigner(page:Page,scalar:number){
  // Known public test scalar, never an actual signer/wallet key.
  const key=new Uint8Array(32);key[31]=scalar;const pubkey=getPublicKey(key);
  await page.exposeFunction('__quietSyntheticCashuSign',(event:EventTemplate)=>finalizeEvent(event,key));
  await page.addInitScript(({pubkey})=>{window.nostr={getPublicKey:async()=>pubkey,signEvent:async event=>(window as any).__quietSyntheticCashuSign(event)};},{pubkey});
}
async function signup(page:Page,scalar:number){
  await syntheticSigner(page,scalar);await page.goto('/');
  await page.getByRole('button',{name:'Create an account',exact:true}).click();
  await page.getByLabel('Private display name (optional)',{exact:true}).fill(`Fictional Cashu browser account ${scalar}`);
  await page.getByRole('button',{name:'Create account with Nostr',exact:true}).click();
  await expect(page.getByRole('heading',{name:'A clearer picture.',exact:true})).toBeVisible();
  return (await page.request.get('/api/session')).json();
}
async function saveCashuWallet(page:Page,hosting:string,label=privateLabel){
  await page.goto('/integrations');await page.getByRole('button',{name:'Connect Cashu external wallet',exact:true}).click();
  await page.getByLabel('Connection label (optional)',{exact:true}).fill(label);
  await page.getByLabel('Wallet hosting',{exact:true}).selectOption(hosting);
  await page.getByLabel('External wallet',{exact:true}).selectOption('Minibits');
  await page.getByLabel('Cashu mint (send on this exact mint)',{exact:true}).selectOption(mint);
  await page.getByLabel('Receiving instructions',{exact:true}).fill(instructions);
  const response=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/account/connections'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Save receiving instructions',exact:true}).click();
  const saved=await response;expect(saved.status()).toBe(201);const result=await saved.json();
  await expect(page.getByText('Saved instructions · manual confirmation',{exact:true})).toBeVisible();
  expect(JSON.stringify(result)).not.toContain(instructions);return result.connection;
}
async function createSatInvoice(page:Page){
  await page.goto('/invoices/new');
  await page.getByLabel('Customer name',{exact:true}).fill('Fictional Cashu customer');
  await page.getByLabel('Invoice title',{exact:true}).fill('Fictional external Cashu SAT invoice');
  await page.getByLabel('Item 1 description',{exact:true}).fill('Fictional service');
  await page.getByLabel('Item 1 unit price',{exact:true}).fill('21');
  await page.getByLabel('Invoice currency',{exact:true}).selectOption('SAT');
  await page.getByLabel('Tax rate (%)',{exact:true}).fill('0');
  await page.getByLabel('Accept Cashu ecash',{exact:true}).check();
  // Hosted accounts issue through the saved-draft flow, not a direct invoice POST.
  const issueResponse=page.waitForResponse(response=>/\/invoice-drafts\/[^/]+\/issue$/.test(new URL(response.url()).pathname)&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Create invoice',exact:true}).click();
  const created=await issueResponse;expect(created.status()).toBe(201);return (await created.json()).invoice;
}

test('owner saves a third-party Cashu wallet and settles a 21-sat invoice with manual confirmation',async({page,browser},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const relaySockets:string[]=[];page.on('websocket',socket=>relaySockets.push(socket.url()));
  await signup(page,21);
  const connection=await saveCashuWallet(page,'Third-party wallet');
  // The readiness lane states manual verification and claims no funded state.
  const lane=page.locator('[aria-label="Cashu ecash readiness"]');
  await expect(lane).toBeVisible();await expect(lane.getByText('Saved · manual confirmation',{exact:true})).toBeVisible();
  await expect(lane).toContainText(/Needs your confirmation|manual owner confirmation/);
  await page.screenshot({path:info.outputPath('fictional-cashu-readiness.png'),fullPage:true,animations:'disabled'});
  // A whole-satoshi SAT invoice with the cashu method accepted.
  const invoice=await createSatInvoice(page);
  expect(invoice.currency).toBe('SAT');expect(invoice.total).toBe(21);
  // The payer picks the cashu method and receives full manual instructions.
  const publicContext=await browser.newContext(),payer=await publicContext.newPage();
  try{
    await payer.goto(`${origin}/pay/${invoice.token}`);await expect(payer.getByRole('heading',{name:'Choose how to pay.',exact:true})).toBeVisible();
    await payer.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('cashu');
    await expect(payer.getByRole('heading',{name:'Manual ecash transfer instructions.',exact:true})).toBeVisible();
    const requestResponse=payer.waitForResponse(response=>response.url().includes('/receiving')&&response.request().method()==='POST');
    await payer.getByRole('button',{name:'Continue with live payment',exact:true}).click();
    const received=await requestResponse;expect(received.status()).toBe(201);const {request}=await received.json();
    expect(request.status).toBe('awaiting_payment');expect(request.adapterId).toBe(connection.id);
    await expect(payer).toHaveURL(new RegExp(`/receive/${request.token}$`));
    // Instruction sheet: exact mint, hosting label with manual level, net sats, unique reference.
    await expect(payer.getByText('Before you send ecash',{exact:true})).toBeVisible();
    await expect(payer.getByText(mint,{exact:true})).toBeVisible();
    await expect(payer.getByText('Wallet hosting',{exact:true})).toBeVisible();
    await expect(payer.getByText(/Third-party wallet · verification level: manual owner confirmation/)).toBeVisible();
    await expect(payer.getByText('21 sats net of fees on the mint above',{exact:true})).toBeVisible();
    await expect(payer.getByText(`cashu-external:${request.id}`,{exact:true})).toBeVisible();
    await expect(payer.getByText('cashu-external (Third-party wallet)',{exact:true})).toBeVisible();
    await expect(payer.locator('body')).not.toContainText(privateLabel);
    // Checking never credits; the payer stays in owner review.
    await payer.getByRole('button',{name:'Check payment',exact:true}).click();
    await expect(payer.getByText('Awaiting owner review',{exact:true})).toBeVisible();
    await expect(payer.getByRole('heading',{name:'Payment verified.',exact:true})).toHaveCount(0);
    const stillOpen=await(await page.request.get(`/api/invoices/${invoice.id}`)).json();expect(stillOpen.status).toBe('open');
    // Phone viewport: the instruction sheet fits without horizontal scroll.
    await payer.setViewportSize({width:390,height:844});
    expect(await payer.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await payer.screenshot({path:info.outputPath('fictional-cashu-payer-mobile.png'),fullPage:true,animations:'disabled'});
    // The owner confirms only after importing and verifying the ecash in their own wallet.
    await page.goto('/payment-methods');
    await page.getByRole('button',{name:'Review a manually verified payment',exact:true}).click();
    await expect(page.getByText(/Do not confirm from a pasted token/)).toBeVisible();
    await page.getByLabel(/Received transaction reference/).fill('fictional-browser-wallet-reference-1');
    await page.getByLabel('Verification note',{exact:true}).fill('FICTIONAL browser owner review: imported the received ecash into my own Minibits wallet and verified it is spendable there. No mint was contacted.');
    await page.getByLabel('I verified the exact asset, network, amount and invoice',{exact:true}).check();
    await page.screenshot({path:info.outputPath('fictional-cashu-owner-review.png'),fullPage:true,animations:'disabled'});
    await page.getByRole('button',{name:'Confirm independently verified payment',exact:true}).click();
    await expect.poll(async()=>(await(await page.request.get(`/api/invoices/${invoice.id}`)).json()).status).toBe('paid');
    const settled=await(await page.request.get(`/api/invoices/${invoice.id}`)).json();
    expect(settled.status).toBe('paid');expect(settled.nativePayment.network).toBe('cashu-external (Third-party wallet)');
    expect(settled.nativePayment.verification).toBe('manual');expect(settled.nativePayment.atomicAmount).toBe('21');
    // Receipt provenance is manual in the explicitly hosted external wallet.
    const receipt=await(await page.request.get(`/api/receipts/${settled.receiptToken}`)).json();
    expect(receipt.receipt.method).toBe('cashu');expect(receipt.receipt.mode).toBe('live');
    expect(receipt.receipt.nativePayment.verification).toBe('manual');
    expect(receipt.receipt.nativePayment.network).toBe('cashu-external (Third-party wallet)');
    await payer.setViewportSize({width:1280,height:800});
    await payer.reload();await expect(payer.getByRole('heading',{name:'Payment verified.',exact:true})).toBeVisible();
    await expect(payer.getByText('Live payment · real funds',{exact:true})).toBeVisible();
    await payer.screenshot({path:info.outputPath('fictional-cashu-payer-verified.png'),fullPage:true,animations:'disabled'});
  }finally{await publicContext.close();}
  expect((await(await page.request.get('/_fixture/transport-calls')).json()).calls).toBe(0);
  expect(relaySockets).toEqual([]);expect(errors).toEqual([]);
});

test('a self-hosted wallet choice persists and serves its own custody label on public checkout',async({page,browser},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await signup(page,22);
  const connection=await saveCashuWallet(page,'Self-hosted wallet (user-run)','Fictional self-hosted Cashu wallet');
  const lane=page.locator('[aria-label="Cashu ecash readiness"]');
  await expect(lane.getByText('Saved · manual confirmation',{exact:true})).toBeVisible();
  const invoice=await createSatInvoice(page);
  const publicContext=await browser.newContext(),payer=await publicContext.newPage();
  try{
    await payer.goto(`${origin}/pay/${invoice.token}`);
    await payer.getByRole('combobox',{name:'Payment method',exact:true}).selectOption('cashu');
    const requestResponse=payer.waitForResponse(response=>response.url().includes('/receiving')&&response.request().method()==='POST');
    await payer.getByRole('button',{name:'Continue with live payment',exact:true}).click();
    const received=await requestResponse;expect(received.status()).toBe(201);const {request}=await received.json();
    expect(request.adapterId).toBe(connection.id);
    await expect(payer.getByText(/Self-hosted wallet \(user-run\) · verification level: manual owner confirmation/)).toBeVisible();
    await expect(payer.getByText('cashu-external (Self-hosted wallet (user-run))',{exact:true})).toBeVisible();
    await expect(payer.locator('body')).not.toContainText('Fictional self-hosted Cashu wallet');
    await payer.setViewportSize({width:390,height:844});
    await payer.screenshot({path:info.outputPath('fictional-cashu-self-hosted-payer-mobile.png'),fullPage:true,animations:'disabled'});
  }finally{await publicContext.close();}
  expect((await(await page.request.get('/_fixture/transport-calls')).json()).calls).toBe(0);
  expect(errors).toEqual([]);
});
