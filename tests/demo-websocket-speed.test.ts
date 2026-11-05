import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {createDemoWebSocketNetwork} from '../client/demo-agent-engine.js';
test('one bounded WebSocket carries multiple queries and publishes without redialling',async()=>{const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));let connections=0;server.on('connection',socket=>{connections++;socket.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame[0]==='REQ')socket.send(JSON.stringify(['EOSE',frame[1]]));if(frame[0]==='EVENT')socket.send(JSON.stringify(['OK',frame[1].id,true,'']));});});const port=(server.address() as {port:number}).port,network=createDemoWebSocketNetwork(`ws://127.0.0.1:${port}/marmot`);try{await network.query([{kinds:[445]}]);await network.query([{kinds:[30443]}]);await network.publish({id:'a'.repeat(64)} as never);assert.equal(connections,1);}finally{network.close?.();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}});

test('live subscriptions deduplicate notifications and resume on reconnect',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
 let connections=0,watches=0,notifications=0;let first:import('ws').WebSocket|undefined;
 server.on('connection',socket=>{connections++;first??=socket;socket.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame[0]!=='REQ')return;if(frame[2]?.kinds?.[0]===445){watches++;const event={id:'b'.repeat(64)};socket.send(JSON.stringify(['EVENT',frame[1],event]));socket.send(JSON.stringify(['EVENT',frame[1],event]));}socket.send(JSON.stringify(['EOSE',frame[1]]));});});
 const network=createDemoWebSocketNetwork(`ws://127.0.0.1:${(server.address() as {port:number}).port}/marmot`);
 const wait=async(predicate:()=>boolean)=>{for(let i=0;i<100;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('Expected bounded WebSocket progress.');};
 try{const stop=network.watch!([{kinds:[445]}],()=>notifications++);await wait(()=>notifications===1);await network.query([{kinds:[30443]}]);assert.equal(connections,1);first!.close();await wait(()=>first!.readyState===3);await new Promise(resolve=>setTimeout(resolve,10));await network.query([{kinds:[30443]}]);await wait(()=>watches===2);assert.equal(connections,2);assert.equal(notifications,1,'duplicate initial events do not create repeated work');stop();}
 finally{network.close?.();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

test('transport rejects excess concurrent queries and closes pending work',async()=>{
 const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise<void>(resolve=>server.once('listening',resolve));
 const network=createDemoWebSocketNetwork(`ws://127.0.0.1:${(server.address() as {port:number}).port}/marmot`);const requests=Array.from({length:9},()=>network.query([{kinds:[30443]}]));const settled=Promise.allSettled(requests);
 try{await new Promise(resolve=>setTimeout(resolve,30));network.close?.();const outcomes=await settled;assert.equal(outcomes.filter(row=>row.status==='rejected').length,9);assert.ok(outcomes.some(row=>row.status==='rejected'&&String(row.reason).includes('busy')));}
 finally{network.close?.();for(const socket of server.clients)socket.terminate();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
