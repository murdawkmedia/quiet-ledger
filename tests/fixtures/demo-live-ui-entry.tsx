import {createRoot} from 'react-dom/client';
import {DemoLivePayment} from '../../client/DemoLivePayment';
import '../../client/styles.css';
createRoot(document.getElementById('root')!).render(<main style={{maxWidth:900,margin:'0 auto',padding:16}}><DemoLivePayment/></main>);
