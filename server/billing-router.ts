import {Router,type Request,type Response} from 'express';
import {createDeliverableSchema,createMilestoneSchema,createProjectSchema,emptyActionSchema,renameProjectSchema,updateDeliverableSchema,updateMilestoneSchema} from '../shared/billing-records.js';
import {parse} from './domain.js';
import {BillingRecords} from './billing-records.js';
import {DomainError,Store,type StoredSession} from './store.js';

/**
 * Mount at /api/billing after the application's session, origin and CSRF checks:
 * `app.use('/api/billing', billingRouter(store, billing, now))`.
 * Owner browser sessions only; API-key, demo and hackathon workspaces are denied.
 * Every mutation is idempotent through the store. Authorization is checked before
 * the request body is parsed and before any idempotent response is replayed.
 */
export function billingRouter(store:Store,billing:BillingRecords,_now:()=>Date){
  const router=Router();
  const ownerWorkspace=(res:Response)=>{
    const session=res.locals.session as StoredSession|undefined;
    if(!session)throw new DomainError(401,'Sign in to continue.');
    if(res.locals.apiAccess||session.role!=='owner'||session.hackathonDemo)throw new DomainError(403,'Use your private owner browser workspace for billing records.');
    return session.workspace;
  };
  const noStore=(res:Response)=>res.setHeader('Cache-Control','no-store');
  const paramId=(req:Request)=>String(req.params.id??'');
  const mutate=(workspace:string,req:Request,res:Response,op:Record<string,unknown>,status:number,fn:()=>unknown)=>{
    const result=store.idempotent('billing:'+workspace,req.get('Idempotency-Key'),{...op,workspace},status,fn);
    noStore(res);res.status(result.status).json(result.body);
  };

  router.get('/projects',(req,res)=>{
    const workspace=ownerWorkspace(res);noStore(res);
    res.json(billing.overview(workspace));
  });
  router.post('/projects',(req,res)=>{
    const workspace=ownerWorkspace(res),input=parse(createProjectSchema,req.body);
    mutate(workspace,req,res,{op:'project.create',...input},201,()=>({project:billing.createProject(workspace,input.name)}));
  });
  router.patch('/projects/:id',(req,res)=>{
    const workspace=ownerWorkspace(res),input=parse(renameProjectSchema,req.body),id=paramId(req);
    mutate(workspace,req,res,{op:'project.rename',id,...input},200,()=>({project:billing.renameProject(workspace,id,input.name)}));
  });
  router.delete('/projects/:id',(req,res)=>{
    const workspace=ownerWorkspace(res),id=paramId(req);
    mutate(workspace,req,res,{op:'project.delete',id},200,()=>billing.deleteProject(workspace,id));
  });

  router.get('/milestones/:id',(req,res)=>{
    const workspace=ownerWorkspace(res);noStore(res);
    res.json({milestone:billing.milestone(workspace,paramId(req))});
  });
  router.post('/milestones',(req,res)=>{
    const workspace=ownerWorkspace(res),input=parse(createMilestoneSchema,req.body);
    mutate(workspace,req,res,{op:'milestone.create',...input},201,()=>({milestone:billing.createMilestone(workspace,input)}));
  });
  router.patch('/milestones/:id',(req,res)=>{
    const workspace=ownerWorkspace(res),input=parse(updateMilestoneSchema,req.body),id=paramId(req);
    mutate(workspace,req,res,{op:'milestone.update',id,...input},200,()=>({milestone:billing.updateMilestone(workspace,id,input)}));
  });
  router.delete('/milestones/:id',(req,res)=>{
    const workspace=ownerWorkspace(res),id=paramId(req);
    mutate(workspace,req,res,{op:'milestone.delete',id},200,()=>billing.deleteMilestone(workspace,id));
  });

  router.post('/deliverables',(req,res)=>{
    const workspace=ownerWorkspace(res),input=parse(createDeliverableSchema,req.body);
    mutate(workspace,req,res,{op:'deliverable.create',...input},201,()=>({deliverable:billing.createDeliverable(workspace,input)}));
  });
  router.patch('/deliverables/:id',(req,res)=>{
    const workspace=ownerWorkspace(res),input=parse(updateDeliverableSchema,req.body),id=paramId(req);
    mutate(workspace,req,res,{op:'deliverable.update',id,...input},200,()=>({deliverable:billing.updateDeliverable(workspace,id,input)}));
  });
  router.delete('/deliverables/:id',(req,res)=>{
    const workspace=ownerWorkspace(res),id=paramId(req);
    mutate(workspace,req,res,{op:'deliverable.delete',id},200,()=>billing.deleteDeliverable(workspace,id));
  });
  router.post('/deliverables/:id/release',(req,res)=>{
    const workspace=ownerWorkspace(res);parse(emptyActionSchema,req.body??{});
    mutate(workspace,req,res,{op:'deliverable.release',id:paramId(req)},200,()=>({deliverable:billing.release(workspace,paramId(req))}));
  });
  router.post('/deliverables/:id/unrelease',(req,res)=>{
    const workspace=ownerWorkspace(res);parse(emptyActionSchema,req.body??{});
    mutate(workspace,req,res,{op:'deliverable.unrelease',id:paramId(req)},200,()=>({deliverable:billing.unrelease(workspace,paramId(req))}));
  });
  return router;
}
