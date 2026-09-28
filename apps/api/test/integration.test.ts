import 'reflect-metadata';
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import ExcelJS from 'exceljs';
import {unpack} from '../src/archive.js';
import {RemindersService} from '../src/reminders.js';
import sharp from 'sharp';
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
  assert.equal((await call('/setup','POST',{name:'悦体健身',phone:'13800138000',monthCardDays:30,yearCardDays:365,password:'1234567',backupDirectory:backupDir,senderEmail:'',recipientEmail:''},true)).status,400);
  assert.deepEqual((await call('/setup/status','GET',undefined,true)).data,{required:true});
  const setup=await call('/setup','POST',{name:'悦体健身',phone:'13800138000',monthCardDays:30,yearCardDays:365,password,backupDirectory:backupDir,senderEmail:'',recipientEmail:''},true);assert.equal(setup.status,201,JSON.stringify(setup.data));
  assert.deepEqual((await call('/setup/status','GET',undefined,true)).data,{required:false});
  assert.equal((await call('/setup','POST',{name:'重复',phone:'',monthCardDays:30,yearCardDays:365,password,backupDirectory:'',senderEmail:'',recipientEmail:''},true)).status,400);
  const login=await call('/admin/login','POST',{password},true);assert.equal(login.status,201);cookie=login.res.headers.get('set-cookie')!.split(';')[0];
});

test('Eight-digit numeric administrator passwords are accepted',async()=>{
  assert.equal((await call('/admin/password','POST',{current:password,next:'1234567'})).status,400);
  assert.equal((await call('/admin/password','POST',{current:password,next:'12345678'})).status,201);
  assert.equal((await call('/admin/login','POST',{password},true)).status,401);
  const numeric=await call('/admin/login','POST',{password:'12345678'},true);assert.equal(numeric.status,201);cookie=numeric.res.headers.get('set-cookie')!.split(';')[0];
  assert.equal((await call('/admin/password','POST',{current:'12345678',next:password})).status,201);
  const restored=await call('/admin/login','POST',{password},true);assert.equal(restored.status,201);cookie=restored.res.headers.get('set-cookie')!.split(';')[0];
});

test('Desktop API has no WeChat member or avatar routes',async()=>{
  for(const path of ['/wechat/login','/wechat/bind'])assert.equal((await call(path,'POST',{},true)).status,404);
  for(const path of ['/me','/me/avatar'])assert.equal((await call(path,'GET',undefined,true)).status,404);
});

test('Desktop writes accept loopback requests when WebView omits Origin',async()=>{
  const response=await fetch(base+'/api/admin/settings',{method:'PATCH',headers:{cookie,'x-gym-request':'1','content-type':'application/json'},body:JSON.stringify({name:'悦体健身',phone:'',monthCardDays:30,yearCardDays:365})});
  assert.equal(response.status,200,await response.text());
  const defaults=await call('/admin/backup/settings');assert.equal(defaults.status,200);assert.equal(defaults.data.scheduleTime,'13:00');
  const backup=await call('/admin/backup/settings','PATCH',{directory:backupDir,senderEmail:'backup@qq.com',recipientEmail:'',scheduleTime:'17:30',retentionCount:30});
  assert.equal(backup.status,200,JSON.stringify(backup.data));assert.equal(backup.data.recipientEmail,'backup@qq.com');
  assert.equal(backup.data.scheduleTime,'17:30');
  await call('/admin/backup/settings','PATCH',{directory:backupDir,senderEmail:'',recipientEmail:'',scheduleTime:'13:00',retentionCount:30});
});

test('Configured card durations drive opening, renewal and history snapshots',async()=>{
  const settings=await call('/admin/settings','PATCH',{name:'悦体健身',phone:'13800138000',monthCardDays:45,yearCardDays:400});assert.equal(settings.status,200,JSON.stringify(settings.data));
  const start=todayShanghai();assert.equal((await call('/admin/members','POST',{name:'缺少备注',phone:phone(),kind:'month',startDate:start,endDate:addDays(start,30),cardRemark:'',note:''})).status,400);
  const member=await create('month',45),detail=(await call(`/admin/members/${member.id}`)).data;
  assert.match(member.card_number,new RegExp(`^Y${beijingMonth()}\\d{4}$`));
  assert.equal(detail.card.end_date,addDays(start,45));assert.equal(detail.cardHistory[0].duration_days,45);assert.equal(detail.avatar_key,null);assert.equal(detail.bound,undefined);
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
  const bytes=await readFile(created.data.job.filePath);const book=new ExcelJS.Workbook();await book.xlsx.load((await unpack(bytes))!.get('members.xlsx')! as any);for(const name of ['备份信息','门店设置','会员档案','当前会员卡','会员卡历史'])assert.ok(book.getWorksheet(name));assert.equal(book.getWorksheet('操作记录'),undefined);assert.equal(book.getWorksheet('备份信息')!.getCell('B2').value,'4');
  await create('year',370);assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n),before+1);
  const form=new FormData();form.append('file',new Blob([new Uint8Array(bytes)]),'backup.zip');const restored=await call('/admin/backup/restore','POST',form);assert.equal(restored.status,201,JSON.stringify(restored.data));
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
  const backups=app.get(BackupsService),legacy=await backups.workbook();legacy.getWorksheet('备份信息')!.getCell('B2').value='1';legacy.getWorksheet('会员档案')!.getCell('D1').value='会员卡号';const legacyCards=legacy.getWorksheet('当前会员卡')!;legacyCards.getCell('F1').value='是否作废';legacyCards.getCell('G1').value='作废时间';legacyCards.getCell('H1').value='作废原因';legacyCards.spliceColumns(12,4);
  const operations=legacy.addWorksheet('操作记录');operations.addRow(['ID','会员ID','操作','操作者','详情','操作时间']);operations.addRow(['fb3b160b-8591-4824-b558-455a62c77ffc','','legacy_action','owner','{}','2025-01-01T00:00:00.000Z']);
  const before=Number((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n);await backups.restore(Buffer.from(await legacy.xlsx.writeBuffer()));
  assert.equal(Number((await db.query("SELECT count(*)::int AS n FROM audit_logs WHERE action='legacy_action'")).rows[0].n),0);assert.ok(Number((await db.query('SELECT count(*)::int AS n FROM audit_logs')).rows[0].n)>=before);
  for(const row of (await db.query('SELECT card_number FROM members')).rows)assert.match(row.card_number,/^Y\d{10}$/);
});

test('Legacy v2 backup keeps original member numbers and dates',async()=>{
  const backups=app.get(BackupsService),book=await backups.workbook();book.getWorksheet('备份信息')!.getCell('B2').value='2';
  const cards=book.getWorksheet('当前会员卡')!;cards.getCell('F1').value='是否作废';cards.getCell('G1').value='作废时间';cards.getCell('H1').value='作废原因';cards.spliceColumns(12,4);
  const before=(await db.query('SELECT id,phone,card_number FROM members ORDER BY id')).rows;
  await backups.restore(Buffer.from(await book.xlsx.writeBuffer()));
  assert.deepEqual((await db.query('SELECT id,phone,card_number FROM members ORDER BY id')).rows,before);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM memberships WHERE paused_on IS NOT NULL OR returned_at IS NOT NULL OR pause_count<>0')).rows[0].n,0);
});

test('Operation history flushes to monthly UTF-8 logs and is not exported',async()=>{
  await app.get(OperationLogsService).flush();const file=join(dataDir,'logs',`operations-${todayShanghai().slice(0,7)}.log`),content=await readFile(file,'utf8');
  assert.match(content,/管理员 \|/);assert.match(content,/新增会员|修改门店设置/);assert.doesNotMatch(content,/Desktop-Test-Password-123/);
  assert.equal(Number((await db.query('SELECT count(*)::int AS n FROM audit_logs WHERE flushed_at IS NULL')).rows[0].n),0);
});

test('Statistics expose expired instead of WeChat binding counts',async()=>{const stats=(await call('/admin/stats')).data;assert.equal(typeof stats.expired,'number');assert.equal(stats.unbound,undefined);});

test('Report endpoints return consistent monthly data and valid PDF documents',async()=>{
  const month=todayShanghai().slice(0,7),json=await call(`/admin/reports/monthly?month=${month}`);assert.equal(json.status,200,JSON.stringify(json.data));assert.equal(json.data.month,month);assert.equal(typeof json.data.current.total,'number');assert.ok(Array.isArray(json.data.trend));assert.equal(json.data.trend.length,12);
  for(const path of ['/admin/reports/members.pdf',`/admin/reports/monthly.pdf?month=${month}`]){const pdf=await call(path);assert.equal(pdf.status,200);assert.equal(pdf.res.headers.get('content-type'),'application/pdf');assert.equal(pdf.data.subarray(0,5).toString(),'%PDF-');}
  assert.equal((await call('/admin/reports/monthly?month=invalid')).status,400);
});

test('Pause requires a note; concurrent requests only count once and resume extends the same card',async()=>{
  const today=todayShanghai();
  const r=await call('/admin/members','POST',{name:'暂停测试',phone:phone(),kind:'month',startDate:addDays(today,-60),endDate:today,cardRemark:'测试历史期限',note:''});assert.equal(r.status,201);
  const id=r.data.id,path=`/admin/members/${id}/card`,before=(await call(`/admin/members/${id}`)).data;
  assert.equal((await call(path+'/pause','POST',{remark:'   ',version:before.card.version})).status,400);
  const requests=await Promise.all([1,2].map(()=>call(path+'/pause','POST',{remark:'  出差暂停  ',date:addDays(today,-30),version:before.card.version})));
  assert.deepEqual(requests.map(r=>r.status).sort(),[201,409]);
  let card=(await call(`/admin/members/${id}`)).data.card;assert.equal(card.pause_count,1);assert.equal(card.status,'paused');
  assert.equal((await call(`/admin/members/${id}`)).data.cardHistory[0].remark,'出差暂停');
  assert.equal((await call('/admin/members?status=paused')).data.items.some((m:any)=>m.id===id),true);
  assert.equal((await call('/admin/members?expiring=true')).data.items.some((m:any)=>m.id===id),false);
  assert.equal((await call(path+'/renew','POST',{kind:'month',startDate:card.start_date,endDate:addDays(card.end_date,35),remark:'',version:card.version})).status,409);
  assert.equal((await call(path,'PATCH',{kind:'month',startDate:card.start_date,endDate:card.end_date,remark:'',version:card.version})).status,409);

  const resumed=await Promise.all([1,2].map(()=>call(path+'/resume','POST',{version:card.version,asOf:today})));
  assert.deepEqual(resumed.map(r=>r.status).sort(),[201,409]);
  card=(await call(`/admin/members/${id}`)).data.card;assert.equal(card.id,before.card.id);assert.equal(card.start_date,before.card.start_date);assert.equal(card.end_date,addDays(before.card.end_date,30));assert.equal(card.total_paused_days,30);
  assert.equal((await call(path+'/pause','POST',{remark:'第二次暂停',version:card.version})).status,201);
  card=(await call(`/admin/members/${id}`)).data.card;assert.equal(card.pause_count,2);
  assert.equal((await call(path+'/resume','POST',{version:card.version,asOf:addDays(today,-1)})).status,409);
  assert.equal((await call(path+'/resume','POST',{version:card.version,asOf:today})).status,201);
  const final=(await call(`/admin/members/${id}`)).data;assert.equal(final.card.end_date,card.end_date);assert.equal(final.card.total_paused_days,30);assert.equal(final.cardHistory.filter((e:any)=>e.event_type==='paused').length,2);assert.equal(final.cardHistory.filter((e:any)=>e.event_type==='resumed').length,2);
});

test('Only active cards can pause; return records server-calculated refund and guards repeated submission',async()=>{
  const today=todayShanghai(),r=await call('/admin/members','POST',{name:'退卡测试',phone:phone(),kind:'month',startDate:addDays(today,-13),endDate:addDays(today,22),cardRemark:'',note:''});assert.equal(r.status,201);
  const id=r.data.id,path=`/admin/members/${id}/card`,before=(await call(`/admin/members/${id}`)).data;
  const quote=(await call(path+'/return-estimate')).data;assert.equal(quote.usedDays,13);assert.equal(quote.estimatedRefund,57);
  assert.equal((await call(path+'/return','POST',{reason:'  ',version:quote.version,asOf:today})).status,400);
  assert.equal((await call(path+'/return','POST',{reason:'退卡',version:quote.version,asOf:addDays(today,-1)})).status,409);
  const result=await call(path+'/return','POST',{reason:'  已核实退款约定  ',version:quote.version,asOf:today});assert.equal(result.status,201);assert.equal(result.data.refund.estimatedRefund,57);
  assert.equal((await call(path+'/return','POST',{reason:'重复',version:quote.version,asOf:today})).status,409);
  let detail=(await call(`/admin/members/${id}`)).data;assert.equal(detail.card.status,'returned');assert.equal(detail.card.end_date,before.card.end_date);assert.equal(detail.cardHistory[0].detail.refund.estimatedRefund,57);assert.equal(detail.cardHistory[0].remark,'已核实退款约定');
  assert.equal((await call(path+'/pause','POST',{remark:'不允许',version:detail.card.version})).status,409);
  assert.equal((await call('/admin/members?status=returned')).data.items.some((m:any)=>m.id===id),true);
  await call(path+'/renew','POST',{kind:'month',startDate:today,endDate:addDays(today,35),remark:'',version:detail.card.version});detail=(await call(`/admin/members/${id}`)).data;assert.equal(detail.card.status,'active');assert.equal(detail.card.returned_at,null);assert.equal(detail.cardHistory.some((e:any)=>e.event_type==='returned'),true);
  for(const offset of [-80,1]){
    const m=await call('/admin/members','POST',{name:'不可暂停',phone:phone(),kind:'month',startDate:addDays(today,offset),endDate:addDays(today,offset+35),cardRemark:'',note:''});assert.equal(m.status,201);
    assert.equal((await call(`/admin/members/${m.data.id}/card/pause`,'POST',{remark:'测试',version:1})).status,400);
  }
});

test('Return estimate keeps opening and renewal purchases as FIFO refund segments',async()=>{
  const today=todayShanghai(),start=addDays(today,-30),annualEnd=addDays(start,395);
  const made=await call('/admin/members','POST',{name:'分段退款',phone:phone(),kind:'year',startDate:start,endDate:annualEnd,cardRemark:'年卡赠送30天',note:''});assert.equal(made.status,201);
  const path=`/admin/members/${made.data.id}/card`,card=(await call(`/admin/members/${made.data.id}`)).data.card;
  const renewed=await call(path+'/renew','POST',{kind:'month',startDate:start,endDate:addDays(annualEnd,30),remark:'按30天续月卡',version:card.version});assert.equal(renewed.status,201,JSON.stringify(renewed.data));
  const quote=(await call(path+'/return-estimate')).data;
  assert.equal(quote.segments.length,2);assert.deepEqual(quote.segments.map((s:any)=>s.kind),['year','month']);
  assert.equal(quote.segments[0].giftDays,30);assert.equal(quote.segments[0].usedPaidDays,30);assert.equal(quote.segments[1].usedPaidDays,0);assert.equal(quote.segments[1].rawRefund,99);
  assert.equal(quote.estimatedRefund,Math.ceil((365-30)*499/365+99));
});

test('v3 backup restores pending pauses, counts, return snapshots and original member numbers',async()=>{
  const first=await create('month',35),path=`/admin/members/${first.id}/card`;
  await call(path+'/pause','POST',{version:1,remark:'等待恢复'});
  const second=await create('year',370),quote=(await call(`/admin/members/${second.id}/card/return-estimate`)).data;
  await call(`/admin/members/${second.id}/card/return`,'POST',{version:quote.version,asOf:quote.asOf,reason:'测试退卡'});
  const expected=(await call(`/admin/members/${first.id}`)).data,returned=(await call(`/admin/members/${second.id}`)).data;
  const backups=app.get(BackupsService),buffer=await backups.exportPackage();
  const bad=await backups.workbook();bad.getWorksheet('当前会员卡')!.getCell('M2').value='-1';
  await assert.rejects(backups.restore(Buffer.from(await bad.xlsx.writeBuffer())),/暂停次数/);
  assert.deepEqual((await call(`/admin/members/${first.id}`)).data,expected);
  await call(path+'/resume','POST',{version:expected.card.version,asOf:todayShanghai()});
  await backups.restore(buffer);
  assert.deepEqual((await call(`/admin/members/${first.id}`)).data,expected);assert.deepEqual((await call(`/admin/members/${second.id}`)).data,returned);
  assert.equal((await call(path+'/resume','POST',{version:expected.card.version,asOf:todayShanghai()})).status,201);
  const jobs=await Promise.all([backups.createLocal('manual'),backups.createLocal('manual')]);assert.notEqual(jobs[0].job.filePath,jobs[1].job.filePath);
});


test('Editable effective dates deduct completed and open pause periods from refunds',async()=>{
  const today=todayShanghai(),start=addDays(today,-75);
  const made=await call('/admin/members','POST',{name:'实际45天',phone:phone(),kind:'year',startDate:start,endDate:addDays(start,370),cardRemark:'',note:''});assert.equal(made.status,201);
  const id=made.data.id,path='/admin/members/'+id+'/card';
  let c=(await call('/admin/members/'+id)).data.card;
  const paused=await call(path+'/pause','POST',{date:addDays(start,30),version:c.version,remark:'出差'});assert.equal(paused.status,201,JSON.stringify(paused.data));
  c=paused.data;const resumed=await call(path+'/resume','POST',{date:addDays(start,60),version:c.version});assert.equal(resumed.status,201);assert.equal(resumed.data.end_date,addDays(start,400));
  let quote=(await call(path+'/return-estimate')).data;assert.equal(quote.elapsedDays,75);assert.equal(quote.pausedDays,30);assert.equal(quote.usedDays,45);assert.equal(quote.estimatedRefund,438);
  assert.equal((await call(path+'/pause','POST',{date:addDays(start,50),version:resumed.data.version,remark:'重复区间'})).status,409);
  const second=await call(path+'/pause','POST',{date:addDays(today,-5),version:resumed.data.version,remark:'第二次'});assert.equal(second.status,201);
  quote=(await call(path+'/return-estimate')).data;assert.equal(quote.pausedDays,35);assert.equal(quote.usedDays,40);
  assert.equal((await call(path+'/return','POST',{version:quote.version,asOf:today,reason:'退卡'})).status,201);
  c=(await call('/admin/members/'+id)).data.card;
  const renewed=await call(path+'/renew','POST',{version:c.version,kind:'year',startDate:today,endDate:addDays(today,370),remark:''});assert.equal(renewed.status,201);
  quote=(await call(path+'/return-estimate')).data;assert.equal(quote.pausedDays,0);assert.equal(quote.usedDays,0);assert.equal(quote.segments.length,1);assert.equal(quote.segments[0].grantedDays,370);
});

test('Future pause and resume can be edited, cancelled and executed once after downtime',async()=>{
  const today=todayShanghai(),member=await create('year',370),path='/admin/members/'+member.id;
  const pause=await call(path+'/card/pause','POST',{date:addDays(today,1),remark:'未来出差',version:1});assert.equal(pause.data.scheduled,true);
  const resume=await call(path+'/card/resume','POST',{date:addDays(today,31),version:1});assert.equal(resume.data.scheduled,true);
  assert.equal((await call(path+'/card/return-estimate')).status,409);
  assert.equal((await call(path+'/appointments/'+pause.data.id,'POST',{date:addDays(today,2),remark:'改到后天'})).status,201);
  assert.equal((await call(path+'/appointments/'+pause.data.id,'POST',{cancel:true})).status,201);
  assert.equal((await call(path)).data.appointments.length,0);assert.equal((await call(path)).data.card.pause_count,0);
  const p=await call(path+'/card/pause','POST',{date:addDays(today,1),remark:'测试补执行',version:1});
  const r=await call(path+'/card/resume','POST',{date:addDays(today,2),version:1});
  // Simulate a machine starting after both effective dates without changing its clock.
  await db.query('UPDATE memberships SET start_date=$2 WHERE member_id=$1',[member.id,addDays(today,-60)]);
  await db.query('UPDATE card_appointments SET effective_date=$2 WHERE id=$1',[p.data.id,addDays(today,-30)]);
  await db.query('UPDATE card_appointments SET effective_date=$2 WHERE id=$1',[r.data.id,today]);
  await app.get(RemindersService).check();await app.get(RemindersService).check();
  const detail=(await call(path)).data;assert.equal(detail.card.pause_count,1);assert.equal(detail.card.total_paused_days,30);assert.equal(detail.card.end_date,addDays(today,400));
  assert.equal((await db.query("SELECT count(*)::int AS n FROM notifications WHERE member_id=$1 AND kind IN ('pause','resume')",[member.id])).rows[0].n,2);
  const reminders=(await call('/admin/notifications')).data;const reminder=reminders.items.find((n:any)=>n.member_id===member.id&&n.kind==='resume');assert.ok(reminder);
  await call('/admin/notifications/read','POST',{id:reminder.id});assert.ok((await call('/admin/notifications')).data.items.find((n:any)=>n.id===reminder.id).read_at);
});

test('Avatars and scheduled state round-trip in ZIP; tampered files do not change current data',async()=>{
  const member=await create('month',35),path='/admin/members/'+member.id;
  const bytes=await sharp({create:{width:640,height:480,channels:3,background:'#015556'}}).png().toBuffer();
  const imageForm=new FormData();imageForm.append('file',new Blob([new Uint8Array(bytes)],{type:'image/png'}),'photo.png');
  assert.equal((await call(path+'/avatar?version=1&source=hikvision','POST',imageForm)).status,201);
  const photo=await call(path+'/avatar');assert.equal(photo.status,200);const metadata=await sharp(photo.data).metadata();assert.equal(metadata.width,256);assert.equal(metadata.height,256);
  assert.equal((await call(path+'/avatar','GET',undefined,true)).status,401);
  const invalid=new FormData();invalid.append('file',new Blob(['broken']),'photo.png');assert.equal((await call(path+'/avatar?version=2','POST',invalid)).status,400);assert.deepEqual((await call(path+'/avatar')).data,photo.data);
  assert.equal((await call(path+'/avatar?version=1','POST',imageForm)).status,409);
  assert.equal((await call(path+'/avatar/remove','POST',{version:1})).status,409);
  assert.equal((await call(path+'/avatar','POST',imageForm)).status,400);
  assert.deepEqual((await call(path+'/avatar')).data,photo.data);
  const audit=(await db.query("SELECT detail FROM audit_logs WHERE member_id=$1 AND action='avatar_updated'",[member.id])).rows;
  assert.equal(audit.length,1);assert.equal(audit[0].detail.source,'hikvision');
  const booking=await call(path+'/card/pause','POST',{version:1,date:addDays(todayShanghai(),1),remark:'带照片备份'});assert.equal(booking.status,201);
  await app.get(RemindersService).check();const backups=app.get(BackupsService),zip=await backups.exportPackage();const files=(await unpack(zip))!;assert.ok(files.has('avatars/'+member.id+'.jpg'));
  const {pack}=await import('../src/archive.js');const invalidState=JSON.parse(files.get('state.json')!.toString());invalidState.pause_intervals.push({id:'invalid'});files.set('state.json',Buffer.from(JSON.stringify(invalidState)));
  const before=(await call(path)).data;await assert.rejects(backups.restore(await pack(files)));assert.deepEqual((await call(path)).data,before);
  assert.equal((await call(path+'/avatar/remove','POST',{version:(await call(path)).data.version})).status,201);await call(path+'/appointments/'+booking.data.id,'POST',{cancel:true});
  await backups.restore(zip);const after=(await call(path)).data;assert.ok(after.avatar_key);assert.equal(after.appointments[0].id,booking.data.id);assert.equal((await call(path+'/avatar')).status,200);
});


test('Date reminders respect expiry boundaries, pause suppression, read state and changed dates',async()=>{
  const today=todayShanghai(),service=app.get(RemindersService);
  const fixtures=[];
  for(const [kind,end]of [['year',30],['year',31],['month',7],['month',8],['month',0],['month',-1]] as const){
    const r=await call('/admin/members','POST',{name:'提醒边界',phone:phone(),kind,startDate:addDays(today,-10),endDate:addDays(today,end),cardRemark:'提醒测试期限',note:''});assert.equal(r.status,201);fixtures.push(r.data.id);
  }
  await service.check();let items=(await service.list()).items;
  for(const [index,wanted]of [true,false,true,false,true,false].entries())assert.equal(items.some((n:any)=>n.member_id===fixtures[index]&&n.kind==='expiring'&&!n.obsolete),wanted);
  assert.ok(items.some((n:any)=>n.member_id===fixtures[5]&&n.kind==='expired'));
  const notice=items.find((n:any)=>n.member_id===fixtures[0]&&n.kind==='expiring');await service.read(notice.id);await service.check();assert.ok((await service.list()).items.find((n:any)=>n.id===notice.id).read_at);
  await call('/admin/members/'+fixtures[0]+'/card/pause','POST',{version:1,remark:'提醒暂停'});await service.check();assert.ok((await service.list()).items.find((n:any)=>n.id===notice.id).obsolete);
  const future=await call('/admin/members','POST',{name:'待生效提醒',phone:phone(),kind:'month',startDate:addDays(today,1),endDate:addDays(today,36),cardRemark:'',note:''});assert.equal(future.status,201);
  await service.check();assert.equal((await service.list()).items.some((n:any)=>n.member_id===future.data.id),false);
  await db.query('UPDATE memberships SET start_date=$2 WHERE member_id=$1',[future.data.id,today]);await service.check();assert.ok((await service.list()).items.some((n:any)=>n.member_id===future.data.id&&n.kind==='started'));
});

test('Backdated resume may leave a card expired; same-day periods add zero days',async()=>{
  const today=todayShanghai(),r=await call('/admin/members','POST',{name:'历史恢复',phone:phone(),kind:'month',startDate:addDays(today,-200),endDate:addDays(today,-100),cardRemark:'旧卡测试',note:''});assert.equal(r.status,201);
  const path='/admin/members/'+r.data.id+'/card',p=await call(path+'/pause','POST',{version:1,date:addDays(today,-170),remark:'补录暂停'});assert.equal(p.status,201);
  const resumed=await call(path+'/resume','POST',{version:p.data.version,date:addDays(today,-140)});assert.equal(resumed.status,201);assert.equal(resumed.data.status,'expired');assert.equal(resumed.data.end_date,addDays(today,-70));
});
