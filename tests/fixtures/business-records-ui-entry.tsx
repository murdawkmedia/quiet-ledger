import React from 'react';
import {createRoot} from 'react-dom/client';
import type {Invoice} from '../../shared/contracts';
import {setCsrf} from '../../client/api';
import {BusinessTools} from '../../client/screens/BusinessTools';
import '../../client/styles.css';
setCsrf('fictional-business-tools-csrf');
const invoices:Invoice[]=[{id:'11111111-1111-4111-8111-111111111111',number:'INV-FICTIONAL-CAD',token:'fictional-unshared-token',title:'Fictional studio service',customerName:'Fictional Studio',currency:'CAD',items:[{description:'Service',quantity:1,unitAmount:1000}],subtotal:1000,taxBps:0,tax:0,total:1000,totalCad:1000,amountSats:1000,status:'open',issueDate:'2026-11-06',dueDate:'2026-12-06',createdAt:'2026-11-06T12:00:00Z'},{id:'22222222-2222-4222-8222-222222222222',number:'INV-FICTIONAL-KRW',token:'fictional-second-unshared-token',title:'Fictional whole won work',customerName:'Fictional Studio',currency:'KRW',items:[{description:'Service',quantity:1,unitAmount:144001}],subtotal:144001,taxBps:0,tax:0,total:144001,totalCad:1000,amountSats:1000,status:'open',createdAt:'2026-11-06T12:00:00Z'}];
createRoot(document.getElementById('root')!).render(<React.StrictMode><main style={{maxWidth:1200,margin:'auto',padding:24}}><BusinessTools invoices={invoices}/></main></React.StrictMode>);
