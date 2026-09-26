import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { Db, Queryable } from './db.js';
import { audit, nextMemberNumber } from './members.js';
import { OperationLogsService } from './operation-logs.js';
import { dateSchema } from './domain.js';
import { backupStamp, beijingDay, beijingMonth, normalizeExcelDate, normalizeExcelDateTime } from './time.js';

const FORMAT_VERSION='3';
const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const asDate=(value:any)=>String(value instanceof Date?value.toISOString():value).slice(0,10).replaceAll('-','/');
// Excel stores a date serial, while the display format remains Beijing time to seconds.
// Preserve milliseconds so same-second history events keep their original ordering on restore.
const asTime=(value:any)=>new Date(new Date(value).getTime()+8*3600000);
const clean=(value:any)=>value===null||value===undefined?'':value instanceof Date?new Date(value.getTime()-8*3600000).toISOString():typeof value==='object'?JSON.stringify(value):String(value);
const bool=(value:any)=>value===true||value===1||value==='1'||value==='true';
type BackupSource='manual'|'automatic'|'pre_restore';
type SheetDefinition={name:string;headers:string[];rows:any[][]};

@Injectable()
export class BackupsService {
  constructor(@Inject(Db)private db:Db,@Inject(OperationLogsService)private operationLogs:OperationLogsService){}
  private defaultDirectory(){return process.env.JOYFIT_BACKUP_PATH||join(homedir(),'Documents','悦体健身','自动备份');}

  async settings(){
    const row=(await this.db.query('SELECT * FROM backup_settings WHERE id=1')).rows[0],today=beijingDay();
    const latest=(await this.db.query('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT 1')).rows[0]||null;
    const automatic=(await this.db.query("SELECT * FROM backup_jobs WHERE trigger_source='automatic' AND scheduled_date=$1 ORDER BY created_at DESC LIMIT 1",[today])).rows[0]||null;
    const latestAutomatic=(await this.db.query("SELECT scheduled_date FROM backup_jobs WHERE trigger_source='automatic' ORDER BY scheduled_date DESC LIMIT 1")).rows[0]||null;
    const administrator=(await this.db.query('SELECT created_at FROM administrators WHERE id=1')).rows[0]||null;
    let automaticStatus='waiting',automaticStatusText='等待设定时间';
    if(automatic?.status==='sent'){automaticStatus='completed';automaticStatusText='今天已备份';}
    else if(automatic?.status==='email_failed'){automaticStatus='failed';automaticStatusText='邮件发送失败';}
    else if(automatic){automaticStatus='completed';automaticStatusText=row.sender_email?'等待发送':'今天已备份（已保存到本地）';}
    return {directory:row.directory||this.defaultDirectory(),senderEmail:row.sender_email,recipientEmail:row.recipient_email,
      scheduleTime:row.schedule_time,retentionCount:Number(row.retention_count),latest:latest?this.presentJob(latest):null,
      automaticStatus,automaticStatusText,today,latestAutomaticDate:latestAutomatic?.scheduled_date?String(latestAutomatic.scheduled_date).slice(0,10):null,
      initializedDate:administrator?.created_at?beijingDay(administrator.created_at):null};
  }

  async updateSettings(input:{directory:string;senderEmail:string;recipientEmail:string;scheduleTime:string;retentionCount:number}){
    const directory=resolve(input.directory.trim()||this.defaultDirectory()),senderEmail=input.senderEmail.trim(),recipientEmail=input.recipientEmail.trim()||senderEmail;
    await mkdir(directory,{recursive:true});
    await this.db.tx(async q=>{
      await q.query(`UPDATE backup_settings SET directory=$1,sender_email=$2,recipient_email=$3,schedule_time=$4,
        retention_count=$5,updated_at=now() WHERE id=1`,[directory,senderEmail,recipientEmail,input.scheduleTime,input.retentionCount]);
      await audit(q,'backup_settings_updated',null,{directory,senderEmail,recipientEmail,scheduleTime:input.scheduleTime,retentionCount:input.retentionCount});
    });return this.settings();
  }

  private async sheets(q:Queryable):Promise<SheetDefinition[]>{
    const [members,cards,events,store,state]=await Promise.all([
      q.query('SELECT id,name,phone,card_number,note,version,created_at,updated_at FROM members ORDER BY created_at,id'),
      q.query('SELECT id,member_id,kind,start_date,end_date,voided_at,void_reason,version,created_at,updated_at,paused_on,pause_count,total_paused_days,returned_at FROM memberships ORDER BY created_at,id'),
      q.query('SELECT id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,duration_days,detail,created_at FROM membership_events ORDER BY created_at,id'),
      q.query('SELECT name,phone,month_card_days,year_card_days FROM settings WHERE id=1'),q.query('SELECT data_revision FROM desktop_state WHERE id=1')]);
    const s=store.rows[0];return [
      {name:'备份信息',headers:['项目','值'],rows:[['格式版本',FORMAT_VERSION],['应用版本','1.3.0'],['导出时间',asTime(new Date())],['数据版本',String(state.rows[0].data_revision)],['会员数量',String(members.rows.length)],['当前会员卡数量',String(cards.rows.length)]]},
      {name:'门店设置',headers:['门店名称','联系电话','月卡天数','年卡天数'],rows:[[s.name,s.phone,s.month_card_days,s.year_card_days]]},
      {name:'会员档案',headers:['ID','姓名','手机号','会员号码','档案备注','版本','创建时间','更新时间'],rows:members.rows.map(r=>[r.id,r.name,r.phone,r.card_number,r.note,r.version,asTime(r.created_at),asTime(r.updated_at)])},
      {name:'当前会员卡',headers:['ID','会员ID','卡种','开始日期','到期日期','是否停用','停用时间','停用原因','版本','创建时间','更新时间','暂停开始日期','累计暂停次数','累计已恢复暂停天数','退卡时间'],rows:cards.rows.map(r=>[r.id,r.member_id,r.kind,asDate(r.start_date),asDate(r.end_date),!!r.voided_at,r.voided_at?asTime(r.voided_at):'',r.void_reason||'',r.version,asTime(r.created_at),asTime(r.updated_at),r.paused_on?asDate(r.paused_on):'',r.pause_count,r.total_paused_days,r.returned_at?asTime(r.returned_at):''])},
      {name:'会员卡历史',headers:['ID','会员ID','会员卡ID','事件类型','本次选择卡种','最终卡种','开始日期','到期日期','是否作废','作废时间','作废原因','备注','采用天数','详情','操作时间'],rows:events.rows.map(r=>[r.id,r.member_id,r.membership_id,r.event_type,r.selected_kind||'',r.kind,asDate(r.start_date),asDate(r.end_date),!!r.voided_at,r.voided_at?asTime(r.voided_at):'',r.void_reason||'',r.remark||'',r.duration_days??'',clean(r.detail),asTime(r.created_at)])}
    ];
  }

  async workbook(){
    const workbook=new ExcelJS.Workbook();workbook.creator='悦体健身 JOYFIT';workbook.created=new Date();
    const definitions=await this.db.tx(async q=>{await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');return this.sheets(q);});
    for(const definition of definitions){
      const sheet=workbook.addWorksheet(definition.name,{views:[{state:'frozen',ySplit:1}]});sheet.addRow(definition.headers);for(const row of definition.rows)sheet.addRow(row);
      sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF015556'}};
      sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:definition.headers.length}};
      definition.headers.forEach((header,index)=>{sheet.getColumn(index+1).width=Math.min(45,Math.max(12,header.length*2+4));sheet.getColumn(index+1).numFmt='@';});
      sheet.eachRow(row=>row.eachCell(cell=>{if(cell.value instanceof Date)cell.numFmt='yyyy/mm/dd hh:mm:ss';}));
    }return workbook;
  }
  async exportBuffer(){return Buffer.from(await(await this.workbook()).xlsx.writeBuffer());}

  async createLocal(source:BackupSource='manual',scheduledDate?:string){
    const day=scheduledDate||beijingDay();
    if(source==='automatic'){
      const existing=(await this.db.query("SELECT * FROM backup_jobs WHERE trigger_source='automatic' AND scheduled_date=$1",[day])).rows[0];
      if(existing)return {skipped:true,job:this.presentJob(existing)};
    }
    const revision=Number((await this.db.query('SELECT data_revision FROM desktop_state WHERE id=1')).rows[0].data_revision),config=await this.settings();
    const directory=resolve(config.directory);await mkdir(directory,{recursive:true});const fileName=`悦体健身会员数据备份-${backupStamp()}-${randomUUID().slice(0,8)}.xlsx`,filePath=join(directory,fileName);
    await writeFile(filePath,await this.exportBuffer(),{flag:'wx'});
    let job:any;try{job=(await this.db.query(`INSERT INTO backup_jobs(id,file_path,file_name,data_revision,status,trigger_source,scheduled_date)
      VALUES($1,$2,$3,$4,'local_saved',$5,$6) RETURNING *`,[randomUUID(),filePath,fileName,revision,source,source==='automatic'?day:null])).rows[0];}
    catch(error:any){if(source==='automatic'&&error?.code==='23505'){await unlink(filePath).catch(()=>{});job=(await this.db.query("SELECT * FROM backup_jobs WHERE trigger_source='automatic' AND scheduled_date=$1",[day])).rows[0];return {skipped:true,job:this.presentJob(job)};}throw error;}
    await this.trim(directory,config.retentionCount);return {skipped:false,job:this.presentJob(job)};
  }

  async markEmail(id:string,ok:boolean,error=''){const {rows}=await this.db.query(`UPDATE backup_jobs SET status=$2,error=$3,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,[id,ok?'sent':'email_failed',error.slice(0,1000)]);if(!rows[0])throw new NotFoundException('备份记录不存在');return this.presentJob(rows[0]);}
  async automaticPending(){const {rows}=await this.db.query("SELECT * FROM backup_jobs WHERE trigger_source='automatic' AND scheduled_date=$1 AND status IN ('local_saved','email_failed') LIMIT 1",[beijingDay()]);return rows[0]?this.presentJob(rows[0]):null;}
  async jobs(){return(await this.db.query('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT 30')).rows.map(row=>this.presentJob(row));}
  private presentJob(row:any){return {id:row.id,filePath:row.file_path,fileName:row.file_name,dataRevision:Number(row.data_revision),status:row.status,error:row.error||'',triggerSource:row.trigger_source||'manual',scheduledDate:row.scheduled_date?String(row.scheduled_date).slice(0,10):null,createdAt:row.created_at,sentAt:row.sent_at};}
  private async trim(directory:string,keep:number){const files=(await readdir(directory,{withFileTypes:true})).filter(f=>f.isFile()&&/^悦体健身会员数据备份-\d{14}(?:-[0-9a-f]{8})?\.xlsx$/.test(f.name)).map(f=>f.name).sort().reverse();for(const name of files.slice(keep))await unlink(join(directory,basename(name))).catch(()=>{});}

  async restore(buffer:Buffer){
    if(buffer.length>25*1024*1024)throw new BadRequestException('备份文件不能超过 25 MB');
    const workbook=new ExcelJS.Workbook();try{await workbook.xlsx.load(buffer as any);}catch{throw new BadRequestException('无法读取备份工作簿');}
    const table=(name:string,headers:string[])=>{const sheet=workbook.getWorksheet(name);if(!sheet)throw new BadRequestException(`缺少工作表：${name}`);const actual=sheet.getRow(1).values as any[];if(headers.some((h,i)=>String(actual[i+1]??'')!==h))throw new BadRequestException(`${name} 的表头不正确`);const rows:any[][]=[];for(let i=2;i<=sheet.rowCount;i++){const values=headers.map((_,j)=>clean(sheet.getRow(i).getCell(j+1).value).trim());if(values.some(Boolean))rows.push(values);}return rows;};
    const info=table('备份信息',['项目','值']),version=info.find(r=>r[0]==='格式版本')?.[1];if(!['1','2','3'].includes(version))throw new ConflictException('备份格式版本不兼容');
    const store=table('门店设置',['门店名称','联系电话','月卡天数','年卡天数'])[0];if(!store)throw new BadRequestException('门店设置为空');
    const members=table('会员档案',['ID','姓名','手机号',version==='1'?'会员卡号':'会员号码','档案备注','版本','创建时间','更新时间']);
    const cards=table('当前会员卡',['ID','会员ID','卡种','开始日期','到期日期',...(version==='3'?['是否停用','停用时间','停用原因']:['是否作废','作废时间','作废原因']),'版本','创建时间','更新时间',...(version==='3'?['暂停开始日期','累计暂停次数','累计已恢复暂停天数','退卡时间']:[])]);
    const events=table('会员卡历史',['ID','会员ID','会员卡ID','事件类型','本次选择卡种','最终卡种','开始日期','到期日期','是否作废','作废时间','作废原因','备注','采用天数','详情','操作时间']);
    this.validateRestore(store,members,cards,events,version);
    await this.operationLogs.flush();await this.createLocal('pre_restore');
    await this.db.tx(async q=>{
      await q.query('DELETE FROM wechat_bindings');await q.query("DELETE FROM sessions WHERE role='wechat'");await q.query('DELETE FROM membership_events');await q.query('DELETE FROM memberships');await q.query('UPDATE audit_logs SET member_id=NULL WHERE member_id IS NOT NULL');await q.query('DELETE FROM members');await q.query('DELETE FROM import_batches');await q.query('DELETE FROM member_number_sequences');
      for(const r of members){const created=normalizeExcelDateTime(r[6]),updated=normalizeExcelDateTime(r[7]);const number=version!=='1'?r[3]:await nextMemberNumber(q,beijingMonth(created));await q.query(`INSERT INTO members(id,name,phone,card_number,note,theme,avatar_key,version,created_at,updated_at) VALUES($1,$2,$3,$4,$5,'gold',NULL,$6,$7,$8)`,[r[0],r[1],r[2],number,r[4],Number(r[5]),created,updated]);}
      if(version!=='1')await q.query(`INSERT INTO member_number_sequences(month_key,last_value) SELECT substring(card_number from 2 for 6),max(substring(card_number from 8 for 4)::integer) FROM members GROUP BY substring(card_number from 2 for 6)`);
      for(const r of cards)await q.query(`INSERT INTO memberships(id,member_id,kind,start_date,end_date,voided_at,void_reason,version,created_at,updated_at,paused_on,pause_count,total_paused_days,returned_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[r[0],r[1],r[2],normalizeExcelDate(r[3]),normalizeExcelDate(r[4]),bool(r[5])?normalizeExcelDateTime(r[6]):null,r[7]||null,Number(r[8]),normalizeExcelDateTime(r[9]),normalizeExcelDateTime(r[10]),version==='3'&&r[11]?normalizeExcelDate(r[11]):null,version==='3'?Number(r[12]):0,version==='3'?Number(r[13]):0,version==='3'&&r[14]?normalizeExcelDateTime(r[14]):null]);
      for(const r of events)await q.query(`INSERT INTO membership_events(id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,duration_days,detail,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[r[0],r[1],r[2],r[3],r[4]||null,r[5],normalizeExcelDate(r[6]),normalizeExcelDate(r[7]),bool(r[8])?normalizeExcelDateTime(r[9]):null,r[10]||null,r[11],r[12]?Number(r[12]):null,r[13]||'{}',normalizeExcelDateTime(r[14])]);
      await q.query('UPDATE settings SET name=$1,phone=$2,month_card_days=$3,year_card_days=$4,updated_at=now() WHERE id=1',[store[0],store[1],Number(store[2]),Number(store[3])]);await audit(q,'backup_restored',null,{members:members.length,cards:cards.length,events:events.length,sourceVersion:version});
    });return {ok:true,members:members.length,cards:cards.length,events:events.length};
  }

  private validateRestore(store:any[],members:any[][],cards:any[][],events:any[][],version:string){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,date=/^\d{4}[\/-]\d{2}[\/-]\d{2}$/;
    const month=Number(store[2]),year=Number(store[3]);if(!store[0]||!Number.isInteger(month)||!Number.isInteger(year)||month<1||year<1||month>3650||year>3650)throw new BadRequestException('门店设置中的卡期天数无效');
    const ids=new Set<string>(),phones=new Set<string>(),numbers=new Set<string>();for(const r of members){if(!uuid.test(r[0])||!r[1]||!/^1[3-9]\d{9}$/.test(r[2])||!r[3])throw new BadRequestException('会员档案包含无效数据');if(version!=='1'&&!/^Y\d{10}$/.test(r[3]))throw new BadRequestException('会员号码格式不正确');if(ids.has(r[0])||phones.has(r[2])||numbers.has(r[3]))throw new BadRequestException('会员档案包含重复ID、手机号或会员号码');ids.add(r[0]);phones.add(r[2]);numbers.add(r[3]);}
    const cardIds=new Set<string>(),cardMembers=new Set<string>();for(const r of cards){if(!uuid.test(r[0])||!ids.has(r[1])||!['year','month'].includes(r[2])||!date.test(r[3])||!date.test(r[4])||normalizeExcelDate(r[4])<normalizeExcelDate(r[3]))throw new BadRequestException('当前会员卡包含无效数据');if(cardIds.has(r[0])||cardMembers.has(r[1]))throw new BadRequestException('每位会员只能有一张当前会员卡');cardIds.add(r[0]);cardMembers.add(r[1]);}
    if(version==='3')for(const r of cards){
      const count=Number(r[12]),days=Number(r[13]);
      if(!/^\d+$/.test(r[12])||!/^\d+$/.test(r[13])||!Number.isSafeInteger(count)||!Number.isSafeInteger(days)||count>2147483647||days>2147483647)throw new BadRequestException('暂停次数或天数无效');
      if(r[11]){const paused=normalizeExcelDate(r[11]);if(!dateSchema.safeParse(paused).success||paused<normalizeExcelDate(r[3])||paused>normalizeExcelDate(r[4])||bool(r[5])||r[14]||count<1)throw new BadRequestException('暂停状态与会员卡数据不一致');}
      if(r[14]&&(!bool(r[5])||!Number.isFinite(Date.parse(normalizeExcelDateTime(r[14])))))throw new BadRequestException('退卡状态或时间无效');
    }
    const eventIds=new Set<string>();for(const r of events){if(!uuid.test(r[0])||!ids.has(r[1])||!uuid.test(r[2])||eventIds.has(r[0]))throw new BadRequestException('会员卡历史包含无效或重复数据');try{JSON.parse(r[13]||'{}');}catch{throw new BadRequestException('会员卡历史详情不是有效JSON');}eventIds.add(r[0]);}
  }
}
export {MIME as BACKUP_MIME};
