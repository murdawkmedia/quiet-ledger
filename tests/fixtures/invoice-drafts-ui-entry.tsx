import {createRoot} from 'react-dom/client';
import {Link,navigate,usePath} from '../../client/components';
import {setCsrf} from '../../client/api';
import {NewInvoiceDraft} from '../../client/screens/SavedInvoiceDraftsNew';
import {SavedInvoiceDrafts} from '../../client/screens/SavedInvoiceDrafts';
import {SavedInvoiceDraftsEditor} from '../../client/screens/SavedInvoiceDraftsEditor';
import '../../client/styles.css';
setCsrf('fictional-invoice-drafts-csrf');
// A minimal mirror of the app's owner routes for the private saved-draft flow.
// The backend is fully route-mocked by the Playwright spec; no network.
function Fixture(){
  const path=usePath();
  const onCreated=async()=>{document.body.dataset.issued='true';navigate('/invoices');};
  if(path==='/invoices')return <main className="main-content"><h1>Fictional invoices</h1><p data-testid="invoices-page">Issued invoices live here.</p><Link to="/invoices/new">Create invoice</Link></main>;
  if(path==='/drafts')return <main className="main-content"><SavedInvoiceDrafts/></main>;
  if(/^\/drafts\/[0-9a-f-]{36}$/.test(path)){const id=path.split('/')[2];return <main className="main-content"><SavedInvoiceDraftsEditor key={id} id={id} onCreated={onCreated}/></main>;}
  return <main className="main-content"><NewInvoiceDraft onCreated={onCreated}/></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
