import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

const root=resolve(import.meta.dirname,'..'),resources=resolve(root,process.argv[2]||'apps/desktop/src-tauri/resources');
const directory=await mkdtemp(join(tmpdir(),'joyfit-packaged-smoke-'));
const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=server.address().port;await new Promise(r=>server.close(r));
const base='http://127.0.0.1:'+port;
const child=spawn(resolve(resources,'runtime/node.exe'),[resolve(resources,'server/api/dist/main.js')],{cwd:directory,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,NODE_ENV:'production',DESKTOP_MODE:'true',DB_DRIVER:'pglite',PGLITE_PATH:join(directory,'database'),STORAGE_DRIVER:'local',LOCAL_STORAGE_PATH:join(directory,'uploads'),JOYFIT_BACKUP_PATH:join(directory,'backups'),JOYFIT_OPERATION_LOG_PATH:join(directory,'logs'),ADMIN_DIST_PATH:resolve(resources,'server/admin/dist'),ADMIN_ORIGIN:base,HOST:'127.0.0.1',PORT:String(port)}});
let output='',cookie='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
async function api(path,body){const response=await fetch(base+'/api'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-gym-request':'1',origin:base,cookie},body:body?JSON.stringify(body):undefined});const data=await response.json();assert.ok(response.ok,JSON.stringify(data));if(response.headers.has('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];return data;}
try{
  let ready=false;for(let i=0;i<60;i++){try{if((await fetch(base+'/api/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,500));}
  assert.ok(ready,output);assert.equal((await api('/setup/status')).required,true);
  await api('/setup',{name:'便携包隔离测试',phone:'',monthCardDays:30,yearCardDays:365,password:'123456',backupDirectory:join(directory,'backups'),senderEmail:'',recipientEmail:''});
  await api('/admin/login',{password:'123456'});
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const end=new Date(date+'T00:00:00Z');end.setUTCDate(end.getUTCDate()+30);
  const member=await api('/admin/members',{name:'打包验证',phone:'13911112222',kind:'month',startDate:date,endDate:end.toISOString().slice(0,10),note:'',cardRemark:''});
  await api('/admin/members/'+member.id+'/card/pause',{version:1,date,remark:'打包验证暂停'});
  const paused=await api('/admin/members/'+member.id);assert.equal(paused.card.status,'paused');
  await api('/admin/members/'+member.id+'/card/resume',{version:paused.card.version,date});
  const notifications=await api('/admin/notifications');assert.ok(Array.isArray(notifications.items));
  const backup=await api('/admin/backup/run',{});assert.ok(backup.job.filePath.endsWith('.zip'));
  const zip=await JSZip.loadAsync(await readFile(backup.job.filePath));assert.ok(zip.file('members.xlsx'));assert.ok(zip.file('state.json'));assert.ok(zip.file('manifest.json'));
  console.log('Packaged runtime passed: isolated setup/login, migration, membership, pause/resume, reminders and ZIP backup. No email sent.');
}finally{
  if(child.exitCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+'\\')||target.startsWith(resolve(tmpdir())+'/'));await rm(target,{recursive:true,force:true});
}
