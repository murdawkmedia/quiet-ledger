import {build} from 'esbuild';
import {mkdir,writeFile,readFile,copyFile,cp,rm} from 'node:fs/promises';
import {resolve,relative,dirname,parse} from 'node:path';
import {createHash} from 'node:crypto';
const root=process.cwd(),output=resolve(root,'dist/hosted');
// Generated output only; this path is owned by this build script.
await rm(output,{recursive:true,force:true});await mkdir(output,{recursive:true});
await build({entryPoints:{'server/index':'server/index.ts','ops/backup':'ops/backup.ts','ops/demo-state-backup':'ops/demo-state-backup.ts'},outdir:output,bundle:true,platform:'node',target:'node26',format:'esm',packages:'external',sourcemap:false,logLevel:'warning'});
await cp('dist/client',resolve(output,'public'),{recursive:true});
await build({entryPoints:['ops/pages-entry.ts'],outfile:resolve(output,'public/_worker.js'),bundle:true,platform:'browser',target:'es2023',format:'esm',sourcemap:false,minify:true,logLevel:'warning'});
await writeFile(resolve(output,'public/_routes.json'),JSON.stringify({version:1,include:['/*'],exclude:[]})+'\n');
await writeFile(resolve(output,'public/_headers'),`/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  X-Frame-Options: DENY
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'
  X-Robots-Tag: noindex, nofollow
/index.html
  Cache-Control: no-store
/api/*
  Cache-Control: no-store
`);
await writeFile(resolve(output,'public/robots.txt'),'User-agent: *\nDisallow: /\n');
const notices=[];
for(const [name,file] of [['react','LICENSE'],['react-dom','LICENSE'],['lucide-react','LICENSE'],['@simplewebauthn/browser','LICENSE.md'],['@fontsource/dm-sans','LICENSE'],['@fontsource/lora','LICENSE'],['@internet-privacy/marmot-ts','LICENSE'],['@internet-privacy/marmot-ts','dist/vendor/ts-mls/LICENSE'],['nostr-tools','LICENSE'],['ws','LICENSE'],['@noble/curves','LICENSE'],['@noble/ciphers','LICENSE'],['@noble/hashes','LICENSE']]){
  notices.push('--- '+name+' ---\n'+await readFile(resolve(root,'node_modules',name,file),'utf8'));
}
// Marmot vendors ts-mls and adds its own dependency tree. Include each exact
// installed package's notices, including nested versions, without downloading.
const visited=new Set();
async function dependencyNotices(directory){
  const manifest=JSON.parse(await readFile(resolve(directory,'package.json'),'utf8'));
  const identity=manifest.name+'@'+manifest.version;
  if(visited.has(identity))return;visited.add(identity);
  for(const file of ['LICENSE','LICENSE.md','LICENSE.txt','LICENSE-MIT','COPYING','NOTICE','NOTICE.txt']){
    try{notices.push('--- '+identity+' / '+file+' ---\n'+await readFile(resolve(directory,file),'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  }
  for(const name of Object.keys(manifest.dependencies??{})){
    let current=directory,found=false;
    while(current!==parse(current).root){
      const candidate=resolve(current,'node_modules',name);
      try{await readFile(resolve(candidate,'package.json'));await dependencyNotices(candidate);found=true;break;}catch(error){if(error.code!=='ENOENT')throw error;}
      current=dirname(current);
    }
    if(!found)throw new Error('Missing installed dependency notice: '+name);
  }
}
await dependencyNotices(resolve(root,'node_modules/@internet-privacy/marmot-ts'));
await writeFile(resolve(output,'public/THIRD-PARTY-LICENSES.txt'),notices.join('\n\n'));

for(const file of ['package.json','package-lock.json'])await copyFile(file,resolve(output,file));
await copyFile('ops/Dockerfile.hosted',resolve(output,'Dockerfile'));
await copyFile('ops/compose.hosted.yml',resolve(output,'compose.yml'));
await writeFile(resolve(output,'.dockerignore'),'public/\n.env\nsecrets/\ndata/\nbackups/\n');
console.log('Hosted app and public assets built; no runtime data or secrets copied.');
