import type {CurrencyBalanceSummary} from '../shared/currency-report';
import {Badge,SectionCard} from './components';

function amount(value:number,currency:CurrencyBalanceSummary['currency']) {
  if(currency==='SAT'){if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid invoice report amount.');return new Intl.NumberFormat('en-CA',{maximumFractionDigits:0}).format(value)+' sats';}
  const minor=BigInt(value),scale=currency==='KRW'?1n:100n;
  const fraction=(minor%scale).toString().padStart(2,'0');
  return new Intl.NumberFormat('en-CA',{style:'currency',currency,currencyDisplay:'code'}).formatToParts(minor/scale).map(part=>part.type==='fraction'?fraction:part.value).join('');
}

export function CurrencyBalances({balances}:{balances?:CurrencyBalanceSummary[]}) {
  return <SectionCard title="Invoice balances by currency" description="Invoice allocations in their original currency. Live and simulation records stay separate." className="currency-balances">
    {balances===undefined?<p className="panel-empty-copy" role="status">Currency balances are unavailable. Refresh to request the report from the server.</p>:balances.length===0?<p className="panel-empty-copy">No invoice balances to report yet.</p>:<>
      <div className="table-scroll currency-balances-scroll" role="region" aria-label="Invoice balances table" tabIndex={0}>
        <table className="data-table currency-balances-table" aria-label="Invoice balances by currency">
          <thead><tr><th scope="col">Currency</th><th scope="col">Mode</th><th scope="col" className="numeric">Invoices</th><th scope="col" className="numeric">Issued</th><th scope="col" className="numeric">Effective</th><th scope="col" className="numeric">Payment value</th><th scope="col" className="numeric">Credits</th><th scope="col" className="numeric">Voided balance</th><th scope="col" className="numeric">Due</th><th scope="col" className="numeric">Overpaid</th></tr></thead>
          <tbody>{balances.map(row=><tr key={`${row.currency}-${row.mode}`}>
            <th scope="row">{row.currency}</th><td><Badge tone={row.mode==='live'?'good':'warm'}>{row.mode==='live'?'Live':'Simulation'}</Badge></td><td className="numeric">{row.invoiceCount}</td>
            {(['issued','effective','paid','credited','voided','due','overpaid'] as const).map(field=><td key={field} className={`numeric${field==='due'?' currency-due':''}`}>{amount(row[field],row.currency)}</td>)}
          </tr>)}</tbody>
        </table>
      </div>
      <div className="currency-balances-note"><p>Payment value is allocated to invoices; it is not a wallet balance.</p><p>Issued is the original invoice total. Effective is the payer-confirmed method price after method discounts, premiums and tax adjustments; due, overpaid and voided balances use it.</p><p>Issued includes voided invoices. Voided balance is the unpaid amount retired. No currency conversion is applied.</p><p>SAT rows are whole satoshis. SAT invoices are excluded from the CAD reference totals; no fiat conversion is invented for them.</p></div>
    </>}
  </SectionCard>;
}
