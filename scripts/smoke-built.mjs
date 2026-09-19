import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {once} from 'node:events';
const child=spawn(process.execPath,['dist/main.js'],{
  cwd:resolve(import.meta.dirname,'../apps/api'),stdio:['ignore','ignore','pipe'],
  env:{...process.env,NODE_ENV:'development',DB_DRIVER:'pglite',PGLITE_PATH:'memory://',HOST:'127.0.0.1',PORT:'3002',ADMIN_INITIAL_PASSWORD:randomBytes(24).toString('base64url')}
});
let error='';child.stderr.on('data',chunk=>{error+=String(chunk);});
try{
  let healthy=false;
  for(let i=0;i<40;i++){
    if(child.exitCode!==null)throw new Error('Compiled API exited unexpectedly: '+error);
    try{const r=await fetch('http://127.0.0.1:3002/api/health',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok){healthy=true;break;}}catch{}
    await delay(300);
  }
  if(!healthy)throw new Error('Compiled API did not become healthy');
  console.log('Compiled API smoke check passed with an isolated in-memory database.');
}finally{
  if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}
}
