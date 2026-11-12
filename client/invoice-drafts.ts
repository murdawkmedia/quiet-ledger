import type {Invoice} from '../shared/contracts';
import type {InvoiceDraft} from '../shared/invoice-options';
import type {InvoiceEditorSnapshot,SavedInvoiceDraft,SavedInvoiceDraftSummary} from '../shared/invoice-editor-drafts';
import {api,post} from './api';

/**
 * Owner-private saved invoice editor drafts. All calls ride the browser
 * session with CSRF protection; nothing is stored in localStorage.
 */
export const listInvoiceDrafts=()=>api<{drafts:SavedInvoiceDraftSummary[]}>('/api/invoice-drafts');
export const getInvoiceDraft=(id:string)=>api<{draft:SavedInvoiceDraft}>(`/api/invoice-drafts/${encodeURIComponent(id)}`);
export const saveInvoiceDraft=(id:string,expectedRevision:number,snapshot:InvoiceEditorSnapshot)=>api<{draft:SavedInvoiceDraftSummary}>(`/api/invoice-drafts/${encodeURIComponent(id)}`,{method:'PUT',body:JSON.stringify({expectedRevision,snapshot})});
export const deleteInvoiceDraft=(id:string)=>api<{deleted:boolean}>(`/api/invoice-drafts/${encodeURIComponent(id)}`,{method:'DELETE'});
export const issueInvoiceDraft=(id:string,expectedRevision:number,invoice:InvoiceDraft,key:string)=>post<{invoice:Invoice;draft:SavedInvoiceDraftSummary}>(`/api/invoice-drafts/${encodeURIComponent(id)}/issue`,{expectedRevision,invoice},key);
