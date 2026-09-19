import 'reflect-metadata';
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import ExcelJS from 'exceljs';
import sharp from 'sharp';
import {createApp} from '../src/main.js';
import {Db} from '../src/db.js';
import {WechatService} from '../src/wechat.js';
import {AuthService} from '../src/auth.js';
import {columns} from '../src/imports.js';
import {addDays,statusOf,todayShanghai} from '../src/domain.js';
let app:Awaited<ReturnType<typeof createApp>>,db:Db,base:string,cookie:string,storageDir:string;
const originalPassword='TestOnly-Long-Password-123';
let index=0;
const nextPhone=()=>`1399${String(++index).padStart(7,'0')}`;
async function call(path:string,method='GET',body?:unknown,token?:string,options:{anonymous?:boolean;origin?:string}={}){
  const headers:Record<string,string>={'origin':options.origin||base,'x-gym-request':'1'};
  if(token)headers.authorization=`Bearer ${token}`;else if(!options.anonymous&&cookie)headers.cookie=cookie;
  if(body && !(body instanceof FormData))headers['content-type']='application/json';
  const res=await fetch(base+'/api'+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
  const data=res.headers.get('content-type')?.includes('application/json')?await res.json():Buffer.from(await res.arrayBuffer());return {status:res.status,data,res};
}
async function create(phone=nextPhone(),kind:'year'|'month'='year',startDate=todayShanghai(),endDate=addDays(startDate,kind==='year'?365:30),cardRemark?:string){
  const expected=addDays(startDate,kind==='year'?365:30);
  const r=await call('/admin/members','POST',{name:'测试会员',phone,kind,startDate,endDate,cardRemark:cardRemark??(endDate===expected?'':'测试特殊期限'),note:'不向会员披露的内部备注'});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
async function wxSession(openid:string){return (await call('/wechat/login','POST',{code:openid})).data.token as string;}
async function bind(member:any,openid:string){const token=await wxSession(openid);const r=await call('/wechat/bind','POST',{phoneCode:member.phone},token);assert.equal(r.status,201,JSON.stringify(r.data));return token;}
async function workbook(rows:any[][]){const w=new ExcelJS.Workbook(),s=w.addWorksheet('会员');s.addRow(columns);rows.forEach(r=>s.addRow(r));return Buffer.from(await w.xlsx.writeBuffer());}
async function preview(buffer:Buffer){const f=new FormData();f.append('file',new Blob([new Uint8Array(buffer)]),'members.xlsx');return call('/admin/imports/preview','POST',f);}
before(async()=>{
  process.env.NODE_ENV='test';process.env.DB_DRIVER='pglite';process.env.PGLITE_PATH='memory://';process.env.STORAGE_DRIVER='local';process.env.ADMIN_INITIAL_PASSWORD=originalPassword;
  storageDir=await mkdtemp(join(tmpdir(),'gym-test-'));process.env.LOCAL_STORAGE_PATH=storageDir;
  app=await createApp();await app.listen(0,'127.0.0.1');base=await app.getUrl();process.env.ADMIN_ORIGIN=base;db=app.get(Db);
  // Test-only service substitution. Production has no mock login or phone bypass.
  app.get(WechatService).login=async code=>code;app.get(WechatService).phone=async code=>code;
  const r=await call('/admin/login','POST',{password:originalPassword});assert.equal(r.status,201,JSON.stringify(r.data));cookie=r.res.headers.get('set-cookie')!.split(';')[0];
});
after(async()=>{await app?.close();if(storageDir)await rm(storageDir,{recursive:true,force:true});});
test('Admin endpoints require auth and reject cross-origin writes',async()=>{
  assert.equal((await call('/admin/members','GET',undefined,undefined,{anonymous:true})).status,401);
  assert.equal((await call('/admin/members','POST',{},undefined,{origin:'https://foreign.example'})).status,403);
  const me=await db.query('SELECT password_hash FROM administrators');assert.ok(me.rows[0].password_hash.startsWith('scrypt:'));assert.notEqual(me.rows[0].password_hash,originalPassword);
});
test('JOYFIT is the default store brand and its bundled logo is always available',async()=>{
  const store=await call('/store');assert.equal(store.status,200);assert.deepEqual(store.data,{name:'悦体健身',phone:'',hasLogo:true});
  const logo=await call('/store/logo');assert.equal(logo.status,200);assert.match(logo.res.headers.get('content-type')||'',/^image\/png/);
  const info=await sharp(logo.data).metadata();assert.equal(info.width,341);assert.equal(info.height,125);
});
test('Create member, uniqueness, update conflict and strict field permissions',async()=>{
  const member=await create();assert.ok(member.card_number.startsWith('GYM'));
  const detail=(await call(`/admin/members/${member.id}`)).data;
  assert.equal(detail.card.start_date,todayShanghai());assert.equal(detail.card.end_date,addDays(todayShanghai(),365));
  assert.equal(detail.card.status,statusOf({start_date:todayShanghai(),end_date:addDays(todayShanghai(),365),voided_at:null}));
  assert.equal(detail.cardHistory.length,1);assert.equal(detail.cardHistory[0].event_type,'opened');assert.equal(detail.cardHistory[0].remark,'');assert.equal(detail.logs,undefined);
  const r=await call('/admin/members','POST',{name:'重复',phone:member.phone,kind:'month',startDate:todayShanghai(),endDate:addDays(todayShanghai(),30)});assert.equal(r.status,409);
  const changedPhone=nextPhone(),changed=await call(`/admin/members/${member.id}`,'PATCH',{name:'新姓名',phone:changedPhone,note:'新备注',version:1});assert.equal(changed.status,200);assert.equal(changed.data.card_number,member.card_number);
  const afterChange=(await call(`/admin/members/${member.id}`)).data;assert.equal(afterChange.phone,changedPhone);assert.equal(afterChange.card_number,member.card_number);
  const stale=await call(`/admin/members/${member.id}`,'PATCH',{name:'旧页面',phone:member.phone,note:'',version:1});assert.equal(stale.status,409);
  assert.equal((await call('/admin/members','POST',{name:'X',phone:nextPhone(),kind:'year',startDate:'2026-01-01',endDate:'2026-12-31',openid:'fake'})).status,400);
  assert.equal((await call('/admin/members','POST',{name:'X',phone:nextPhone(),kind:'year',startDate:'2026-01-01',endDate:'2026-12-31',cardNumber:'OLD-001'})).status,400);
});
test('Card remarks are required only when the handled term differs from 30 or 365 days',async()=>{
  const historic=await call('/admin/members','POST',{name:'历史会员',phone:nextPhone(),kind:'year',startDate:'2024-02-29',endDate:'2025-02-28',cardRemark:'',note:''});
  assert.equal(historic.status,201,JSON.stringify(historic.data));
  const manual={name:'特殊期限',kind:'month',startDate:'2026-03-01',endDate:'2026-04-01',note:''};
  assert.equal((await call('/admin/members','POST',{...manual,phone:nextPhone()})).status,400);
  assert.equal((await call('/admin/members','POST',{...manual,phone:nextPhone(),cardRemark:'   '})).status,400);
  assert.equal((await call('/admin/members','POST',{...manual,phone:nextPhone(),cardRemark:'x'.repeat(501)})).status,400);
  const accepted=await call('/admin/members','POST',{...manual,phone:nextPhone(),cardRemark:'  赠送一天  '});
  assert.equal(accepted.status,201,JSON.stringify(accepted.data));
  const detail=(await call(`/admin/members/${accepted.data.id}`)).data;
  assert.equal(detail.cardHistory[0].remark,'赠送一天');

  const active=await create(nextPhone(),'month');
  const activeDetail=(await call(`/admin/members/${active.id}`)).data,oldEnd=activeDetail.card.end_date;
  const customRenewal={kind:'month',startDate:activeDetail.card.start_date,endDate:addDays(oldEnd,31),version:activeDetail.card.version};
  assert.equal((await call(`/admin/members/${active.id}/card/renew`,'POST',customRenewal)).status,400);
  assert.equal((await call(`/admin/members/${active.id}/card/renew`,'POST',{...customRenewal,remark:'  冻结补偿一天  '})).status,201);
  assert.equal((await call(`/admin/members/${active.id}`)).data.cardHistory[0].remark,'冻结补偿一天');
});
test('Renewal extends the single card, applies kind rules and preserves history',async()=>{
  const member=await create();
  const start=todayShanghai(),oldEnd=addDays(start,365),newEnd=addDays(oldEnd,30);
  assert.equal((await call(`/admin/members/${member.id}/card/renew`,'POST',{kind:'month',startDate:addDays(start,1),endDate:newEnd,version:1})).status,400);
  const renewal=await call(`/admin/members/${member.id}/card/renew`,'POST',{kind:'month',startDate:start,endDate:newEnd,version:1});assert.equal(renewal.status,201);
  assert.equal(renewal.data.kind,'year');assert.equal(renewal.data.end_date,newEnd);
  const renewedHistory=(await call(`/admin/members/${member.id}`)).data.cardHistory[0];assert.equal(renewedHistory.event_type,'renewed');assert.equal(renewedHistory.selected_kind,'month');
  assert.equal((await call(`/admin/members/${member.id}/card/renew`,'POST',{kind:'month',startDate:start,endDate:newEnd,version:1})).status,409);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM memberships WHERE member_id=$1',[member.id])).rows[0].n,1);
  assert.equal((await call(`/admin/members/${member.id}/card/void`,'POST',{reason:'录入有误'})).status,201);
  let detail=(await call(`/admin/members/${member.id}`)).data;
  const reopened=await call(`/admin/members/${member.id}/card/renew`,'POST',{kind:'month',startDate:start,endDate:addDays(start,30),version:detail.card.version});assert.equal(reopened.status,201);
  assert.equal(reopened.data.kind,'month');
  detail=(await call(`/admin/members/${member.id}`)).data;assert.equal(detail.card.kind,'month');assert.equal(detail.cardHistory.length,4);assert.equal(detail.logs,undefined);
  assert.ok((await db.query("SELECT 1 FROM audit_logs WHERE member_id=$1 AND action='card_voided'",[member.id])).rows.length);
  const editPayload={kind:'month',startDate:start,endDate:addDays(start,31),version:detail.card.version};
  assert.equal((await call(`/admin/members/${member.id}/card`,'PATCH',editPayload)).status,400);
  const edited=await call(`/admin/members/${member.id}/card`,'PATCH',{...editPayload,remark:'  人工补偿一天  '});assert.equal(edited.status,200);
  detail=(await call(`/admin/members/${member.id}`)).data;assert.equal(detail.cardHistory.length,5);assert.equal(detail.cardHistory[0].remark,'人工补偿一天');
});
test('Concurrent renewal updates the single card exactly once',async()=>{
  const member=await create(),start=todayShanghai(),payload={kind:'year',startDate:start,endDate:addDays(addDays(start,365),365),version:1};
  const results=await Promise.all([call(`/admin/members/${member.id}/card/renew`,'POST',payload),call(`/admin/members/${member.id}/card/renew`,'POST',payload)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409]);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM memberships WHERE member_id=$1',[member.id])).rows[0].n,1);
});
test('Expired cards restart today and renewal card types follow the confirmed rules',async()=>{
  const today=todayShanghai();
  const expired=await create(nextPhone(),'year',addDays(today,-60),addDays(today,-1));
  const expiredDetail=(await call(`/admin/members/${expired.id}`)).data;
  const restarted=await call(`/admin/members/${expired.id}/card/renew`,'POST',{kind:'month',startDate:today,endDate:addDays(today,30),version:expiredDetail.card.version});
  assert.equal(restarted.status,201);assert.equal(restarted.data.kind,'month');assert.equal(restarted.data.start_date,today);assert.equal(restarted.data.end_date,addDays(today,30));
  const activeMonth=await create(nextPhone(),'month',today,addDays(today,30));
  const upgraded=await call(`/admin/members/${activeMonth.id}/card/renew`,'POST',{kind:'year',startDate:today,endDate:addDays(addDays(today,30),365),version:1});
  assert.equal(upgraded.status,201);assert.equal(upgraded.data.kind,'year');
});
test('Soon-expiring stats and list use 30 days for year cards and 7 days for month cards',async()=>{
  const today=todayShanghai(),before=(await call('/admin/stats')).data.expiring;
  const included=[
    await create(nextPhone(),'year',today,addDays(today,30)),
    await create(nextPhone(),'month',today,addDays(today,7)),
    await create(nextPhone(),'month',addDays(today,-30),today)
  ];
  const excluded=[
    await create(nextPhone(),'year',today,addDays(today,31)),
    await create(nextPhone(),'month',today,addDays(today,8)),
    await create(nextPhone(),'month',addDays(today,1),addDays(today,7)),
    await create(nextPhone(),'month',addDays(today,-31),addDays(today,-1))
  ];
  const voided=await create(nextPhone(),'month',today,addDays(today,7));await call(`/admin/members/${voided.id}/card/void`,'POST',{reason:'边界测试'});
  const stats=await call('/admin/stats');assert.equal(stats.data.expiring,before+included.length);
  const result=await call('/admin/members?expiring=true&pageSize=100');assert.equal(result.status,200);
  const ids=new Set(result.data.items.map((member:any)=>member.id));
  for(const member of included)assert.equal(ids.has(member.id),true);
  for(const member of [...excluded,voided])assert.equal(ids.has(member.id),false);
});
test('Binding only claims pre-existing members, remains idempotent and protects private data',async()=>{
  const member=await create(),token=await bind(member,'wx-one');
  const r=await call('/me','GET',undefined,token);assert.equal(r.status,200);assert.equal(r.data.id,member.id);assert.equal(r.data.note,undefined);assert.equal(r.data.phone,undefined);assert.equal(r.data.openid,undefined);
  assert.equal(r.data.card.start_date,todayShanghai());assert.equal(r.data.card.end_date,addDays(todayShanghai(),365));assert.equal(r.data.cardHistory.length,1);assert.ok(r.data.cardHistory.every((event:any)=>!('remark' in event)));
  const second=await create();assert.equal((await call('/wechat/bind','POST',{phoneCode:second.phone},token)).status,201);assert.equal((await call('/me','GET',undefined,token)).data.id,member.id);
  assert.equal((await call('/admin/members','GET',undefined,token,{anonymous:true})).status,401);
  assert.equal((await call('/me','PUT',{name:'伪造'},token)).status,404);
  assert.equal((await call('/me/theme','PUT',{theme:'blue',memberId:second.id},token)).status,400);
  const stranger=await wxSession('stranger');const before=(await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n;
  assert.equal((await call('/wechat/bind','POST',{phoneCode:nextPhone()},stranger)).status,403);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM members')).rows[0].n,before);
  assert.equal((await call('/me','GET',undefined,stranger)).status,403);
});
test('Two WeChat identities cannot claim one member; reset immediately revokes every old session',async()=>{
  const member=await create(),a=await wxSession('race-a'),b=await wxSession('race-b');
  const result=await Promise.all([call('/wechat/bind','POST',{phoneCode:member.phone},a),call('/wechat/bind','POST',{phoneCode:member.phone},b)]);assert.deepEqual(result.map(r=>r.status).sort(),[201,409]);
  const winner=result[0].status===201?a:b,winnerId=result[0].status===201?'race-a':'race-b',additional=await wxSession(winnerId);
  assert.equal((await call('/me','GET',undefined,additional)).status,200);
  await call(`/admin/members/${member.id}/reset-binding`,'POST',{reason:'已核实本人，更换微信'});
  assert.equal((await call('/me','GET',undefined,winner)).status,401);assert.equal((await call('/me','GET',undefined,additional)).status,401);
  assert.equal((await call('/wechat/bind','POST',{phoneCode:member.phone},winner)).status,401);
  assert.ok(await bind(member,'new-wechat'));
});
test('Theme persists across sessions and renewal; avatars validate actual image and preserve old on failure',async()=>{
  const member=await create(),token=await bind(member,'avatar-user');
  for(const theme of ['gold','blue','orange','white'])assert.equal((await call('/me/theme','PUT',{theme},token)).status,200);
  assert.equal((await call('/me/theme','PUT',{theme:'evil'},token)).status,400);
  const image=await sharp({create:{width:800,height:600,channels:3,background:'#54a375'}}).png().toBuffer(),file=new FormData();file.append('file',new Blob([new Uint8Array(image)]),'avatar.png');
  assert.equal((await call('/me/avatar','POST',file,token)).status,201);
  const before=(await call('/me','GET',undefined,token)).data.avatar_key;
  const invalid=new FormData();invalid.append('file',new Blob(['not an image']),'fake.png');assert.equal((await call('/me/avatar','POST',invalid,token)).status,400);
  assert.equal((await call('/me','GET',undefined,token)).data.avatar_key,before);
  const data=await call('/me/avatar','GET',undefined,token);assert.equal(data.status,200);const info=await sharp(data.data).metadata();assert.equal(info.width,512);assert.equal(info.format,'jpeg');
  const detail=(await call(`/admin/members/${member.id}`)).data;
  await call(`/admin/members/${member.id}/card/renew`,'POST',{kind:'month',startDate:detail.card.start_date,endDate:addDays(detail.card.end_date,30),version:detail.card.version});
  assert.equal((await call('/me','GET',undefined,await wxSession('avatar-user'))).data.theme,'white');
  const other=await bind(await create(),'no-avatar');assert.equal((await call('/me/avatar','GET',undefined,other)).status,404);
});
test('Excel template round-trip, validation with row numbers, atomic confirm and exact-file idempotence',async()=>{
  const template=await call('/admin/imports/template');assert.equal(template.status,200);const w=new ExcelJS.Workbook();await w.xlsx.load(template.data);assert.deepEqual(w.worksheets[0].getRow(1).values.slice(1),columns);
  assert.deepEqual(columns,['姓名','手机号','卡种','开始日期','到期日期','备注','会员档案备注']);
  const phone=nextPhone(),buffer=await workbook([['导入会员',phone,'月卡','2026-01-01','2026-01-31','','档案备注']]);
  const p=await preview(buffer);assert.equal(p.status,201,JSON.stringify(p.data));assert.equal(p.data.status,'ready');
  assert.equal((await db.query('SELECT 1 FROM members WHERE phone=$1',[phone])).rows.length,0);
  const c=await call(`/admin/imports/${p.data.id}/confirm`,'POST');assert.equal(c.status,201);assert.equal(c.data.status,'committed');
  assert.equal((await call(`/admin/imports/${p.data.id}/confirm`,'POST')).data.status,'committed');assert.equal((await preview(buffer)).data.status,'committed');
  assert.equal((await db.query('SELECT 1 FROM members WHERE phone=$1',[phone])).rows.length,1);
  const newMember=(await db.query('SELECT * FROM members WHERE phone=$1',[phone])).rows[0];assert.equal(newMember.note,'档案备注');assert.ok(await bind(newMember,'imported-user'));
  assert.equal((await db.query("SELECT remark FROM membership_events WHERE member_id=$1 AND event_type='opened'",[newMember.id])).rows[0].remark,'');
  const missingRemark=await preview(await workbook([['特殊期限',nextPhone(),'月卡','2025-01-01','2025-02-01','','']]));assert.equal(missingRemark.data.status,'invalid');assert.ok(missingRemark.data.errors.some((e:any)=>e.row===2&&e.message.includes('备注')));
  const withRemark=await preview(await workbook([['特殊期限',nextPhone(),'月卡','2025-01-01','2025-02-01','赠送一天','']]));assert.equal(withRemark.data.status,'ready',JSON.stringify(withRemark.data));
  const bad=await preview(await workbook([['重复',phone,'年卡','2026-01-01','2026-12-31'],['错误日期',nextPhone(),'月卡','2026-02-30','2026-01-01']]));assert.equal(bad.data.status,'invalid');assert.ok(bad.data.errors.some((e:any)=>e.row===2));assert.ok(bad.data.errors.some((e:any)=>e.row===3));assert.equal((await call(`/admin/imports/${bad.data.id}/confirm`,'POST')).status,409);
});
test('Excel intra-file duplicates, formulas and commit-time conflicts do not partially insert',async()=>{
  const dup=nextPhone();const batch=await preview(await workbook([['甲',dup,'年卡','2026-01-01','2026-12-31'],['乙',dup,'年卡','2026-01-01','2026-12-31']]));assert.equal(batch.data.status,'invalid');
  const formula=await preview(await workbook([['公式',nextPhone(),'月卡',{formula:'DATE(2026,1,1)',result:'2026-01-01'},'2026-01-30']]));assert.equal(formula.data.status,'invalid',JSON.stringify({status:formula.status,data:formula.data}));
  const first=nextPhone(),second=nextPhone();const ready=await preview(await workbook([['甲',first,'年卡','2026-01-01','2027-01-01','',''],['乙',second,'年卡','2026-01-01','2027-01-01','','']]));assert.equal(ready.data.status,'ready',JSON.stringify(ready.data));
  await create(second);assert.equal((await call(`/admin/imports/${ready.data.id}/confirm`,'POST')).status,409);assert.equal((await db.query('SELECT 1 FROM members WHERE phone=$1',[first])).rows.length,0);
});
test('Search, status/date filters, settings and rate limit are enforced',async()=>{
  const member=await create(),today=todayShanghai(),end=addDays(today,365);const list=await call(`/admin/members?search=${member.phone}&status=active&endFrom=${end}&endTo=${end}`);assert.equal(list.status,200,JSON.stringify(list.data));
  assert.equal(list.data.items.length,1);assert.equal(list.data.items[0].card.start_date,today);
  assert.equal((await call('/admin/members?kind=year')).status,400);
  assert.equal((await call('/admin/settings','PATCH',{name:'测试门店',phone:'13800138000'})).status,200);assert.equal((await call('/store')).data.name,'测试门店');
  await db.migrate();assert.equal((await call('/store')).data.name,'测试门店');
  const source=await sharp({create:{width:900,height:300,channels:4,background:{r:1,g:85,b:86,alpha:.75}}}).png().toBuffer(),logoForm=new FormData();logoForm.append('file',new Blob([new Uint8Array(source)]),'logo.png');
  assert.equal((await call('/admin/settings/logo','POST',logoForm)).status,201);
  const storedLogo=await call('/store/logo');assert.match(storedLogo.res.headers.get('content-type')||'',/^image\/png/);const logoInfo=await sharp(storedLogo.data).metadata();assert.equal(logoInfo.width,900);assert.equal(logoInfo.height,300);assert.equal(logoInfo.format,'png');assert.equal(logoInfo.hasAlpha,true);
  const invalidLogo=new FormData();invalidLogo.append('file',new Blob(['not an image']),'logo.png');assert.equal((await call('/admin/settings/logo','POST',invalidLogo)).status,400);
  const preserved=await sharp((await call('/store/logo')).data).metadata();assert.equal(preserved.width,900);assert.equal(preserved.height,300);
  const auth=app.get(AuthService);await auth.limit('specific-test-key',1,60);await assert.rejects(auth.limit('specific-test-key',1,60));
});
test('Password change checks old password, hashes new password and invalidates all admin sessions',async()=>{
  assert.equal((await call('/admin/password','POST',{current:'wrong',next:'New-Password-At-Least-12'})).status,403);
  assert.equal((await call('/admin/password','POST',{current:originalPassword,next:'New-Password-At-Least-12'})).status,201);
  assert.equal((await call('/admin/session')).status,401);
  const r=await call('/admin/login','POST',{password:'New-Password-At-Least-12'});assert.equal(r.status,201);cookie=r.res.headers.get('set-cookie')!.split(';')[0];
});
