import {createRoot} from 'react-dom/client';
import {CheckoutPage} from '../../client/screens/Public';
import {InvoiceEditor} from '../../client/screens/InvoiceEditor';
import {ReceivePage} from '../../client/screens/Receiving';
import {setCsrf} from '../../client/api';
import {usePath} from '../../client/components';
import '../../client/styles.css';

setCsrf('fictional-invoice-csrf');
const params = new URLSearchParams(location.search);
function Fixture() {
  const path = usePath();
  if (path !== '/tests/fixtures/invoice-editor-ui.html') return <p>Fixture destination</p>;
  return params.has('receive') ? <ReceivePage token="fictional-receiving"/> : params.has('checkout')
    ? <CheckoutPage token="fictional-checkout"/>
    : <main className="main-content"><InvoiceEditor demo={params.has('demo')} onCreated={async () => {
      document.body.dataset.created = 'true';
    }}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
