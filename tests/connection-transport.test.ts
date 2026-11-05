import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createConnectionTransport,isPublicConnectionAddress} from '../server/connection-transport.js';

test('hosted transport rejects private, mapped, reserved and unsafe HTTPS destinations',async()=>{
  const mod=await import('../server/connection-transport.js').catch(()=>({})) as any;
  assert.equal(typeof mod.validateConnectionUrl,'function','public HTTPS validation must exist');
  for(const url of ['http://example.com','https://localhost','https://127.0.0.1','https://10.1.2.3','https://100.64.0.1','https://192.0.2.1','https://[::1]','https://[::ffff:8.8.8.8]','https://[2001:db8::1]','https://[2002:0808:0808::1]','https://a.example:8443','https://u:p@a.example','https://a.example/#x','https://host.internal'])assert.throws(()=>mod.validateConnectionUrl(url),url);
  assert.equal(mod.validateConnectionUrl('https://api.example.com/a').origin,'https://api.example.com');
});

function fixture(config:{addresses?:{address:string;family:number}[];chunks?:Buffer[];status?:number;headers?:Record<string,string>;hangBody?:boolean;hangDns?:boolean;error?:boolean}={}){
  const calls:{url:URL;options:any;body?:Buffer}[]=[];let resolutions=0;
  const fetcher=createConnectionTransport({timeoutMs:30,lookup:(async()=>{resolutions++;if(config.hangDns)return new Promise(()=>{});return config.addresses??[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}];}) as any,
    request:((url:URL,options:any,callback:(response:any)=>void)=>{
      const req:any=new EventEmitter();req.destroy=()=>req;req.setTimeout=()=>req;
      const aborted=()=>req.emit('error',new Error('sensitive internal failure'));options.signal.addEventListener('abort',aborted,{once:true});
      req.end=(body?:Buffer)=>{calls.push({url,options,body});queueMicrotask(()=>{
        if(config.error){req.emit('error',new Error('secret-body'));return;}
        const response:any=new EventEmitter();response.statusCode=config.status??200;response.headers=config.headers??{'content-type':'application/json'};response.destroy=()=>response;
        callback(response);for(const chunk of config.chunks??[Buffer.from('{"ok":true}')])response.emit('data',chunk);
        if(!config.hangBody){options.signal.removeEventListener('abort',aborted);response.emit('end');}
      });};return req;
    }) as any});
  return {fetcher,calls,resolutions:()=>resolutions};
}
test('all DNS answers are checked before the socket and pinned into its lookup',async()=>{
  for(const addresses of [[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],[{address:'fd00::1',family:6}],[]]){
    const f=fixture({addresses});await assert.rejects(()=>f.fetcher('https://provider.example/api'));assert.equal(f.calls.length,0);
  }
  const f=fixture();await f.fetcher('https://provider.example/api');
  assert.equal(f.resolutions(),1);assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.agent,false);
  assert.equal(f.calls[0].url.hostname,'provider.example');
  const pinned=await new Promise((resolve,reject)=>f.calls[0].options.lookup('provider.example',{all:true},(error:any,addresses:any)=>error?reject(error):resolve(addresses)));
  assert.deepEqual(pinned,[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}]);assert.equal(f.resolutions(),1);
});
test('transport retains required authentication, method and exact body without cookies',async()=>{
  const f=fixture({headers:{'content-type':'application/json','set-cookie':'secret=bad'}});
  const response=await f.fetcher('https://provider.example/rpc',{method:'POST',headers:{Authorization:'Basic fictional','Content-Type':'application/json','Grpc-Metadata-macaroon':'ab'},body:'{"method":"getinfo"}'});
  assert.deepEqual(await response.json(),{ok:true});assert.equal(response.headers.has('set-cookie'),false);
  assert.equal(f.calls[0].options.method,'POST');assert.equal(f.calls[0].options.headers.authorization,'Basic fictional');assert.equal(f.calls[0].options.headers['grpc-metadata-macaroon'],'ab');assert.equal(f.calls[0].body?.toString(),'{"method":"getinfo"}');
  for(const headers of [{Cookie:'ambient=value'},{Host:'localhost'},{'Proxy-Authorization':'bad'}] as Record<string,string>[])await assert.rejects(()=>f.fetcher('https://provider.example',{headers}));
  assert.equal(f.calls.length,1);
});
test('transport denies redirects, oversized bodies, socket failures and unsupported methods',async()=>{
  for(const config of [{status:302,headers:{location:'https://127.0.0.1'}},{chunks:[Buffer.alloc(1024*1024+1)]},{headers:{'content-length':String(1024*1024+1)}},{error:true}] as Parameters<typeof fixture>[0][]){
    const f=fixture(config);await assert.rejects(()=>f.fetcher('https://provider.example'),error=>error instanceof Error&&!error.message.includes('secret-body'));assert.equal(f.calls.length,1);
  }
  const f=fixture();await assert.rejects(()=>f.fetcher('https://provider.example',{method:'POST',body:'x'.repeat(48*1024+1)}));
  await assert.rejects(()=>f.fetcher('https://provider.example',{headers:{Authorization:'Bearer '+('x'.repeat(48*1024))}}));
  await assert.rejects(()=>f.fetcher('https://provider.example',{method:'DELETE'}));assert.equal(f.calls.length,0);
});
test('deadline and caller abort cover unresolved DNS and stalled response bodies',async()=>{
  for(const config of [{hangDns:true},{hangBody:true}]){const f=fixture(config);await assert.rejects(()=>f.fetcher('https://provider.example'));}
  const f=fixture(),controller=new AbortController();controller.abort();await assert.rejects(()=>f.fetcher('https://provider.example',{signal:controller.signal}));assert.equal(f.calls.length,0);
});
test('expanded IPv6 and alternative IPv4 representations cannot bypass global address checks',()=>{
  for(const ip of ['::ffff:808:808','::ffff:8.8.8.8','2001:0000:1234::1','2001:db8::1','2002::1','3fff::1','ff02::1','fe80::1','192.88.99.1','198.19.1.1','240.1.1.1'])assert.equal(isPublicConnectionAddress(ip),false,ip);
  for(const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111','2001:4860:4860::8888'])assert.equal(isPublicConnectionAddress(ip),true,ip);
});
