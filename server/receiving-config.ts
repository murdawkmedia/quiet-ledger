import {MANUAL_RAIL_CURRENCIES} from '../shared/receiving.js';
import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCryptoAdapter,type CryptoAdapterConfig} from '../integrations/crypto-receiving.js';
import {createFiatAdapter,type FiatAdapterConfig} from '../integrations/fiat-receiving.js';
import {createArkAdapter,type ArkAdapterConfig,type ArkConnectionConfig} from '../integrations/ark-receiving.js';
import {createLnurlAdapter,type LnurlAdapterConfig} from '../integrations/lnurl-receiving.js';
import type {CollateralConfig} from '../integrations/collateral.js';
import type {ReceivingAdapter} from '../shared/receiving.js';
import {methodInfo} from '../shared/payment-methods.js';

export const manualReceiving:ReceivingAdapter={
  id:'owner-confirmed-manual',mode:'live',creationRetrySafe:true,supportedCurrenciesByMethod:MANUAL_RAIL_CURRENCIES,walletOptionIds:['manual-fiat','adjustment'],methods:['bank','wire','ach','sepa','interac','cash','check','gift_card','coupon','no_charge'],
  async create(context){
    if(context.mode!=='live'||context.expectedAtomic!==String(context.amount))throw new Error('Manual receiving amount/mode mismatch.');
    if((context.method==='ach'&&context.currency!=='USD')||(context.method==='sepa'&&context.currency!=='EUR')||(context.method==='interac'&&context.currency!=='CAD'))throw new Error('Manual rail requires its local currency.');
    return {providerId:context.requestId,asset:methodInfo(context.method).settlement==='noncash'?'NONCASH':context.currency,network:'manual',instructions:[{label:'Reference',value:context.requestId},{label:'Receiving arrangement',value:'Use the receiving details supplied directly by your merchant. This page does not provide bank account details.'},{label:'Confirmation',value:'A report is not payment. The merchant must independently review the exact received amount before issuing a receipt.'}]};
  },
  async check(){return {status:'review',reason:'Owner must independently verify the received transaction.'};},
};
export interface ReceivingConfiguration {adapters:ReceivingAdapter[];collateral?:CollateralConfig;arkConnections:ArkConnectionConfig[]}
const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function privateConfiguration(path:string){
  let fd:number|undefined;
  try{
    const rel=relative(sourceRoot,realpathSync(path));if(!rel.startsWith('..'+sep)&&!isAbsolute(rel))throw new Error();
    fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const stat=fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||(stat.mode&0o777)!==0o600||(process.getuid&&stat.uid!==process.getuid())||stat.size>131072||stat.size<2)throw new Error();
    return JSON.parse(readFileSync(fd,'utf8'));
  }finally{if(fd!==undefined)closeSync(fd);}
}
export function loadReceivingConnections(path?:string):ReceivingConfiguration{
  const result:ReceivingConfiguration={adapters:[manualReceiving],arkConnections:[]};if(!path)return result;
  try{
    const config=privateConfiguration(path);if(!config||typeof config!=='object'||!Array.isArray(config.connections)||config.connections.length>40)throw new Error();
    if(config.manualReceiving===false)result.adapters=[];
    for(const entry of config.connections){
      if(!entry||typeof entry!=='object'||!entry.options||typeof entry.options!=='object'||Array.isArray(entry.options))throw new Error();
      const options={...entry.options};delete options.fetcher;delete options.now;
      let adapter:ReceivingAdapter;let walletOptionIds:string[];
      if(entry.type==='crypto'){adapter=createCryptoAdapter(options as CryptoAdapterConfig);walletOptionIds=[options.kind==='manual'?(options.method==='usdt'||options.method==='usdc'?'manual':options.method==='cashu'?'cashu':options.method==='ark'?'ark':'watch-only'):options.kind];}
      else if(entry.type==='fiat'){
        adapter=createFiatAdapter(options as FiatAdapterConfig);walletOptionIds=[options.provider];
        if(options.provider==='revolut')adapter.recover=context=>createFiatAdapter({...options,recoverOnly:true} as FiatAdapterConfig).create(context);
      }else if(entry.type==='ark'){adapter=createArkAdapter(options as ArkAdapterConfig);walletOptionIds=['ark'];result.arkConnections.push(options as ArkConnectionConfig);}
      else if(entry.type==='lnurl'){adapter=createLnurlAdapter(options as LnurlAdapterConfig);walletOptionIds=['lnurl'];}
      else throw new Error();
      adapter.walletOptionIds=walletOptionIds;result.adapters.push(adapter);
    }
    if(config.collateral){const collateral={...config.collateral};delete collateral.fetcher;delete collateral.now;result.collateral=collateral as CollateralConfig;}
    if(new Set(result.adapters.map(a=>a.id)).size!==result.adapters.length)throw new Error();
    return result;
  }catch{throw new Error('Receiving configuration is invalid. Use a private regular0600 JSON file and documented provider fields. No secret values are logged.');}
}
