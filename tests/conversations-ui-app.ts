import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
const server=await createServer({configFile:false,root:process.cwd(),plugins:[{
  name:'fictional-marmot-ui-fixture',enforce:'pre',
  resolveId(source,importer){if(source==='../marmot-engine'&&importer?.endsWith('/client/screens/Conversations.tsx'))return resolve('tests/fixtures/conversations-engine.ts');},
},react()],server:{host:'127.0.0.1',port:4338,strictPort:true},logLevel:'error'});
await server.listen();
process.on('SIGTERM',()=>void server.close());
process.on('SIGINT',()=>void server.close());
