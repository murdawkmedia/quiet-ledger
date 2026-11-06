import {createRoot} from 'react-dom/client';
import App from '../../client/App';
import '../../client/styles.css';
const path=new URLSearchParams(location.search).get('path')??'/invoices';
history.replaceState({},'',path.startsWith('/')&&!path.startsWith('//')?path:'/invoices');
createRoot(document.getElementById('root')!).render(<App/>);
