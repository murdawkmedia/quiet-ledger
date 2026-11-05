import { lstatSync,readFileSync } from 'node:fs';
import type { SquareSandboxOptions } from './square-sandbox.js';

export function loadSquareSandboxOptions(env:NodeJS.ProcessEnv):SquareSandboxOptions|undefined {
  const path=env.SQUARE_SANDBOX_TOKEN_FILE;
  if(!path)return undefined;
  try{
    const stat=lstatSync(path);
    if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size<1||stat.size>8192)throw new Error('invalid');
    const token=readFileSync(path,'utf8').trim();
    if(!token||token.length>4096||/\s/.test(token))throw new Error('invalid');
    const locationId=env.SQUARE_SANDBOX_LOCATION_ID?.trim();
    if(locationId&&!/^[A-Za-z0-9_-]{1,192}$/.test(locationId))throw new Error('invalid');
    return {token,...(locationId?{locationId}:{})};
  }catch{throw new Error('Square sandbox credential must be a private regular file (0600) with a valid test token.');}
}
