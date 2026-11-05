import {lstatSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadOrCreatePrivateToken} from './private-token.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const failure=()=>new Error('Account startup requires a fixed secure origin and separate private storage/proxy keys; local owner configuration is not permitted.');
function outsideSource(path:string){const rel=relative(root,realpathSync(path));if(!rel.startsWith('..'+sep)&&!isAbsolute(rel))throw failure();}
function requiredPrivateFile(path:string|undefined,canonical=false):string{
  if(!path||!isAbsolute(path))throw failure();
  if(canonical&&(resolve(path)!==path||realpathSync(path)!==path))throw failure();
  const stat=lstatSync(path);outsideSource(path);
  if(!stat.isFile())throw failure();
  return loadOrCreatePrivateToken(path);
}
function selfhostDirectory(path:string|undefined){
  if(!path||!isAbsolute(path)||resolve(path)!==path||realpathSync(path)!==path)throw failure();
  const stat=lstatSync(path);outsideSource(path);
  if(!stat.isDirectory()||(stat.mode&0o777)!==0o700||(process.getuid&&stat.uid!==process.getuid()))throw failure();
}
function decodeKey(text:string){const key=Buffer.from(text,'base64url');if(key.length!==32||key.toString('base64url')!==text)throw failure();return key;}
export function loadHostedRuntime(env:NodeJS.ProcessEnv){
  const selfHosted=env.SELF_HOSTED==='true';
  if(env.HOSTED_ACCOUNTS!=='true'&&!selfHosted)return undefined;
  try{
    if(['OWNER_TOKEN','PRIVATE_SCENARIO_PATH','RECEIVING_CONNECTIONS_FILE','SQUARE_SANDBOX_TOKEN_FILE','SQUARE_SANDBOX_LOCATION_ID'].some(key=>Boolean(env[key])))throw failure();
    const origin=new URL(env.PUBLIC_ORIGIN??'');
    const insecureLoopback=selfHosted&&origin.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(origin.hostname);
    if(origin.origin!==env.PUBLIC_ORIGIN||origin.username||origin.password||origin.search||origin.hash||!(origin.protocol==='https:'||insecureLoopback))throw failure();
    if(insecureLoopback){
      // HTTP is a browser secure-context exception only on this computer. Never
      // let a changed bind address turn this into a public plaintext service.
      if(!['127.0.0.1','::1'].includes(env.HOST??'127.0.0.1'))throw failure();
      const port=Number(env.PORT??4417);if(!Number.isInteger(port)||port<1||port>65535||port!==Number(origin.port||80))throw failure();
    }
    const storageText=requiredPrivateFile(env.STORAGE_KEY_FILE,selfHosted),encryptionKey=decodeKey(storageText),proxySecret=requiredPrivateFile(env.PROXY_SHARED_SECRET_FILE,selfHosted);
    if(selfHosted){
      selfhostDirectory(env.DATA_DIR);selfhostDirectory(env.BACKUP_DIR);
      const backupText=requiredPrivateFile(env.BACKUP_KEY_FILE,true),backupKey=decodeKey(backupText);
      try{if(storageText===backupText||proxySecret===storageText||proxySecret===backupText)throw failure();}finally{backupKey.fill(0);}
    }
    return {hosted:{publicOrigin:origin.origin,proxySecret,hackathonDemo:env.HACKATHON_DEMO_ENABLED==='true',...(insecureLoopback?{allowInsecureLoopback:true}: {})},encryptionKey,selfHosted};
  }catch{throw failure();}
}
