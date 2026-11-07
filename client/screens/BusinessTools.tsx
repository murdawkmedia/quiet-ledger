import {useRef,useState} from 'react';
import {Download,FileSearch,Files} from 'lucide-react';
import type {Currency,Invoice} from '../../shared/contracts';
import {CSV_PREVIEW_HEADERS,CSV_PREVIEW_MAX_BYTES,type CsvPreview,type InvoiceStatementPreview} from '../../shared/csv-preview';
import {date,downloadJson,methodLabel,post} from '../api';
import {Badge,ErrorMessage,PageHeading,PrivacyNote,SectionCard} from '../components';
import {CurrencyBalances} from '../CurrencyBalances';
import '../business-records.css';

const states={unpaid:'Unpaid',partially_paid:'Partially paid',paid:'Paid',credited:'Credited',void:'Void'};
const classifications={existing:'Existing number',duplicate:'Duplicate in CSV',new:'New candidate',invalid:'Invalid record'};
// Format the integer and fraction separately so the last cent is never rounded away.
function amount(value:number,currency:Currency){
 if(currency==='SAT'){if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid invoice amount.');return new Intl.NumberFormat('en-CA',{maximumFractionDigits:0}).format(value)+' sats';}
 const minor=BigInt(value),scale=currency==='KRW'?1n:100n,fraction=(minor%scale).toString().padStart(2,'0');
 return new Intl.NumberFormat('en-CA',{style:'currency',currency,currencyDisplay:'code'}).formatToParts(minor/scale).map(part=>part.type==='fraction'?fraction:part.value).join('');
}

export function BusinessTools({invoices}:{invoices:Invoice[]}){
 const [selected,setSelected]=useState<string[]>([]),[statement,setStatement]=useState<InvoiceStatementPreview>(),[statementBusy,setStatementBusy]=useState(false),[statementError,setStatementError]=useState('');
 const [csv,setCsv]=useState(''),[preview,setPreview]=useState<CsvPreview>(),[csvBusy,setCsvBusy]=useState(false),[csvError,setCsvError]=useState('');
 const statementInFlight=useRef(false),csvInFlight=useRef(false),fileReadSequence=useRef(0);
 const invoiceIds=new Set(invoices.map(invoice=>invoice.id)),selection=selected.filter(id=>invoiceIds.has(id)),bytes=new TextEncoder().encode(csv).length;
 function choose(id:string,checked:boolean){setSelected(current=>checked?[...current,id]:current.filter(value=>value!==id));setStatement(undefined);setStatementError('');}
 async function buildStatement(event:React.FormEvent){
  event.preventDefault();if(statementInFlight.current||!selection.length)return;statementInFlight.current=true;setStatementBusy(true);setStatementError('');setStatement(undefined);
  try{setStatement(await post<InvoiceStatementPreview>('/api/business-records/statement',{invoiceIds:selection}));}catch(error){setStatementError((error as Error).message);}finally{statementInFlight.current=false;setStatementBusy(false);}
 }
 function changeCsv(value:string){fileReadSequence.current++;setCsv(value);setPreview(undefined);setCsvError('');}
 async function readFile(file?:File){
  if(!file)return;const sequence=++fileReadSequence.current;setPreview(undefined);setCsvError('');
  try{if(file.size>CSV_PREVIEW_MAX_BYTES)throw new Error('CSV exceeds the 16 KiB UTF-8 limit.');const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(sequence===fileReadSequence.current)setCsv(text);}catch(error){if(sequence===fileReadSequence.current)setCsvError(error instanceof TypeError?'Choose a valid UTF-8 CSV file.':(error as Error).message);}
 }
 async function previewCsv(event:React.FormEvent){
  event.preventDefault();if(csvInFlight.current)return;csvInFlight.current=true;fileReadSequence.current++;setCsvBusy(true);setCsvError('');setPreview(undefined);
  try{if(bytes>CSV_PREVIEW_MAX_BYTES)throw new Error('CSV exceeds the 16 KiB UTF-8 limit.');setPreview(await post<CsvPreview>('/api/business-records/csv-preview',{csv}));}catch(error){setCsvError((error as Error).message);}finally{csvInFlight.current=false;setCsvBusy(false);}
 }
 return <div className="business-records">
  <PageHeading eyebrow="YOUR BUSINESS RECORDS" title="Statements & CSV preview." description="Review selected invoices and check balance files in your private workspace."/>
  <SectionCard title="Build a statement" description="Choose the exact invoices to include. Matching customer names do not select or combine invoices." className="business-statement-selection">
   <form onSubmit={buildStatement}>
    {invoices.length?<fieldset disabled={statementBusy} className="business-records-fieldset"><legend className="sr-only">Select issued invoices</legend><div className="business-invoice-selection">{invoices.map(invoice=><label key={invoice.id} className="business-invoice-choice"><input type="checkbox" checked={selection.includes(invoice.id)} onChange={event=>choose(invoice.id,event.target.checked)}/><span><strong>{invoice.number}</strong><span>{invoice.customerName} · {invoice.title}</span></span><span className="business-invoice-total">{amount(invoice.total,invoice.currency)}</span></label>)}</div></fieldset>:<p className="business-records-empty">Create an invoice to build a statement.</p>}
    <div className="business-records-actions"><button className="button primary" disabled={statementBusy||!selection.length||selection.length>200}><Files size={16}/>{statementBusy?'Building preview…':'Build statement preview'}</button><span>{selection.length} selected · up to 200 invoices</span></div>
   </form>
   {statementError?<ErrorMessage message={statementError}/>:null}
  </SectionCard>
  {statement?<section className="business-statement-preview" aria-labelledby="business-statement-title">
   <div className="business-preview-heading"><div><h2 id="business-statement-title">Statement preview</h2><p>Current balances for the invoices you selected. Issued invoice details are preserved.</p></div><button className="button secondary" onClick={()=>downloadJson(statement,'quiet-ledger-statement.json')}><Download size={16}/>Download statement JSON</button></div>
   <CurrencyBalances balances={statement.summary}/>
   {statement.invoices.map(({invoice,balance,entries})=><article className="panel business-statement-invoice" key={invoice.id}>
    <div className="business-statement-invoice-heading"><div><h3>{invoice.number}</h3><p>{invoice.customerName} · {invoice.title}</p></div><Badge tone={balance.mode==='live'?'good':'warm'}>{balance.mode==='live'?'Live':'Simulation'}</Badge></div>
    <dl className="business-invoice-dates"><div><dt>Issued</dt><dd>{date(invoice.issueDate??invoice.createdAt)}</dd></div><div><dt>Due</dt><dd>{date(invoice.dueDate)}</dd></div><div><dt>State</dt><dd>{states[balance.state]}</dd></div></dl>
    {invoice.paymentTerms?<p className="business-statement-terms">{invoice.paymentTerms}</p>:null}
    <dl className="business-statement-balances">{([['total','Original total'],['effectiveTotal','Effective total'],['paid','Payment value'],['credited','Credits'],['due','Due'],['overpaid','Overpaid']] as const).map(([field,label])=><div key={field}><dt>{label}</dt><dd>{amount(balance[field],balance.currency)}</dd></div>)}</dl>
     {invoice.priceAgreement?<p className="business-statement-terms">Payer-confirmed {methodLabel(invoice.priceAgreement.method)} price · agreement {invoice.priceAgreement.id}</p>:null}
    {entries.length?<div className="table-scroll" role="region" aria-label={`Entries for ${invoice.number}`} tabIndex={0}><table className="data-table"><thead><tr><th scope="col">Entry</th><th scope="col">Recorded</th><th scope="col" className="numeric">Amount</th><th scope="col">Details</th></tr></thead><tbody>{entries.map(entry=><tr key={entry.id}><th scope="row">{entry.kind==='payment'?'Payment':entry.kind==='credit'?'Credit note':'Void'}</th><td>{date(entry.createdAt)}</td><td className="numeric">{amount(entry.amount,entry.currency)}</td><td>{entry.reason??entry.receiptNumber??'Recorded invoice entry'}</td></tr>)}</tbody></table></div>:<p className="business-records-empty">No payments or adjustments recorded.</p>}
   </article>)}
  </section>:null}
  <SectionCard title="Check an invoice balance CSV" description="Preview the balance CSV exported by Quiet Ledger. Check number matches, duplicate records and amount issues before planning a migration." className="business-csv-input">
   <form onSubmit={previewCsv}><fieldset disabled={csvBusy} className="business-records-fieldset">
    <label className="field">Choose a local CSV file<input type="file" accept=".csv,text/csv" onChange={event=>void readFile(event.target.files?.[0])}/></label>
    <label className="field">Invoice balance CSV<textarea aria-label="Invoice balance CSV" rows={7} spellCheck={false} value={csv} maxLength={16*1024} onChange={event=>changeCsv(event.target.value)} aria-describedby="business-csv-limits"/></label>
    <p id="business-csv-limits" className="business-csv-limits">{bytes.toLocaleString()} / 16,384 UTF-8 bytes · up to 200 data records and 32 columns</p>
    <details className="business-csv-schema"><summary>Expected CSV columns</summary><p>{CSV_PREVIEW_HEADERS.join(', ')}</p><p>Amounts use the invoice currency. KRW requires whole won; SAT requires whole satoshis; other supported currencies allow up to two decimal places.</p><p>Files exported with the retired 13-column header still preview; effective-price columns apply to method-priced invoices.</p></details>
    <button className="button secondary" disabled={csvBusy||!csv.trim()}><FileSearch size={16}/>{csvBusy?'Checking CSV…':'Preview CSV'}</button>
   </fieldset></form>
   {csvError?<ErrorMessage message={csvError}/>:null}
   {preview?<div className="business-csv-preview" aria-labelledby="business-csv-preview-title"><h3 id="business-csv-preview-title">CSV preview results</h3><p className="business-csv-counts">{preview.counts.existing} existing · {preview.counts.duplicate} duplicate · {preview.counts.new} new candidates · {preview.counts.invalid} invalid</p>
    {preview.rows.length?<div className="table-scroll" role="region" aria-label="CSV preview records" tabIndex={0}><table className="data-table business-csv-table"><thead><tr><th scope="col">Record</th><th scope="col">Invoice</th><th scope="col">Result</th><th scope="col">Customer / title</th><th scope="col">Currency / mode</th><th scope="col" className="numeric">Total</th><th scope="col" className="numeric">Effective</th><th scope="col" className="numeric">Due</th><th scope="col">Issues</th></tr></thead><tbody>{preview.rows.map(row=><tr key={row.row}><td>{row.row}</td><th scope="row">{row.invoiceNumber||'Missing number'}</th><td>{classifications[row.classification]}</td><td>{row.record?<><span>{row.record.customerName}</span><span className="business-csv-title">{row.record.title}</span></>:'—'}</td><td>{row.record?`${row.record.balance.currency} · ${row.record.balance.mode}${row.record.pricingMethod?` · ${methodLabel(row.record.pricingMethod)}`:''}`:'—'}</td><td className="numeric">{row.record?amount(row.record.balance.total,row.record.balance.currency):'—'}</td><td className="numeric">{row.record?amount(row.record.balance.effectiveTotal,row.record.balance.currency):'—'}</td><td className="numeric">{row.record?amount(row.record.balance.due,row.record.balance.currency):'—'}</td><td>{row.issues.length?<ul>{row.issues.map((issue,index)=><li key={index}>{issue}</li>)}</ul>:row.classification==='existing'?'Number matches an invoice in this workspace.':row.classification==='new'?'Candidate for a future reviewed migration.':'No issues.'}</td></tr>)}</tbody></table></div>:<p className="business-records-empty">The CSV contains a header and no data records.</p>}
    <p role="status" className="business-preview-notice">{preview.notice}</p>
   </div>:null}
  </SectionCard>
  <PrivacyNote>These tools review records in your workspace. CSV balances are not payment receipts. Statements are available here and as a local download.</PrivacyNote>
 </div>;
}
