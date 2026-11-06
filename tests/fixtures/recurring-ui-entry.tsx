import {createRoot} from 'react-dom/client';
import {RecurringPage} from '../../client/screens/Recurring';
import {setCsrf} from '../../client/api';
import '../../client/styles.css';
setCsrf('fictional-recurring-csrf');
createRoot(document.getElementById('root')!).render(<main className="main-content"><RecurringPage/></main>);
