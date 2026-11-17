import {constants,openSync,closeSync,fstatSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createCoinosPosAdapter} from '../integrations/coinos-pos.js';

const sourceRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const failure=()=>new Error('The optional demo receiver requires an enabled hosted demo and a private receiving-token file.');

/** Operator-only, receiving-only configuration; never inherited by private account wallets. */
export function loadDemoLiveAdapter(env:NodeJS.ProcessEnv){
  const path=env.DEMO_LIVE_COINOS_TOKEN_FILE;
  if(!path)return undefined;
  try{
    if((env.HOSTED_ACCOUNTS!=='true'&&env.SELF_HOSTED!=='true')||env.HACKATHON_DEMO_ENABLED!=='true'||!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)throw failure();
    const rel=relative(sourceRoot,path);if(!isAbsolute(rel)&&!rel.startsWith('..'+sep))throw failure();
    const before=lstatSync(path),descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
    let text:string;
    try{
      const info=fstatSync(descriptor);
      if(!info.isFile()||info.dev!==before.dev||info.ino!==before.ino||info.nlink!==1||(info.mode&0o777)!==0o600||(process.getuid&&info.uid!==process.getuid())||info.size<64||info.size>65)throw failure();
      text=readFileSync(descriptor,'utf8');
      const after=fstatSync(descriptor),current=lstatSync(path);
      for(const sample of [after,current]){
        if(!sample.isFile()||sample.dev!==info.dev||sample.ino!==info.ino||sample.uid!==info.uid||(sample.mode&0o777)!==0o600||sample.nlink!==1||sample.size!==info.size||sample.mtimeMs!==info.mtimeMs||sample.ctimeMs!==info.ctimeMs)throw failure();
      }
      if(realpathSync(path)!==path)throw failure();
    }finally{closeSync(descriptor);}
    if(!/^[0-9a-f]{64}\n?$/.test(text))throw failure();
    return createCoinosPosAdapter({id:'demo-coinos-pos',token:text.trim(),expectedAddress:'countzapula@coinos.io'});
  }catch{throw failure();}
}
