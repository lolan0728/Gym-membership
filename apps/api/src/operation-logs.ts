import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Db } from './db.js';
import { formatBeijingDateTime } from './time.js';

const labels:Record<string,string>={
  desktop_initialized:'完成首次设置',member_created:'新增会员',member_updated:'修改会员资料',
  card_renewed:'会员续卡',card_updated:'修改会员卡',card_voided:'作废会员卡',
  card_paused:'暂停会员卡',card_resumed:'恢复会员卡',card_returned:'退卡',
  import_committed:'批量导入会员',settings_updated:'修改门店设置',logo_updated:'更新门店Logo',
  password_changed:'修改管理员密码',backup_settings_updated:'修改备份设置',backup_restored:'恢复完整备份',
  binding_reset:'重置微信绑定',wechat_bound:'绑定微信'
};

function safeDetail(value:any){
  const detail=typeof value==='string'?(()=>{try{return JSON.parse(value);}catch{return value;}})():value;
  if(detail&&typeof detail==='object'){
    const copy={...detail};
    for(const key of ['password','authorizationCode','smtpCode','token','tokenHash','cardNumber'])delete copy[key];
    return JSON.stringify(copy);
  }
  return String(detail??'');
}

@Injectable()
export class OperationLogsService implements OnModuleInit {
  private running=false;
  constructor(@Inject(Db)private db:Db){}
  directory(){return resolve(process.env.JOYFIT_OPERATION_LOG_PATH||join(homedir(),'.joyfit','logs'));}
  async onModuleInit(){if(process.env.DESKTOP_MODE==='true')await this.flush().catch(error=>Logger.warn(`操作日志初始化失败：${error.message}`,'OperationLogs'));}
  async flush(){
    if(this.running)return {count:0};this.running=true;
    try{
      await mkdir(this.directory(),{recursive:true});let count=0;
      while(true){
        const rows=(await this.db.query(`SELECT a.id,a.action,a.actor,a.detail,a.created_at,m.card_number
          FROM audit_logs a LEFT JOIN members m ON m.id=a.member_id
          WHERE a.flushed_at IS NULL ORDER BY a.created_at,a.id LIMIT 200`)).rows;
        if(!rows.length)break;
        const groups=new Map<string,{ids:string[];lines:string[]}>();
        for(const row of rows){
          const timestamp=formatBeijingDateTime(row.created_at),month=timestamp.slice(0,7).replace('/','-');
          const group=groups.get(month)||{ids:[],lines:[]};group.ids.push(row.id);
          group.lines.push(`${timestamp} | ${row.actor==='member'?'会员':'管理员'} | ${labels[row.action]||row.action} | ${row.card_number||'-'} | ${safeDetail(row.detail).replace(/[\r\n]+/g,' ')}\r\n`);
          groups.set(month,group);
        }
        for(const [month,group] of groups){
          await appendFile(join(this.directory(),`operations-${month}.log`),group.lines.join(''),'utf8');
          await this.db.query('UPDATE audit_logs SET flushed_at=now() WHERE id=ANY($1::uuid[])',[group.ids]);count+=group.ids.length;
        }
      }
      return {count};
    }finally{this.running=false;}
  }
}
