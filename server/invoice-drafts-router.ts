import {Router} from 'express';
import {InvoiceEditorDrafts} from './invoice-drafts.js';
import {DomainError,Store,type StoredSession} from './store.js';

/**
 * Private saved invoice editor drafts. Mounted below the application's browser
 * authentication, same-origin and CSRF middleware; API-key/public/demo
 * sessions cannot reach these owner-private records.
 */
export function invoiceDraftsRouter(store:Store,now:()=>Date){
  const router=Router(),service=new InvoiceEditorDrafts(store,now);
  router.use((req,res,next)=>{
    if(!(/^\/invoice-drafts(?:\/|$)/).test(req.path))return next('router');
    const session=res.locals.session as StoredSession|undefined;
    if(!session)return next(new DomainError(401,'Sign in to continue.'));
    if(session.role!=='owner'||res.locals.apiAccess)return next(new DomainError(403,'Saved invoice drafts require the private owner browser workspace.'));
    next();
  });
  const workspace=(res:import('express').Response)=>(res.locals.session as StoredSession).workspace;
  const send=(res:import('express').Response,result:{status:number;body:unknown})=>res.status(result.status).json(result.body);
  router.get('/invoice-drafts',(_req,res)=>res.json({drafts:service.list(workspace(res))}));
  router.get('/invoice-drafts/:id',(req,res)=>res.json({draft:service.get(workspace(res),String(req.params.id))}));
  router.put('/invoice-drafts/:id',(req,res)=>res.json(service.save(workspace(res),String(req.params.id),req.body)));
  router.delete('/invoice-drafts/:id',(req,res)=>res.json(service.remove(workspace(res),String(req.params.id))));
  router.post('/invoice-drafts/:id/issue',(req,res)=>send(res,service.issue(workspace(res),String(req.params.id),req.body,req.get('Idempotency-Key'))));
  return router;
}
