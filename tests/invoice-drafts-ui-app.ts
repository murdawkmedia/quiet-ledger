import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
// Loopback fixture server on its own port. Any HTML navigation serves the
// saved-drafts fixture so the spec can load /invoices/new, /drafts and
// /drafts/:id directly, exactly like the real single-page app.
const fixture=resolve(process.cwd(),'tests/fixtures/invoice-drafts-ui.html');
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react(),{name:'saved-drafts-fixture-spa',configureServer(dev){dev.middlewares.use((req,_res,next)=>{const pathname=(req.url??'/').split('?')[0];if(req.method==='GET'&&(req.headers.accept??'').includes('text/html')&&!pathname.includes('.')&&pathname!==fixture.slice(process.cwd().length)){req.url=fixture.slice(process.cwd().length);}next();});}}],server:{host:'127.0.0.1',port:4365,strictPort:true},logLevel:'error'});
await server.listen();process.on('SIGTERM',()=>void server.close());process.on('SIGINT',()=>void server.close());
