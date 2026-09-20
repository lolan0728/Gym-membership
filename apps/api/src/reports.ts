import {BadRequestException,Controller,Get,Inject,Injectable,Query,Res} from '@nestjs/common';
import type {Response} from 'express';
import {Db} from './db.js';
import {StorageService} from './storage.js';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {addDays,statusOf} from './domain.js';
import {beijingDay,formatBeijingDateTime} from './time.js';
import {renderReportPdf} from './report-pdf.js';

export const metricLabels:Record<string,string>={newMembers:'新增会员人数',newYear:'新办年卡人数',newMonth:'新办月卡人数',renewMembers:'续卡人数',renewCount:'续卡次数',renewYear:'续年卡次数',renewMonth:'续月卡次数',early:'未到期续卡人数',late:'到期后续卡人数',reopened:'作废后重新开卡人数',unclassified:'未分类续卡次数',voidCount:'作废次数'};
export function validateMonth(value:unknown){
  if(typeof value!=='string'||!/^20\d{2}-(0[1-9]|1[0-2])$/.test(value))throw new BadRequestException('请选择有效统计月份（2000至2099年）');
  return value;
}
const day=(v:any)=>v instanceof Date?v.toISOString().slice(0,10):String(v).slice(0,10);
export function summarize(members:any[],events:any[],month:string,now=new Date()){
  const today=beijingDay(now),byMember=new Map<string,any[]>();
  for(const e of events){const rows=byMember.get(e.member_id)||[];rows.push(e);byMember.set(e.member_id,rows);}
  const first=new Map<string,any>();let unknownFirst=0;
  for(const m of members){
    const all=byMember.get(m.id)||[],opened=all.filter(e=>e.event_type==='opened').sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime()||a.id.localeCompare(b.id));
    const migrated=all.filter(e=>e.event_type==='migrated').sort((a,b)=>day(a.start_date).localeCompare(day(b.start_date))||a.id.localeCompare(b.id));
    const event=opened[0]||migrated[0];if(event)first.set(m.id,event);else unknownFirst++;
  }
  const aggregate=(target:string)=>{
    const values=Object.fromEntries(Object.keys(metricLabels).map(k=>[k,0])) as Record<string,number>;
    for(const e of first.values())if(day(e.start_date).slice(0,7)===target){values.newMembers++;if(e.kind==='year')values.newYear++;else values.newMonth++;}
    const renewed=new Set<string>(),early=new Set<string>(),late=new Set<string>(),reopened=new Set<string>();
    for(const e of events){
      const date=beijingDay(e.created_at);if(date.slice(0,7)!==target)continue;
      if(e.event_type==='voided')values.voidCount++;
      if(e.event_type!=='renewed')continue;
      renewed.add(e.member_id);values.renewCount++;
      const kind=e.selected_kind;if(kind==='year')values.renewYear++;else if(kind==='month')values.renewMonth++;
      const before=e.detail?.before;
      if(!before||!before.end_date||!Object.hasOwn(before,'voided_at')){values.unclassified++;continue;}
      if(before.voided_at)reopened.add(e.member_id);else if(day(before.end_date)>=date)early.add(e.member_id);else late.add(e.member_id);
    }
    values.renewMembers=renewed.size;values.early=early.size;values.late=late.size;values.reopened=reopened.size;return values;
  };
  const rows=members.map(m=>{
    const c=m.card?{...m.card,start_date:day(m.card.start_date),end_date:day(m.card.end_date)}:null;
    return {id:m.id,name:m.name,phone:m.phone,card_number:m.card_number,card:c,status:c?statusOf(c,today):'none'};
  }).sort((a,b)=>a.card_number.localeCompare(b.card_number));
  const current={total:rows.length,active:0,upcoming:0,expired:0,voided:0,none:0,activeYear:0,activeMonth:0};
  for(const m of rows){current[m.status as 'active'|'upcoming'|'expired'|'voided'|'none']++;if(m.status==='active'){if(m.card.kind==='year')current.activeYear++;else current.activeMonth++;}}
  const expiring=rows.filter(m=>m.status==='active'&&m.card.end_date<=addDays(today,m.card.kind==='year'?30:7)).sort((a,b)=>a.card.end_date.localeCompare(b.card.end_date)||a.card_number.localeCompare(b.card_number));
  const expired=rows.filter(m=>m.status==='expired'&&m.card.end_date>=addDays(today,-30)).map(m=>({...m,expiredDays:Math.round((Date.parse(today)-Date.parse(m.card.end_date))/86400000)})).sort((a,b)=>a.card.end_date.localeCompare(b.card.end_date)||a.card_number.localeCompare(b.card_number));
  const end=new Date(month+'-01T00:00:00Z'),trend=[];
  for(let offset=11;offset>=0;offset--){const d=new Date(end);d.setUTCMonth(d.getUTCMonth()-offset);const key=d.toISOString().slice(0,7),v=aggregate(key);trend.push({month:key,newMembers:v.newMembers,renewMembers:v.renewMembers});}
  return {month,generatedAt:now.toISOString(),today,metrics:aggregate(month),unknownFirst,current,trend,members:rows,expiring,expired};
}
export type ReportData=ReturnType<typeof summarize>&{storeName:string};
@Injectable()
export class ReportsService {
  constructor(@Inject(Db)private db:Db,@Inject(StorageService)private storage:StorageService){}
  async snapshot(month:string){
    validateMonth(month);
    return this.db.tx(async q=>{
      await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const now=new Date();
      const members=(await q.query('SELECT id,name,phone,card_number,(SELECT to_jsonb(c) FROM memberships c WHERE c.member_id=m.id) AS card FROM members m')).rows;
      const events=(await q.query('SELECT id,member_id,event_type,selected_kind,kind,start_date,end_date,detail,created_at FROM membership_events')).rows;
      const store=(await q.query('SELECT name,logo_key FROM settings WHERE id=1')).rows[0];
      return {data:{...summarize(members,events,month,now),storeName:store.name},logoKey:store.logo_key};
    });
  }
  async monthly(month:string){const {data}=await this.snapshot(month);const {members,...result}=data;return result;}
  async pdf(type:'members'|'monthly',month:string){
    const {data,logoKey}=await this.snapshot(month);
    const logo=logoKey?await this.storage.get(logoKey):await readFile(resolve(import.meta.dirname,'../assets/joyfit-logo.png'));
    return renderReportPdf(data,type,logo);
  }
}
@Controller('api/admin/reports')
export class ReportsController {
  constructor(@Inject(ReportsService)private reports:ReportsService){}
  @Get('monthly') monthly(@Query('month')month:string){return this.reports.monthly(validateMonth(month));}
  @Get('members.pdf') async members(@Res()res:Response){res.type('application/pdf').attachment('joyfit-members.pdf').send(await this.reports.pdf('members',beijingDay().slice(0,7)));}
  @Get('monthly.pdf') async monthlyPdf(@Query('month')month:string,@Res()res:Response){res.type('application/pdf').attachment('joyfit-monthly-'+validateMonth(month)+'.pdf').send(await this.reports.pdf('monthly',month));}
}
