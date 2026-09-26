import {Inject,Injectable,OnApplicationBootstrap,OnModuleDestroy,Logger} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import {Db} from './db.js';
import {MembersService,displayCard} from './members.js';
import {addDays,todayShanghai} from './domain.js';

@Injectable()
export class RemindersService implements OnApplicationBootstrap,OnModuleDestroy {
  private timer?:ReturnType<typeof setInterval>;
  private running?:Promise<void>;
  constructor(@Inject(Db)private db:Db,@Inject(MembersService)private members:MembersService){}
  async onApplicationBootstrap(){await this.check();this.timer=setInterval(()=>this.check().catch(()=>Logger.warn('Date reminder check failed')),60000);this.timer.unref();}
  onModuleDestroy(){clearInterval(this.timer);return this.running;}
  check(){if(!this.running)this.running=this.tick().finally(()=>{this.running=undefined;});return this.running;}
  private async tick(){
    const today=todayShanghai();
    const pending=(await this.db.query("SELECT id,member_id,effective_date FROM card_appointments WHERE status='pending' AND effective_date<=$1 ORDER BY effective_date,CASE action WHEN 'pause' THEN 0 ELSE 1 END,created_at",[today])).rows;
    for(const item of pending){try{await this.members.executeAppointment(item.id);}catch(error){
      await this.db.tx(async q=>{
        await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[item.member_id]);
        const message=error instanceof Error?error.message:'预约执行失败，请核查';
        const changed=await q.query("UPDATE card_appointments SET status='failed',error=$2,updated_at=now() WHERE id=$1 AND status='pending' RETURNING id",[item.id,message]);
        if(changed.rows.length)await q.query("INSERT INTO notifications(id,member_id,event_key,kind,title,effective_date) VALUES($1,$2,$3,'error',$4,$5) ON CONFLICT(event_key) DO NOTHING",[randomUUID(),item.member_id,'appointment:'+item.id,'预约执行异常：'+message,item.effective_date]);
      });
    }}
    await this.db.tx(async q=>{
      const checked=(await q.query('SELECT checked_date FROM reminder_state WHERE id=1 FOR UPDATE')).rows[0].checked_date;
      const last=checked instanceof Date?checked.toISOString().slice(0,10):String(checked).slice(0,10);
      const cards=(await q.query('SELECT * FROM memberships')).rows;
      const valid:string[]=[];
      for(const raw of cards){const c=displayCard(raw);if(c.voided_at||c.paused_on)continue;
        const items:{kind:string;day:string;title:string}[]=[];
        if(c.start_date>=last&&c.start_date<=today)items.push({kind:'started',day:c.start_date,title:'会员卡已开始生效'});
        if(c.status==='active'&&c.end_date<=addDays(today,c.kind==='year'?30:7))items.push({kind:'expiring',day:c.end_date,title:'会员卡即将到期'});
        if(c.status==='expired')items.push({kind:'expired',day:addDays(c.end_date,1),title:'会员卡已到期失效'});
        for(const item of items){const key=[item.kind,c.id,c.cycle_id,item.kind==='started'?c.start_date:c.end_date].join(':');valid.push(key);
          await q.query('INSERT INTO notifications(id,member_id,event_key,kind,title,effective_date) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO UPDATE SET obsolete=false',[randomUUID(),c.member_id,key,item.kind,item.title,item.day]);
        }
      }
      // Start reminders stay valid once issued unless the card start date/status changes.
      for(const raw of cards){const c=displayCard(raw);if(!c.voided_at&&c.start_date<=today)valid.push(['started',c.id,c.cycle_id,c.start_date].join(':'));}
      await q.query("UPDATE notifications SET obsolete=true WHERE kind IN ('started','expiring','expired') AND NOT(event_key=ANY($1::text[]))",[valid]);
      for(const c of cards.filter(c=>c.pause_review_required))await q.query("INSERT INTO notifications(id,member_id,event_key,kind,title,effective_date) VALUES($1,$2,$3,'error','旧暂停历史需要核查，退款估算已暂停',$4) ON CONFLICT(event_key) DO NOTHING",[randomUUID(),c.member_id,'pause-review:'+c.id,today]);
      await q.query('UPDATE reminder_state SET checked_date=$1 WHERE id=1',[today]);
    });
  }
  async list(){await this.check();const rows=(await this.db.query("SELECT n.*,m.name,m.card_number FROM notifications n JOIN members m ON m.id=n.member_id WHERE n.read_at IS NULL OR n.read_at>=now()-interval '90 days' ORDER BY (n.read_at IS NULL AND NOT n.obsolete) DESC,n.created_at DESC,n.id DESC")).rows;const unread=(await this.db.query('SELECT count(*)::int AS n FROM notifications WHERE read_at IS NULL AND obsolete=false')).rows[0].n;return {items:rows,unread};}
  async read(id?:string){await this.db.query('UPDATE notifications SET read_at=COALESCE(read_at,now()) WHERE $1::uuid IS NULL OR id=$1',[id||null]);return {ok:true};}
}
