import {createRoot} from 'react-dom/client';
import {BillingProjects} from '../../client/screens/BillingProjects';
import {MilestoneInvoice} from '../../client/screens/MilestoneInvoice';
import {setCsrf} from '../../client/api';
import {usePath} from '../../client/components';
import '../../client/styles.css';

setCsrf('fictional-billing-csrf');
// Initial view selection stays fixed for the page load; after that the fixture
// follows the same client-side paths the real parent app mounts, never storage.
const params = new URLSearchParams(location.search);
const initialMilestone = params.get('milestone');
const fixturePath = '/tests/fixtures/billing-ui.html';
function Fixture() {
  const path = usePath();
  const route = path.match(/^\/billing\/milestones\/([^/]+)\/invoice$/);
  const id = route ? decodeURIComponent(route[1]) : path === fixturePath ? initialMilestone : undefined;
  if (id) return <MilestoneInvoice id={id} onCreated={async () => {
    document.body.dataset.created = 'true';
  }}/>;
  if (path === fixturePath) return <BillingProjects/>;
  return <p>Fixture destination</p>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
