import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const server=await createServer({configFile:false,root:process.cwd(),plugins:[react()],server:{host:'127.0.0.1',port:4358,strictPort:true},logLevel:'error'});await server.listen();process.on('SIGTERM',()=>void server.close());process.on('SIGINT',()=>void server.close());
