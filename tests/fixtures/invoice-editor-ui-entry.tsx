import {createRoot} from 'react-dom/client';
import {CheckoutPage} from '../../client/screens/Public';
import {InvoiceEditor} from '../../client/screens/InvoiceEditor';
import {setCsrf} from '../../client/api';
import '../../client/styles.css';

setCsrf('fictional-invoice-csrf');
const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(
  params.has('checkout')
    ? <CheckoutPage token="fictional-checkout"/>
    : <main className="main-content"><InvoiceEditor demo={params.has('demo')} onCreated={async () => {
      document.body.dataset.created = 'true';
    }}/></main>
);
