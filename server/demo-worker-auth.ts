import {constants,openSync,closeSync,fstatSync,readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute} from 'node:path';

/** Read an operator-owned service token, never a token supplied by a visitor. */
export function readDemoWorkerToken(path:string):string {
 if(!isAbsolute(path))throw new Error('The demo worker token path must be absolute.');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try {
  const info=fstatSync(fd);
  if(!info.isFile()||(info.mode&0o777)!==0o600||info.nlink!==1||info.size<32||info.size>512||realpathSync(dirname(path))!==dirname(path)||(process.getuid&&info.uid!==process.getuid()))throw new Error('The demo worker token file must be private.');
  const token=readFileSync(fd,'utf8').trim();
  if(!/^[A-Za-z0-9_-]{32,256}$/.test(token))throw new Error('Invalid demo worker token configuration.');
  return token;
 }finally{closeSync(fd);}
}
