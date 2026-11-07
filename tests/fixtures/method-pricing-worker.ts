// Fictional controlled SQLite contender for method-pricing confirmation races.
// No provider, network or real financial access; the database and key are test fiction.
import {DomainError,Store} from '../../server/store.js';
import {MethodPriceAgreements} from '../../server/method-pricing.js';

// Shared with tests/method-pricing-store.test.ts (fictional test key).
const FICTIONAL_ENCRYPTION_KEY=Buffer.alloc(32,47);
const store=new Store(process.argv[2],{encryptionKey:FICTIONAL_ENCRYPTION_KEY});
const pricing=new MethodPriceAgreements(store);
process.on('message',(message:unknown)=>{
  const job=message as {kind:'confirm';checkoutToken:string;method:string;offerHash:string;key:string};
  try{
    const body=pricing.confirm({checkoutToken:job.checkoutToken,method:job.method,offerHash:job.offerHash},job.key,()=>true);
    process.send?.({result:{method:job.method,agreement:body.agreement}});
  }catch(error){
    process.send?.({error:error instanceof Error?error.message:String(error),method:job.method,status:error instanceof DomainError?error.status:500,code:error instanceof DomainError?error.code:undefined});
  }finally{store.close();process.disconnect?.();}
});
process.send?.({ready:true});
