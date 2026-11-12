import {Router} from 'express';
import type {ApiAccess} from './api-access.js';
import {DomainError,type StoredSession} from './store.js';
import type {InvoiceEvents} from './invoice-events.js';

const SCOPE='events:read';
const QUERY_KEYS=['limit','cursor'];

/**
 * Read-only authenticated pull interface for durable invoice events. The
 * parent application mounts this after its session and API-key middleware
 * (for example app.use('/api',invoiceEventsRouter(invoiceLedger.events));
 * the /api/v1 prefix is normalized by createApiAccess before it). The
 * workspace comes only from res.locals.session; demos and hackathon contexts
 * are refused; API keys need the dedicated events:read scope with no broader
 * fallback; responses are no-store. There is no POST/acknowledgement route,
 * no signing key and no outbound delivery.
 */
export function invoiceEventsRouter(events:InvoiceEvents){
  const router=Router();
  router.all('/invoice-events',(req,res,next)=>{
    if(req.method!=='GET')return next(new DomainError(403,'Invoice events are read-only.'));
    next();
  });
  router.get('/invoice-events',(req,res)=>{
    const session=res.locals.session as StoredSession|undefined;
    if(!session)throw new DomainError(401,'Sign in to continue.');
    const access=res.locals.apiAccess as ApiAccess|undefined;
    if(access&&!(access.scopes as readonly string[]).includes(SCOPE))throw new DomainError(403,'This API resource or operation is not permitted.');
    if(session.role!=='owner'||session.hackathonDemo)throw new DomainError(403,'Invoice events are available only to the private owner workspace.');
    let limit=25;
    for(const [key,value] of Object.entries(req.query)){
      if(!QUERY_KEYS.includes(key))throw new DomainError(400,'Unexpected invoice event query parameter.');
      if(Array.isArray(value))throw new DomainError(400,'Duplicate invoice event query parameter.');
      const text=String(value);
      if(key==='limit'){
        if(!/^[1-9][0-9]{0,2}$/.test(text)||Number(text)>100)throw new DomainError(400,'Invoice event limit must be between 1 and 100.');
        limit=Number(text);
      }else if(!/^[A-Za-z0-9_-]{1,512}$/.test(text))throw new DomainError(400,'Invalid invoice event cursor.');
    }
    const cursor=typeof req.query.cursor==='string'?req.query.cursor:undefined;
    res.setHeader('Cache-Control','no-store');
    res.json(events.page(session.workspace,limit,cursor));
  });
  return router;
}
