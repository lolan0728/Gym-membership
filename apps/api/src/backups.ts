import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { mkdir, readdir, unlink, writeFile } from 'node:fs/promises';
import { Db, Queryable } from './db.js';
import { audit } from './members.js';

const FORMAT_VERSION='1';
const MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const asDate=(value:any)=>value instanceof Date?value.toISOString().slice(0,10):String(value).slice(0,10);
const asTime=(value:any)=>value instanceof Date?value.toISOString():new Date(value).toISOString();
const clean=(value:any)=>value===null||value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
const bool=(value:any)=>value===true||value===1||value==='1'||value==='true';

type SheetDefinition={name:string;headers:string[];rows:any[][]};

@Injectable()
export class BackupsService {
  constructor(@Inject(Db) private db:Db) {}

  private defaultDirectory(){return process.env.JOYFIT_BACKUP_PATH||join(homedir(),'Documents','悦体健身','自动备份');}

  async settings(){
    const row=(await this.db.query('SELECT * FROM backup_settings WHERE id=1')).rows[0];
    const latest=(await this.db.query('SELECT id,file_name,file_path,status,error,data_revision,created_at,sent_at FROM backup_jobs ORDER BY created_at DESC LIMIT 1')).rows[0]||null;
    return {directory:row.directory||this.defaultDirectory(),senderEmail:row.sender_email,recipientEmail:row.recipient_email,scheduleTime:row.schedule_time,retentionCount:Number(row.retention_count),latest};
  }

  async updateSettings(input:{directory:string;senderEmail:string;recipientEmail:string;scheduleTime:string;retentionCount:number}){
    const directory=resolve(input.directory.trim()||this.defaultDirectory());
    const senderEmail=input.senderEmail.trim(),recipientEmail=input.recipientEmail.trim()||senderEmail;
    await mkdir(directory,{recursive:true});
    await this.db.tx(async q=>{
      await q.query(`UPDATE backup_settings SET directory=$1,sender_email=$2,recipient_email=$3,schedule_time=$4,
        retention_count=$5,updated_at=now() WHERE id=1`,[directory,senderEmail,recipientEmail,input.scheduleTime,input.retentionCount]);
      await audit(q,'backup_settings_updated',null,{directory,senderEmail,recipientEmail,scheduleTime:input.scheduleTime,retentionCount:input.retentionCount});
    });
    return this.settings();
  }

  private async sheets(q:Queryable):Promise<SheetDefinition[]>{
    const [members,cards,events,logs,store,state]=await Promise.all([
      q.query('SELECT id,name,phone,card_number,note,version,created_at,updated_at FROM members ORDER BY created_at,id'),
      q.query('SELECT id,member_id,kind,start_date,end_date,voided_at,void_reason,version,created_at,updated_at FROM memberships ORDER BY created_at,id'),
      q.query('SELECT id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,duration_days,detail,created_at FROM membership_events ORDER BY created_at,id'),
      q.query('SELECT id,member_id,action,actor,detail,created_at FROM audit_logs ORDER BY created_at,id'),
      q.query('SELECT name,phone,month_card_days,year_card_days FROM settings WHERE id=1'),
      q.query('SELECT data_revision FROM desktop_state WHERE id=1')
    ]);
    const s=store.rows[0];
    return [
      {name:'备份信息',headers:['项目','值'],rows:[['格式版本',FORMAT_VERSION],['应用版本',process.env.npm_package_version||'1.0.0'],['导出时间',new Date().toISOString()],['数据版本',String(state.rows[0].data_revision)],['会员数量',String(members.rows.length)],['当前会员卡数量',String(cards.rows.length)]]},
      {name:'门店设置',headers:['门店名称','联系电话','月卡天数','年卡天数'],rows:[[s.name,s.phone,s.month_card_days,s.year_card_days]]},
      {name:'会员档案',headers:['ID','姓名','手机号','会员卡号','档案备注','版本','创建时间','更新时间'],rows:members.rows.map(r=>[r.id,r.name,r.phone,r.card_number,r.note,r.version,asTime(r.created_at),asTime(r.updated_at)])},
      {name:'当前会员卡',headers:['ID','会员ID','卡种','开始日期','到期日期','是否作废','作废时间','作废原因','版本','创建时间','更新时间'],rows:cards.rows.map(r=>[r.id,r.member_id,r.kind,asDate(r.start_date),asDate(r.end_date),!!r.voided_at,r.voided_at?asTime(r.voided_at):'',r.void_reason||'',r.version,asTime(r.created_at),asTime(r.updated_at)])},
      {name:'会员卡历史',headers:['ID','会员ID','会员卡ID','事件类型','本次选择卡种','最终卡种','开始日期','到期日期','是否作废','作废时间','作废原因','备注','采用天数','详情','操作时间'],rows:events.rows.map(r=>[r.id,r.member_id,r.membership_id,r.event_type,r.selected_kind||'',r.kind,asDate(r.start_date),asDate(r.end_date),!!r.voided_at,r.voided_at?asTime(r.voided_at):'',r.void_reason||'',r.remark||'',r.duration_days??'',clean(r.detail),asTime(r.created_at)])},
      {name:'操作记录',headers:['ID','会员ID','操作','操作者','详情','操作时间'],rows:logs.rows.map(r=>[r.id,r.member_id||'',r.action,r.actor,clean(r.detail),asTime(r.created_at)])}
    ];
  }

  async workbook(){
    const workbook=new ExcelJS.Workbook();
    workbook.creator='悦体健身 JOYFIT';workbook.created=new Date();
    for(const definition of await this.sheets(this.db)){
      const sheet=workbook.addWorksheet(definition.name,{views:[{state:'frozen',ySplit:1}]});
      sheet.addRow(definition.headers);for(const row of definition.rows)sheet.addRow(row);
      sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};
      sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF015556'}};
      sheet.autoFilter={from:{row:1,column:1},to:{row:Math.max(1,sheet.rowCount),column:definition.headers.length}};
      definition.headers.forEach((header,index)=>{sheet.getColumn(index+1).width=Math.min(45,Math.max(12,header.length*2+4));sheet.getColumn(index+1).numFmt='@';});
    }
    return workbook;
  }

  async exportBuffer(){return Buffer.from(await (await this.workbook()).xlsx.writeBuffer());}

  async createLocal(force=false){
    const revision=Number((await this.db.query('SELECT data_revision FROM desktop_state WHERE id=1')).rows[0].data_revision);
    const previous=(await this.db.query('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT 1')).rows[0];
    if(!force&&previous&&Number(previous.data_revision)===revision)return {skipped:true,job:this.presentJob(previous)};
    const config=await this.settings(),directory=resolve(config.directory);await mkdir(directory,{recursive:true});
    const stamp=new Date().toLocaleString('sv-SE',{timeZone:'Asia/Shanghai'}).replace(/[-: ]/g,'').slice(0,14);
    const fileName=`悦体健身会员数据备份-${stamp}.xlsx`,filePath=join(directory,fileName);
    await writeFile(filePath,await this.exportBuffer());
    const job=(await this.db.query(`INSERT INTO backup_jobs(id,file_path,file_name,data_revision,status) VALUES($1,$2,$3,$4,'local_saved') RETURNING *`,[randomUUID(),filePath,fileName,revision])).rows[0];
    await this.trim(directory,config.retentionCount);
    return {skipped:false,job:this.presentJob(job)};
  }

  async markEmail(id:string,ok:boolean,error=''){
    const {rows}=await this.db.query(`UPDATE backup_jobs SET status=$2,error=$3,sent_at=CASE WHEN $2='sent' THEN now() ELSE NULL END WHERE id=$1 RETURNING *`,[id,ok?'sent':'email_failed',error.slice(0,1000)]);
    if(!rows[0])throw new NotFoundException('备份记录不存在');return this.presentJob(rows[0]);
  }

  async pending(){const {rows}=await this.db.query("SELECT * FROM backup_jobs WHERE status IN ('local_saved','email_failed') ORDER BY created_at DESC LIMIT 1");return rows[0]?this.presentJob(rows[0]):null;}
  async jobs(){return (await this.db.query('SELECT * FROM backup_jobs ORDER BY created_at DESC LIMIT 30')).rows.map(row=>this.presentJob(row));}

  private presentJob(row:any){return {id:row.id,filePath:row.file_path,fileName:row.file_name,dataRevision:Number(row.data_revision),status:row.status,error:row.error||'',createdAt:row.created_at,sentAt:row.sent_at};}
  private async trim(directory:string,keep:number){
    const files=(await readdir(directory,{withFileTypes:true})).filter(f=>f.isFile()&&/^悦体健身会员数据备份-\d{14}\.xlsx$/.test(f.name)).map(f=>f.name).sort().reverse();
    for(const name of files.slice(keep))await unlink(join(directory,basename(name))).catch(()=>{});
  }

  async restore(buffer:Buffer){
    if(buffer.length>25*1024*1024)throw new BadRequestException('备份文件不能超过 25 MB');
    const workbook=new ExcelJS.Workbook();try{await workbook.xlsx.load(buffer as any);}catch{throw new BadRequestException('无法读取备份工作簿');}
    const required=['备份信息','门店设置','会员档案','当前会员卡','会员卡历史','操作记录'];
    for(const name of required)if(!workbook.getWorksheet(name))throw new BadRequestException(`缺少工作表：${name}`);
    const table=(name:string,headers:string[])=>{
      const sheet=workbook.getWorksheet(name)!;
      const actual=sheet.getRow(1).values as any[];
      if(headers.some((h,i)=>String(actual[i+1]??'')!==h))throw new BadRequestException(`${name} 的表头不正确`);
      const rows:any[][]=[];for(let i=2;i<=sheet.rowCount;i++){const values=headers.map((_,j)=>clean(sheet.getRow(i).getCell(j+1).value).trim());if(values.some(Boolean))rows.push(values);}return rows;
    };
    const info=table('备份信息',['项目','值']);
    if(info.find(r=>r[0]==='格式版本')?.[1]!==FORMAT_VERSION)throw new ConflictException('备份格式版本不兼容');
    const store=table('门店设置',['门店名称','联系电话','月卡天数','年卡天数'])[0];
    if(!store)throw new BadRequestException('门店设置为空');
    const members=table('会员档案',['ID','姓名','手机号','会员卡号','档案备注','版本','创建时间','更新时间']);
    const cards=table('当前会员卡',['ID','会员ID','卡种','开始日期','到期日期','是否作废','作废时间','作废原因','版本','创建时间','更新时间']);
    const events=table('会员卡历史',['ID','会员ID','会员卡ID','事件类型','本次选择卡种','最终卡种','开始日期','到期日期','是否作废','作废时间','作废原因','备注','采用天数','详情','操作时间']);
    const logs=table('操作记录',['ID','会员ID','操作','操作者','详情','操作时间']);
    this.validateRestore(store,members,cards,events,logs);
    await this.createLocal(true);
    await this.db.tx(async q=>{
      await q.query('DELETE FROM wechat_bindings');await q.query("DELETE FROM sessions WHERE role='wechat'");
      await q.query('DELETE FROM membership_events');await q.query('DELETE FROM memberships');await q.query('DELETE FROM audit_logs');await q.query('DELETE FROM members');await q.query('DELETE FROM import_batches');
      for(const r of members)await q.query(`INSERT INTO members(id,name,phone,card_number,note,theme,avatar_key,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,'gold',NULL,$6,$7,$8)`,[r[0],r[1],r[2],r[3],r[4],Number(r[5]),r[6],r[7]]);
      for(const r of cards)await q.query(`INSERT INTO memberships(id,member_id,kind,start_date,end_date,voided_at,void_reason,version,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[r[0],r[1],r[2],r[3],r[4],bool(r[5])?r[6]:null,r[7]||null,Number(r[8]),r[9],r[10]]);
      for(const r of events)await q.query(`INSERT INTO membership_events(id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,duration_days,detail,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[r[0],r[1],r[2],r[3],r[4]||null,r[5],r[6],r[7],bool(r[8])?r[9]:null,r[10]||null,r[11],r[12]?Number(r[12]):null,r[13]||'{}',r[14]]);
      for(const r of logs)await q.query('INSERT INTO audit_logs(id,member_id,action,actor,detail,created_at) VALUES($1,$2,$3,$4,$5,$6)',[r[0],r[1]||null,r[2],r[3],r[4]||'{}',r[5]]);
      await q.query('UPDATE settings SET name=$1,phone=$2,month_card_days=$3,year_card_days=$4,updated_at=now() WHERE id=1',[store[0],store[1],Number(store[2]),Number(store[3])]);
      await audit(q,'backup_restored',null,{members:members.length,cards:cards.length,events:events.length});
    });
    return {ok:true,members:members.length,cards:cards.length,events:events.length};
  }

  private validateRestore(store:any[],members:any[][],cards:any[][],events:any[][],logs:any[][]){
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,date=/^\d{4}-\d{2}-\d{2}$/;
    const month=Number(store[2]),year=Number(store[3]);if(!store[0]||!Number.isInteger(month)||!Number.isInteger(year)||month<1||year<1||month>3650||year>3650)throw new BadRequestException('门店设置中的卡期天数无效');
    const ids=new Set<string>(),phones=new Set<string>(),numbers=new Set<string>();
    for(const r of members){if(!uuid.test(r[0])||!r[1]||!/^1[3-9]\d{9}$/.test(r[2])||!r[3])throw new BadRequestException('会员档案包含无效数据');if(ids.has(r[0])||phones.has(r[2])||numbers.has(r[3]))throw new BadRequestException('会员档案包含重复ID、手机号或卡号');ids.add(r[0]);phones.add(r[2]);numbers.add(r[3]);}
    const cardIds=new Set<string>(),cardMembers=new Set<string>();for(const r of cards){if(!uuid.test(r[0])||!ids.has(r[1])||!['year','month'].includes(r[2])||!date.test(r[3])||!date.test(r[4])||r[4]<r[3])throw new BadRequestException('当前会员卡包含无效数据');if(cardIds.has(r[0])||cardMembers.has(r[1]))throw new BadRequestException('每位会员只能有一张当前会员卡');cardIds.add(r[0]);cardMembers.add(r[1]);}
    const eventIds=new Set<string>();for(const r of events){if(!uuid.test(r[0])||!ids.has(r[1])||!uuid.test(r[2])||eventIds.has(r[0]))throw new BadRequestException('会员卡历史包含无效或重复数据');try{JSON.parse(r[13]||'{}');}catch{throw new BadRequestException('会员卡历史详情不是有效JSON');}eventIds.add(r[0]);}
    const logIds=new Set<string>();for(const r of logs){if(!uuid.test(r[0])||(r[1]&&!ids.has(r[1]))||logIds.has(r[0]))throw new BadRequestException('操作记录包含无效或重复数据');try{JSON.parse(r[4]||'{}');}catch{throw new BadRequestException('操作记录详情不是有效JSON');}logIds.add(r[0]);}
  }
}

export {MIME as BACKUP_MIME};
