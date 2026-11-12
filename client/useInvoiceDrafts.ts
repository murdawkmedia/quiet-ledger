import {useCallback,useEffect,useRef,useState} from 'react';
import type {Invoice} from '../shared/contracts';
import type {InvoiceDraft} from '../shared/invoice-options';
import {canonicalSnapshot,type InvoiceEditorSnapshot} from '../shared/invoice-editor-drafts';
import {actionKey,ApiError} from './api';
import {issueInvoiceDraft,saveInvoiceDraft} from './invoice-drafts';
import {setNavigationGuard} from './components';

const AUTOSAVE_DELAY=1200,RETRY_BASE=2500,RETRY_MAX=20000;

export type InvoiceDraftSaveStatus='idle'|'saving'|'saved'|'error'|'uncertain';

export interface InvoiceDraftPersistenceOptions{
  /** Persistence is offered only in the normal private owner editor; demo and review callers keep it off. */
  enabled?:boolean;
  /** Restored draft identity when a saved draft is reopened; omitted for a fresh draft. */
  restored?:{id:string;revision:number;snapshot:InvoiceEditorSnapshot};
  /** Notified once when a fresh draft receives its server identity. */
  onDraftId?:(id:string)=>void;
}

export interface InvoiceDraftPersistence{
  draftId?:string;
  status:InvoiceDraftSaveStatus;
  error?:string;
  savedAt?:string;
  dirty:boolean;
  /** Records a snapshot change and schedules the debounced autosave. */
  update:(snapshot:InvoiceEditorSnapshot)=>void;
  /** Explicit save. Resolves false when the draft is definitely not saved. */
  saveNow:()=>Promise<boolean>;
  /** Issues the reviewed invoice from this draft, exactly once per attempt chain. */
  issue:(invoice:InvoiceDraft)=>Promise<Invoice>;
}

/**
 * Owner-private draft persistence for the invoice editor: debounced autosave
 * with an explicit save, visible status and honest uncertainty handling.
 *
 * An uncertain save (network or 5xx) keeps retrying the exact same payload and
 * revision, so a save that actually reached the server replays its result
 * instead of conflicting; only a definite rejection or a genuinely stale
 * revision surfaces as an error, and a failed save is never shown as “Saved”.
 * Reload and in-app navigation are guarded while changes are unsaved or an
 * outcome is uncertain. Issue calls keep their exact retry snapshot so the
 * same reviewed invoice is created exactly once.
 */
export function useInvoiceDraftPersistence({enabled=true,restored,onDraftId}:InvoiceDraftPersistenceOptions):InvoiceDraftPersistence{
  const [status,setStatus]=useState<InvoiceDraftSaveStatus>(restored?'saved':'idle');
  const [error,setError]=useState<string|undefined>(undefined);
  const [savedAt,setSavedAt]=useState<string|undefined>(undefined);
  const [dirty,setDirty]=useState(false);
  const [draftId,setDraftId]=useState<string|undefined>(restored?.id);
  const latest=useRef<InvoiceEditorSnapshot|undefined>(restored?.snapshot);
  const initialFingerprint=useRef<string|undefined>(undefined);
  const savedFingerprint=useRef<string|undefined>(restored?canonicalSnapshot(restored.snapshot):undefined);
  const revision=useRef(restored?.revision??0);
  const idRef=useRef<string|undefined>(restored?.id);
  const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const retryTimer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const wake=useRef<(()=>void)|undefined>(undefined);
  const active=useRef(true);
  const settling=useRef<Promise<boolean>|undefined>(undefined);
  const issueRetry=useRef<{id:string;expectedRevision:number;invoice:InvoiceDraft;key:string}|undefined>(undefined);
  const issued=useRef(false);
  const notified=useRef(Boolean(restored));
  const stateRef=useRef({dirty:false,saving:false,uncertain:false});
  const syncState=(next:Partial<typeof stateRef.current>)=>{stateRef.current={...stateRef.current,...next};};
  const on=useRef(enabled!==false);on.current=enabled!==false;

  const settle=useCallback(async():Promise<boolean>=>{
    if(!on.current)return true;
    clearTimeout(timer.current);clearTimeout(retryTimer.current);
    for(;;){
      const snapshot=latest.current;
      if(issued.current||!snapshot||canonicalSnapshot(snapshot)===savedFingerprint.current)return true;
      if(!idRef.current){idRef.current=actionKey();setDraftId(idRef.current);}
      const id=idRef.current,expected=revision.current;
      let attempt=0;
      for(;;){
        setStatus('saving');syncState({saving:true,uncertain:false});setError(undefined);
        let result:Awaited<ReturnType<typeof saveInvoiceDraft>>;
        try{result=await saveInvoiceDraft(id,expected,snapshot);}
        catch(failure){
          if(!active.current)return false;
          const definite=failure instanceof ApiError&&failure.status>=400&&failure.status<500&&failure.status!==408&&failure.status!==429;
          if(definite){setStatus('error');syncState({saving:false,uncertain:false});setError(failure.message);return false;}
          setStatus('uncertain');syncState({saving:false,uncertain:true});setError(failure instanceof ApiError?failure.message:undefined);
          // Retry the exact same payload and revision: a save that already
          // reached the server replays its stored result without advancing.
          const delay=Math.min(RETRY_BASE*2**attempt++,RETRY_MAX);
          await new Promise<void>(resolve=>{wake.current=resolve;retryTimer.current=setTimeout(()=>{wake.current=undefined;resolve();},delay);});
          if(!active.current)return false;
          continue;
        }
        if(!active.current)return false;
        revision.current=result.draft.revision;savedFingerprint.current=canonicalSnapshot(snapshot);
        if(!notified.current){notified.current=true;onDraftId?.(id);}
        setStatus('saved');setError(undefined);setSavedAt(new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}));setDirty(false);syncState({saving:false,uncertain:false});
        break;
      }
      // A newer snapshot may have arrived while this save was in flight.
      if(latest.current&&canonicalSnapshot(latest.current)!==savedFingerprint.current&&active.current)continue;
      return true;
    }
  },[onDraftId]);
  const runSettle=useCallback(()=>{if(settling.current)return settling.current;const promise=settle().finally(()=>{settling.current=undefined;});settling.current=promise;return promise;},[settle]);

  const update=useCallback((snapshot:InvoiceEditorSnapshot)=>{
    if(!on.current||issued.current)return;
    latest.current=snapshot;
    const content=canonicalSnapshot(snapshot);
    if(initialFingerprint.current===undefined)initialFingerprint.current=content;
    // Pristine content (nothing typed yet, or all edits reverted before the
    // first save) never creates a server draft; content that matches the last
    // confirmed save is clean but stays “saved”, never “idle”.
    if(content===savedFingerprint.current){
      clearTimeout(timer.current);setDirty(false);syncState({dirty:false});
      if(!settling.current&&status!=='uncertain'){setStatus('saved');setError(undefined);}
      return;
    }
    if(content===initialFingerprint.current&&!idRef.current){
      clearTimeout(timer.current);setDirty(false);syncState({dirty:false});
      if(!settling.current&&status!=='uncertain'){setStatus(restored?'saved':'idle');setError(undefined);}
      return;
    }
    setDirty(true);syncState({dirty:true});
    clearTimeout(timer.current);
    timer.current=setTimeout(()=>{void runSettle();},AUTOSAVE_DELAY);
  },[restored,runSettle,status]);

  const saveNow=useCallback(async():Promise<boolean>=>{clearTimeout(timer.current);return runSettle();},[runSettle]);

  const issue=useCallback(async(invoice:InvoiceDraft):Promise<Invoice>=>{
    // The reviewed invoice must be the saved draft content before issuing.
    const saved=await runSettle();
    if(!saved)throw new Error(error??'The draft could not be saved, so it cannot be issued.');
    if(!idRef.current||(latest.current&&canonicalSnapshot(latest.current)!==savedFingerprint.current))throw new Error('Save this draft before issuing it.');
    const operation=issueRetry.current??{id:idRef.current,expectedRevision:revision.current,invoice,key:actionKey()};
    issueRetry.current=operation;
    try{
      const result=await issueInvoiceDraft(operation.id,operation.expectedRevision,operation.invoice,operation.key);
      issued.current=true;issueRetry.current=undefined;
      return result.invoice;
    }catch(failure){
      // A definite rejection permits edits and a fresh issue attempt; an
      // unresolved outcome keeps the exact snapshot for a safe retry.
      const rejected=failure instanceof ApiError&&failure.status>=400&&failure.status<500&&failure.status!==408&&failure.status!==429;
      if(rejected)issueRetry.current=undefined;
      throw failure;
    }
  },[error,runSettle]);

  useEffect(()=>{
    if(!on.current)return;
    active.current=true;
    const unload=(event:BeforeUnloadEvent)=>{if(stateRef.current.dirty||stateRef.current.saving||stateRef.current.uncertain||issueRetry.current){event.preventDefault();event.returnValue='';}};
    window.addEventListener('beforeunload',unload);
    const clearGuard=setNavigationGuard(()=>!(stateRef.current.dirty||stateRef.current.saving||stateRef.current.uncertain||issueRetry.current)||window.confirm('This invoice draft has unsaved or unconfirmed changes. Leave anyway?'));
    return ()=>{active.current=false;window.removeEventListener('beforeunload',unload);clearGuard();clearTimeout(timer.current);clearTimeout(retryTimer.current);wake.current?.();};
  },[]);

  return {draftId,status,error,savedAt,dirty,update,saveNow,issue};
}
