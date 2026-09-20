import 'reflect-metadata';
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ExcelJS from 'exceljs';
import {createApp} from '../src/main.js';
import {Db} from '../src/db.js';
import {columns} from '../src/imports.js';
import {addDays,todayShanghai} from '../src/domain.js';
import {BackupsService} from '../src/backups.js';
import {OperationLogsService} from '../src/operation-logs.js';
import {beijingMonth} from '../src/time.js';

let app:Awaited<ReturnType<typeof createApp>>,db:Db,base:string,cookie:string,dataDir:string,backupDir:string;
const password='Desktop-Test-Password-123';let sequence=0;
const phone=()=>`1398${String(++sequence).padStart(7,'0')}`;
async function call(path:string,method='GET',body?:unknown,anonymous=false){
  const headers:Record<string,string>={origin:base,'x-gym-request':'1'};if(!anonymous&&cookie)headers.cookie=cookie;if(body&&!(body instanceof FormData))headers['content-type']='application/json';
  const res=await fetch(base+'/api'+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const data=res.headers.get('content-type')?.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer());return {status:res.status,data,res};
}
async function create(kind:'year'|'month'='month',days=kind==='month'?30:365){const start=todayShanghai(),r=await call('/admin/members','POST',{name:'测试会员',phone:phone(),kind,startDate:start,endDate:addDays(start,days),cardRemark:'',note:''});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function workbook(rows:any[][]){const w=new ExcelJS.Workbook(),s=w.addWorksheet('会员');s.addRow(columns);rows.forEach(row=>s.addRow(row));return Buffer.from(await w.xlsx.writeBuffer());}
async function preview(buffer:Buffer){const f=new FormData();f.append('file',new Blob([new Uint8Array(buffer)]),'members.xlsx');return call('/admin/imports/preview','POST',f);}

before(async()=>{
  process.env.NODE_ENV='test';process.env.DESKTOP_MODE='true';process.env.DB_DRIVER='pglite';process.env.PGLITE_PATH='memory://';process.env.STORAGE_DRIVER='local';process.env.DESKTOP_CONTROL_TOKEN='test-control-token';
  dataDir=await mkdtemp(join(tmpdir(),'joyfit-test-'));backupDir=join(dataDir,'backups');process.env.LOCAL_STORAGE_PATH=join(dataDir,'uploads');process.env.JOYFIT_BACKUP_PATH=backupDir;process.env.JOYFIT_OPERATION_LOG_PATH=join(dataDir,'logs');
  app=await createApp();await app.listen(0,'127.0.0.1');base=await app.getUrl();process.env.ADMIN_ORIGIN=base;db=app.get(Db);
});
after(async()=>{await app?.close();if(dataDir)await rm(dataDir,{recursive:true,force:true});});

test('First run requires setup and creates the local administrator',async()=>{
  assert.deepEqual((await call('/setup/status','GET',undefined,true)).data,{required:true});
  const setup=await call('/setup','POST',{name:'悦体健身',phone:'13800138000',monthCardDays:30,yearCardDays:365,password,backupDirectory:backupDir,senderEmail:'',recipientEmail:''},true);assert.equal(setup.status,201,JSON.stringify(setup.data));
  assert.deepEqual((await call('/setup/status','GET',undefined,true)).data,{required:false});
  assert.equal((await call('/setup','POST',{name:'重复',phone:'',monthCardDays:30,yearCardDays:365,password,backupDirectory:'',senderEmail:'',recipientEmail:''},true)).status,400);
  const login=await call('/admin/login','POST',{password},true);assert.equal(login.status,201);cookie=login.res.headers.get('set-cookie')!.split(';')[0];
});

test('Desktop API has no WeChat member or avatar routes',async()=>{
  for(const path of ['/wechat/login','/wechat/bind'])assert.equal((await call(path,'POST',{},true)).status,404);
  for(const path of ['/me','/me/avatar'])assert.equal((await call(path,'GET',undefined,true)).status,404);
});

test('Desktop writes accept loopback requests when WebView omits Origin',async()=>{
  const response=await fetch(base+'/api/admin/settings',{method:'PATCH',headers:{cookie,'x-gym-request':'1','content-type':'application/json'},body:JSON.stringify({name:'悦体健身',phone:'',monthCardDays:30,yearCardDays:365})});
  assert.equal(response.status,200,await response.text());
  const backup=await call('/admin/backup/settings','PATCH',{directory:backupDir,senderEmail:'backup@qq.com',recipientEmail:'',scheduleTime:'20:00',retentionCount:30});
  assert.equal(backup.status,200,JSON.stringify(backup.data));assert.equal(backup.data.recipientEmail,'backup@qq.com');
  await call('/admin/backup/settings','PATCH',{directory:backupDir,senderEmail:'',recipientEmail:'',scheduleTime:'20:00',retentionCount:30});
});

test('Configured card durations drive opening, renewal and history snapshots',async()=>{
  const settings=await call('/admin/settings','PATCH',{name:'悦体健身',phone:'13800138000',monthCardDays:45,yearCardDays:400});assert.equal(settings.status,200,JSON.stringify(settings.data));
  const start=todayShanghai();assert.equal((await call('/admin/members','POST',{name:'缺少备注',phone:phone(),kind:'month',startDate:start,endDate:addDays(start,30),cardRemark:'',note:''})).status,400);
  const member=await create('month',45),detail=(await call(`/admin/members/${member.id}`)).data;
  assert.match(member.card_number,new RegExp(`^Y${beijingMonth()}\\d{4}$`));
  assert.equal(detail.card.end_date,addDays(start,45));assert.equal(detail.cardHistory[0].duration_days,45);assert.equal(detail.avatar_key,undefined);assert.equal(detail.bound,undefined);
  const renewed=await call(`/admin/members/${member.id}/card/renew`,'POST',{kind:'month',startDate:start,endDate:addDays(detail.card.end_date,45),remark:'',version:detail.card.version});assert.equal(renewed.status,201,JSON.stringify(renewed.data));
  const after=(await call(`/admin/members/${member.id}`)).data;assert.equal(after.cardHistory[0].duration_days,45);
  await call('/admin/settings','PATCH',{name:'悦体健身',phone:'13800138000',monthCardDays:30,yearCardDays:365});
  assert.equal((await call(`/admin/members/${member.id}`)).data.card.end_date,addDays(addDays(start,45),45));
});

test('Excel template and validation use the current configured duration',async()=>{
  await call('/admin/settings','PATCH',{name:'悦体健身',phone:'',monthCardDays:35,yearCardDays:370});
  const template=await call('/admin/imports/template');assert.equal(template.status,200);const w=new ExcelJS.Workbook();await w.xlsx.load(template.data);const note=w.worksheets[0].getCell('A1').note as any;assert.match(typeof note==='string'?note:note?.texts?.map((x:any)=>x.text).join('')||'',/月卡 35 天/);
  const start='2026-01-01';const ok=await preview(await workbook([['导入会员',phone(),'月卡',start,addDays(start,35),'','']]));assert.equal(ok.data.status,'ready',JSON.stringify(ok.data));
  const bad=await preview(await workbook([['特殊期限',phone(),'月卡',start,addDays(start,30),'','']]));assert.equal(bad.data.status,'invalid');assert.ok(bad.data.errors.some((e:any)=>e.message.includes('35')));
});

test('Full Excel backup saves locally and restores members atomically',async()=>{
  const before=Number((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n),created=await call('/admin/backup/run','POST');assert.equal(created.status,201,JSON.stringify(created.data));
  const bytes=await readFile(created.data.job.filePath);const book=new ExcelJS.Workbook();await book.xlsx.load(bytes);for(const name of ['备份信息','门店设置','会员档案','当前会员卡','会员卡历史'])assert.ok(book.getWorksheet(name));assert.equal(book.getWorksheet('操作记录'),undefined);assert.equal(book.getWorksheet('备份信息')!.getCell('B2').value,'2');
  await create('year',370);assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n),before+1);
  const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)]),'backup.xlsx');const restored=await call('/admin/backup/restore','POST',form);assert.equal(restored.status,201,JSON.stringify(restored.data));
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n),before);
  const invalid=new FormData();invalid.append('file',new Blob(['broken']),'backup.xlsx');assert.equal((await call('/admin/backup/restore','POST',invalid)).status,400);assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n),before);
});

test('Automatic backups are unique per Beijing date and reuse the same job',async()=>{
  const backups=app.get(BackupsService),date=todayShanghai();const first=await backups.createLocal('automatic',date),second=await backups.createLocal('automatic',date);
  assert.equal(first.skipped,false);assert.equal(second.skipped,true);assert.equal(second.job.id,first.job.id);
  const count=Number((await db.query("SELECT count(*)::int AS n FROM backup_jobs WHERE trigger_source='automatic' AND scheduled_date=$1",[date])).rows[0].n);assert.equal(count,1);
});

test('Member numbers use a shared monthly sequence',async()=>{
  const first=await create('month',35),second=await create('month',35);assert.equal(first.card_number.slice(0,7),`Y${beijingMonth()}`);assert.equal(second.card_number.slice(0,7),first.card_number.slice(0,7));
  assert.equal(Number(second.card_number.slice(-4)),Number(first.card_number.slice(-4))+1);
});

test('Legacy v1 backups restore while ignoring their operation sheet',async()=>{
  const backups=app.get(BackupsService),legacy=await backups.workbook();legacy.getWorksheet('备份信息')!.getCell('B2').value='1';legacy.getWorksheet('会员档案')!.getCell('D1').value='会员卡号';
  const operations=legacy.addWorksheet('操作记录');operations.addRow(['ID','会员ID','操作','操作者','详情','操作时间']);operations.addRow(['fb3b160b-8591-4824-b558-455a62c77ffc','','legacy_action','owner','{}','2025-01-01T00:00:00.000Z']);
  const before=Number((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n);await backups.restore(Buffer.from(await legacy.xlsx.writeBuffer()));
  assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='legacy_action'")).rows[0].n),0);assert.ok(Number((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n)>=before);
  for(const row of (await db.query('SELECT card_number FROM members')).rows)assert.match(row.card_number,/^Y\d{10}$/);
});

test('Operation history flushes to monthly UTF-8 logs and is not exported',async()=>{
  await app.get(OperationLogsService).flush();const file=join(dataDir,'logs',`operations-${todayShanghai().slice(0,7)}.log`),content=await readFile(file,'utf8');
  assert.match(content,/管理员 \|/);assert.match(content,/新增会员|修改门店设置/);assert.doesNotMatch(content,/Desktop-Test-Password-123/);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE flushed_at IS NULL')).rows[0].n),0);
});

test('Statistics expose expired instead of WeChat binding counts',async()=>{const stats=(await call('/admin/stats')).data;assert.equal(typeof stats.expired,'number');assert.equal(stats.unbound,undefined);});
