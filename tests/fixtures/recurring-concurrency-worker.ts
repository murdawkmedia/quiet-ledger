// Fictional controlled SQLite contender, with no provider/network access.
import {Store} from '../../server/store.js';
import {RecurringDrafts} from '../../server/recurring-drafts.js';
const store=new Store(process.argv[2],{encryptionKey:Buffer.alloc(32,43)}),service=new RecurringDrafts(store,()=>new Date('2026-03-31T22:59:00Z'));
process.on('message',(message:unknown)=>{const job=message as {kind:'prepare'|'issue';workspace:string;key:string;id:string;body:unknown};try{const result=job.kind==='prepare'?service.prepare(job.workspace,job.body,job.key):service.issue(job.workspace,job.id,job.body,job.key);process.send?.({result});}catch(error){process.send?.({error:(error as Error).message});}finally{store.close();process.disconnect?.();}});
process.send?.({ready:true});
