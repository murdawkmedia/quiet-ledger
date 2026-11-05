#!/usr/bin/env node
import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {homedir} from 'node:os';
import {dirname,isAbsolute,join,parse,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

const SOURCE_ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const MARKER='.quiet-ledger-selfhost.json';
const FORMAT='quiet-ledger-selfhost-v1';
const defaultOrigin='http://localhost:4417';
function fail(message){throw new Error(message);}
function within(parent,child){const part=relative(parent,child);return part===''||(!part.startsWith('..'+sep)&&part!=='..'&&!isAbsolute(part));}
function checkPath(value){if(typeof value!=='string'||!isAbsolute(value)||/[\0\r\n]/.test(value))fail('Use an absolute path without control characters.');return resolve(value);}
function noLinks(path){let cursor=parse(path).root;for(const part of path.slice(cursor.length).split(sep).filter(Boolean)){cursor=join(cursor,part);if(existsSync(cursor)){if(lstatSync(cursor).isSymbolicLink())fail('Self-host paths must not contain symbolic links.');}else {try{lstatSync(cursor);fail('Invalid self-host path.');}catch(error){if(error.code!=='ENOENT')throw error;}}}}
function privatePath(path,directory){noLinks(path);const stat=lstatSync(path);if(stat.isSymbolicLink()||(directory?!stat.isDirectory():!stat.isFile())||(stat.mode&0o777)!==(directory?0o700:0o600)||(typeof process.getuid==='function'&&stat.uid!==process.getuid())||(!directory&&stat.nlink!==1))fail('Existing self-host files must be privately owned with 0700 directories and 0600 files.');}
function origin(value){let parsed;try{parsed=new URL(value);}catch{fail('Use an exact HTTPS origin, or HTTP localhost for a local browser.');}const loopback=['localhost','127.0.0.1','[::1]'].includes(parsed.hostname);if(typeof value!=='string'||parsed.origin!==value||parsed.username||parsed.password||(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&loopback)))fail('Use an exact HTTPS origin, or HTTP localhost for a local browser.');return parsed;}
function sourceBoundary(source,directory){let cursor=source;const forbidden=[source];while(true){if(existsSync(join(cursor,'.git')))forbidden.push(cursor);const parent=dirname(cursor);if(parent===cursor)break;cursor=parent;}if(forbidden.some(path=>within(path,directory)))fail('Keep private self-host state outside the source repository and its parent vault.');}
function createParents(path){if(existsSync(path))return;createParents(dirname(path));mkdirSync(path,{mode:0o700});}
function writePrivate(path,value){writeFileSync(path,value,{flag:'wx',mode:0o600});}
function readEnvironment(path){privatePath(path,false);const result={};for(const line of readFileSync(path,'utf8').split('\n')){if(!line.trim()||line.startsWith('#'))continue;const match=/^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);if(!match||Object.hasOwn(result,match[1]))fail('Runtime configuration is invalid.');let value;try{value=JSON.parse(match[2]);}catch{value=match[2];}if(typeof value!=='string'||/[\0\r\n]/.test(value))fail('Runtime configuration is invalid.');result[match[1]]=value;}return result;}
function expectedEnvironment(directory,source,publicOrigin,demo){const parsed=origin(publicOrigin);return {
 NODE_ENV:'production',SELF_HOSTED:'true',HOSTED_ACCOUNTS:'true',PUBLIC_ORIGIN:publicOrigin,HOST:parsed.hostname==='[::1]'?'::1':'127.0.0.1',PORT:parsed.protocol==='http:'?(parsed.port||'80'):'4417',
 DATA_DIR:join(directory,'data'),BACKUP_DIR:join(directory,'backups'),STORAGE_KEY_FILE:join(directory,'secrets/storage-key'),BACKUP_KEY_FILE:join(directory,'secrets/backup-key'),PROXY_SHARED_SECRET_FILE:join(directory,'secrets/proxy-secret'),SELFHOST_CLIENT_DIR:join(source,'dist/client'),HACKATHON_DEMO_ENABLED:String(demo),SIMULATION_ONLY:'true',QUIET_LEDGER_STATE_DIR:directory,QUIET_LEDGER_SOURCE_DIR:source,QUIET_LEDGER_UID:String(process.getuid?.()??1000),QUIET_LEDGER_GID:String(process.getgid?.()??1000)
 };}
function validateKeys(directory){const values=[];for(const name of ['storage-key','backup-key','proxy-secret']){const path=join(directory,'secrets',name);privatePath(path,false);const value=readFileSync(path,'utf8').trim();if(!/^[A-Za-z0-9_-]{43}$/.test(value)||Buffer.from(value,'base64url').length!==32||Buffer.from(value,'base64url').toString('base64url')!==value)fail('Self-host key files are invalid.');values.push(value);}if(new Set(values).size!==3)fail('Storage, backup and proxy keys must be independent.');}

/** Creates a new empty account installation, or validates its exact existing ownership. Never prints key contents. */
export function setupSelfHost(options={}){
 const source=realpathSync(checkPath(options.sourceRoot??SOURCE_ROOT));
 const directory=checkPath(options.directory??join(homedir(),'.local/share/quiet-ledger-local'));
 noLinks(directory);sourceBoundary(source,directory);
 if(options.demo!==undefined&&typeof options.demo!=='boolean')fail('Demo must be explicitly true or false.');
 const markerPath=join(directory,MARKER);let marker;
 if(existsSync(directory)){
  privatePath(directory,true);if(!existsSync(markerPath))fail('Refusing an existing directory without a Quiet Ledger ownership marker.');privatePath(markerPath,false);
  try{marker=JSON.parse(readFileSync(markerPath,'utf8'));}catch{fail('Invalid self-host ownership marker.');}
  if(marker.format!==FORMAT||marker.directory!==directory||marker.sourceRoot!==source||typeof marker.demoEnabled!=='boolean')fail('This directory does not match the owned installation.');
  origin(marker.publicOrigin);
  if((options.publicOrigin!==undefined&&options.publicOrigin!==marker.publicOrigin)||(options.demo!==undefined&&options.demo!==marker.demoEnabled))fail('Existing installation options differ. Preserve its keys and configure a separate installation.');
  for(const name of ['data','backups','secrets'])privatePath(join(directory,name),true);
  validateKeys(directory);const env=readEnvironment(join(directory,'runtime.env'));const expected=expectedEnvironment(directory,source,marker.publicOrigin,marker.demoEnabled);
  for(const [key,value] of Object.entries(expected))if(env[key]!==value)fail('Existing runtime configuration differs from the owned installation.');
  return {directory,publicOrigin:marker.publicOrigin,demoEnabled:marker.demoEnabled,environment:env};
 }
 const publicOrigin=options.publicOrigin??defaultOrigin;origin(publicOrigin);const demoEnabled=options.demo===true;
 createParents(dirname(directory));noLinks(directory);mkdirSync(directory,{mode:0o700});
 for(const name of ['data','backups','secrets'])mkdirSync(join(directory,name),{mode:0o700});
 for(const name of ['storage-key','backup-key','proxy-secret'])writePrivate(join(directory,'secrets',name),randomBytes(32).toString('base64url')+'\n');
 const environment=expectedEnvironment(directory,source,publicOrigin,demoEnabled);
 writePrivate(join(directory,'runtime.env'),Object.entries(environment).map(([key,value])=>key+'='+JSON.stringify(value)).join('\n')+'\n');
 marker={format:FORMAT,directory,sourceRoot:source,publicOrigin,demoEnabled};writePrivate(markerPath,JSON.stringify(marker,null,2)+'\n');
 return {directory,publicOrigin,demoEnabled,environment};
}

async function main(){
 const options={};let start=false;
 for(let i=2;i<process.argv.length;i++){
  const arg=process.argv[i];if(arg==='--directory'||arg==='--origin'){const value=process.argv[++i];if(!value||value.startsWith('--'))fail('Missing setup option value.');options[arg==='--directory'?'directory':'publicOrigin']=value;}
  else if(arg==='--demo')options.demo=true;else if(arg==='--start')start=true;
  else if(arg==='--help'){console.log('Usage: node scripts/setup-selfhost.mjs [--directory /private/path] [--origin http://localhost:4417] [--demo] [--start]\nCreates or validates an independent encrypted account installation. Demo is opt-in.');return;}
  else fail('Unknown setup option. Use --help.');
 }
 const installation=setupSelfHost(options);
 console.log('Quiet Ledger private installation: '+installation.directory);
 console.log('Browser origin: '+installation.publicOrigin);
 console.log('Hackathon demo: '+(installation.demoEnabled?'explicitly enabled':'disabled; no accounts seeded'));
 if(!start){console.log('After npm run build, run this setup command with --start to serve the local installation.');return;}
 const inherited=Object.fromEntries(['PATH','HOME','LANG','LC_ALL','TMPDIR','TZ'].filter(key=>typeof process.env[key]==='string').map(key=>[key,process.env[key]]));
 const child=spawn(process.execPath,['--import','tsx','server/index.ts'],{cwd:SOURCE_ROOT,env:{...inherited,...installation.environment},stdio:'inherit'});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
 await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>{process.exitCode=code??(signal?1:0);resolve();});});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error('Self-host setup refused: '+error.message);process.exitCode=1;});
