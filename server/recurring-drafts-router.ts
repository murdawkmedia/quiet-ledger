import {Router} from 'express';
import {RecurringDrafts} from './recurring-drafts.js';
import {DomainError,Store,type StoredSession} from './store.js';

/** Mounted below the application's browser authentication, same-origin and CSRF middleware. */
export function recurringDraftsRouter(store:Store,now:()=>Date){
 const router=Router(),service=new RecurringDrafts(store,now);
 router.use((req,res,next)=>{
  if(!(/^\/recurring(?:\/|$)/).test(req.path))return next('router');
  const session=res.locals.session as StoredSession|undefined;
  if(!session)return next(new DomainError(401,'Sign in to continue.'));
  if(session.role!=='owner'||res.locals.apiAccess)return next(new DomainError(403,'Recurring drafts require the private owner browser workspace.'));
  next();
 });
 const workspace=(res:import('express').Response)=>(res.locals.session as StoredSession).workspace;
 const send=(res:import('express').Response,result:{status:number;body:unknown})=>res.status(result.status).json(result.body);
 router.get('/recurring/plans',(_req,res)=>res.json({plans:service.listPlans(workspace(res))}));
 router.post('/recurring/plans',(req,res)=>send(res,service.createPlan(workspace(res),req.body,req.get('Idempotency-Key'))));
 router.post('/recurring/plans/:id/pause',(req,res)=>send(res,service.pause(workspace(res),String(req.params.id),req.body,req.get('Idempotency-Key'))));
 router.get('/recurring/drafts',(_req,res)=>res.json({drafts:service.listDrafts(workspace(res))}));
 router.post('/recurring/prepare',(req,res)=>send(res,service.prepare(workspace(res),req.body??{},req.get('Idempotency-Key'))));
 router.get('/recurring/drafts/:id',(req,res)=>res.json({draft:service.getDraft(workspace(res),String(req.params.id))}));
 router.post('/recurring/drafts/:id/issue',(req,res)=>send(res,service.issue(workspace(res),String(req.params.id),req.body,req.get('Idempotency-Key'))));
 return router;
}
