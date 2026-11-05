import {constants,openSync,closeSync,fstatSync,fchmodSync,writeFileSync,readSync} from 'node:fs';
import {randomBytes} from 'node:crypto';

const MESSAGE='Private access token file is invalid or unavailable.';

/** The caller supplies a trusted private parent directory. Existing files are never repaired or rotated. */
export function loadOrCreatePrivateToken(path:string):string {
  let fd:number|undefined;
  try{
    try{
      fd=openSync(path,constants.O_RDWR|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
      // Only our exclusively created file is chmodded; an existing target is never changed.
      fchmodSync(fd,0o600);
      writeFileSync(fd,randomBytes(32).toString('base64url')+'\n','utf8');
    }catch(error){
      if(fd!==undefined||!error||typeof error!=='object'||!('code'in error)||error.code!=='EEXIST')throw error;
      fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    }
    const info=fstatSync(fd);
    if(!info.isFile()||info.nlink!==1||(info.mode&0o777)!==0o600||info.size<32||info.size>514||(process.getuid&&info.uid!==process.getuid()))throw new Error(MESSAGE);
    const buffer=Buffer.alloc(515);
    const count=readSync(fd,buffer,0,buffer.length,0);
    if(count!==info.size||count>514)throw new Error(MESSAGE);
    const content=buffer.subarray(0,count).toString('utf8');
    const match=/^([\x21-\x7e]{32,512})(?:\r?\n)?$/.exec(content);
    const after=fstatSync(fd);
    if(!match||after.size!==info.size||after.nlink!==1||(after.mode&0o777)!==0o600)throw new Error(MESSAGE);
    return match[1];
  }catch{throw new Error(MESSAGE);}
  finally{if(fd!==undefined)closeSync(fd);}
}
