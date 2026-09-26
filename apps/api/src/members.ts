import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { AuthRequest } from './auth.js';
import { Db, Queryable } from './db.js';
import { addDays, daysBetween, dateSchema, segmentedReturnEstimate, refundBasis, RefundSegmentInput, cardRemarkRequired, membershipDays, MembershipDurations, statusOf, todayShanghai } from './domain.js';
import { beijingDay, beijingMonth } from './time.js';

export async function audit(q:Queryable,action:string,memberId:string|null,detail:unknown,actor='owner') {
  await q.query('INSERT INTO audit_logs(id,member_id,action,actor,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),memberId,action,actor,JSON.stringify(detail)]);
  await q.query('UPDATE desktop_state SET data_revision=data_revision+1,updated_at=now() WHERE id=1');
}

export async function membershipDurations(q:Queryable):Promise<MembershipDurations>{
  const row=(await q.query('SELECT month_card_days,year_card_days FROM settings WHERE id=1')).rows[0];
  return {monthCardDays:Number(row.month_card_days),yearCardDays:Number(row.year_card_days)};
}

export async function nextMemberNumber(q:Queryable,monthKey=beijingMonth()){
  const {rows}=await q.query(`INSERT INTO member_number_sequences(month_key,last_value) VALUES($1,1)
    ON CONFLICT(month_key) DO UPDATE SET last_value=member_number_sequences.last_value+1
    WHERE member_number_sequences.last_value<9999 RETURNING last_value`,[monthKey]);
  if(!rows[0])throw new ConflictException(`${monthKey.slice(0,4)}年${monthKey.slice(4)}月会员数量已达到 9999 人，无法继续生成会员号码`);
  return `Y${monthKey}${String(rows[0].last_value).padStart(4,'0')}`;
}

const date=(value:string|Date)=>value instanceof Date?value.toISOString().slice(0,10):value.slice(0,10);
export function displayCard(card:any) {
  if(!card)return null;
  const normalized={...card,start_date:date(card.start_date),end_date:date(card.end_date),...(card.paused_on?{paused_on:date(card.paused_on)}:{})};
  return {...normalized,status:statusOf(normalized)};
}

type BillingSnapshot={kind:'year'|'month';grantedDays:number};
export async function cardEvent(q:Queryable,memberId:string,eventType:string,card:any,selectedKind?:string,remark='',detail:unknown={},durationDays:number|null=null,billing?:BillingSnapshot) {
  const basis=billing?refundBasis(billing.kind):null,giftDays=billing?Math.max(0,billing.grantedDays-basis!.basisDays):null;
  await q.query(`INSERT INTO membership_events(
    id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,detail,duration_days,
    cycle_id,refund_basis_days,refund_price,granted_days,gift_days
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[
    randomUUID(),memberId,card.id,eventType,selectedKind||null,card.kind,date(card.start_date),date(card.end_date),
    card.voided_at||null,card.void_reason||null,remark,JSON.stringify(detail),durationDays,card.cycle_id||null,
    basis?.basisDays??null,basis?.price??null,billing?.grantedDays??null,giftDays
  ]);
}

const displayHistory=(rows:any[])=>rows.map(row=>displayCard(row));

export async function insertMember(q:Queryable,input:any) {
  const durations=await membershipDurations(q),durationDays=membershipDays(input.kind,durations);
  if(cardRemarkRequired(input.startDate,input.endDate,input.kind,durations)&&!input.cardRemark)throw new BadRequestException(`期限不是月卡 ${durations.monthCardDays} 天或年卡 ${durations.yearCardDays} 天时，请填写备注`);
  const id=randomUUID(),cardNumber=await nextMemberNumber(q),cardId=randomUUID();
  const {rows}=await q.query('INSERT INTO members(id,name,phone,card_number,note) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,input.name,input.phone,cardNumber,input.note||'']);
  const card=(await q.query('INSERT INTO memberships(id,member_id,kind,start_date,end_date) VALUES($1,$2,$3,$4,$5) RETURNING *',[cardId,id,input.kind,input.startDate,input.endDate])).rows[0];
  await cardEvent(q,id,'opened',card,input.kind,input.cardRemark,{},durationDays,{kind:input.kind,grantedDays:Math.max(0,daysBetween(input.startDate,input.endDate))});
  await audit(q,'member_created',id,{name:input.name,phone:input.phone,note:input.note||'',kind:input.kind,startDate:input.startDate,endDate:input.endDate,cardRemark:input.cardRemark,cardNumber,durationDays});
  return rows[0];
}

@Injectable()
export class MembersService {
  constructor(@Inject(Db) private db:Db) {}

  async stats() {
    const today=todayShanghai();
    const {rows}=await this.db.query(`SELECT
      (SELECT count(*)::int FROM members) AS total,
      (SELECT count(*)::int FROM memberships WHERE voided_at IS NULL AND paused_on IS NULL AND start_date<=$1 AND end_date>=$1) AS active,
      (SELECT count(*)::int FROM memberships WHERE voided_at IS NULL AND paused_on IS NULL AND start_date<=$1 AND end_date>=$1
        AND ((kind='year' AND end_date<=$1::date+30) OR (kind='month' AND end_date<=$1::date+7))) AS expiring,
      (SELECT count(*)::int FROM memberships WHERE voided_at IS NULL AND paused_on IS NULL AND end_date<$1) AS expired,
      (SELECT count(*)::int FROM memberships WHERE paused_on IS NOT NULL AND voided_at IS NULL) AS paused`,[today]);
    return rows[0];
  }

  async list(input:{search?:string;status?:string;endFrom?:string;endTo?:string;expiring?:boolean;page:number;pageSize:number}) {
    const values:any[]=[todayShanghai()],conditions:string[]=[];
    if(input.search) {
      values.push(`%${input.search.replace(/[\\%_]/g,'\\$&')}%`);
      conditions.push(`(m.name ILIKE $${values.length} OR m.phone LIKE $${values.length} OR m.card_number ILIKE $${values.length})`);
    }
    const cardConditions:string[]=['c.member_id=m.id'];
    if(input.status)cardConditions.push({active:'c.voided_at IS NULL AND c.paused_on IS NULL AND c.start_date<=$1 AND c.end_date>=$1',upcoming:'c.voided_at IS NULL AND c.paused_on IS NULL AND c.start_date>$1',expired:'c.voided_at IS NULL AND c.paused_on IS NULL AND c.end_date<$1',voided:'c.voided_at IS NOT NULL AND c.returned_at IS NULL',returned:'c.returned_at IS NOT NULL',paused:'c.paused_on IS NOT NULL AND c.voided_at IS NULL'}[input.status]!);
    if(input.endFrom){values.push(input.endFrom);cardConditions.push(`c.end_date>=$${values.length}::date`);}
    if(input.endTo){values.push(input.endTo);cardConditions.push(`c.end_date<=$${values.length}::date`);}
    if(input.expiring)cardConditions.push(`c.voided_at IS NULL AND c.paused_on IS NULL AND c.start_date<=$1 AND c.end_date>=$1 AND ((c.kind='year' AND c.end_date<=$1::date+30) OR (c.kind='month' AND c.end_date<=$1::date+7))`);
    if(cardConditions.length>1)conditions.push(`EXISTS(SELECT 1 FROM memberships c WHERE ${cardConditions.join(' AND ')})`);
    const where=`WHERE $1::date IS NOT NULL ${conditions.length?'AND '+conditions.join(' AND '):''}`;
    const total=(await this.db.query(`SELECT count(*)::int AS n FROM members m ${where}`,values)).rows[0].n;
    const {rows}=await this.db.query(`SELECT m.id,m.name,m.phone,m.card_number,m.note,m.avatar_key,m.version,m.created_at,m.updated_at,
      (SELECT to_jsonb(c) FROM memberships c WHERE c.member_id=m.id) AS card
      FROM members m ${where} ORDER BY m.created_at DESC,m.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.pageSize,(input.page-1)*input.pageSize]);
    return {total,items:rows.map(member=>({...member,card:displayCard(member.card)}))};
  }

  async detail(id:string) {
    const {rows}=await this.db.query('SELECT m.id,m.name,m.phone,m.card_number,m.note,m.avatar_key,m.version,m.created_at,m.updated_at FROM members m WHERE id=$1',[id]);
    if(!rows[0])throw new NotFoundException('会员不存在');
    const card=(await this.db.query('SELECT * FROM memberships WHERE member_id=$1',[id])).rows[0];
    const history=await this.db.query(`SELECT id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,duration_days,detail,created_at
      FROM membership_events WHERE member_id=$1 ORDER BY created_at DESC,id DESC`,[id]);
    const appointments=(await this.db.query("SELECT * FROM card_appointments WHERE member_id=$1 AND status IN ('pending','failed') ORDER BY effective_date,action",[id])).rows;
    return {...rows[0],card:displayCard(card),appointments:appointments.map(a=>({...a,effective_date:date(a.effective_date)})),cardHistory:displayHistory(history.rows)};
  }

  create(input:any) {return this.db.tx(q=>insertMember(q,input));}

  async update(id:string,input:any) {
    return this.db.tx(async q=>{
      const before=(await q.query('SELECT * FROM members WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!before)throw new NotFoundException('会员不存在');
      if(before.version!==input.version)throw new ConflictException('资料已被更新，请刷新后重试');
      const {rows}=await q.query('UPDATE members SET name=$2,phone=$3,note=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[id,input.name,input.phone,input.note]);
      await audit(q,'member_updated',id,{before:{name:before.name,phone:before.phone,note:before.note},after:input});
      return rows[0];
    });
  }

  async renewCard(memberId:string,input:any) {
    return this.db.tx(async q=>{
      if(!(await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[memberId])).rows[0])throw new NotFoundException('会员不存在');
      const before=(await q.query('SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
      if(!before)throw new NotFoundException('会员卡不存在');
      if(before.version!==input.version)throw new ConflictException('会员卡已更新，请刷新后重试');
      await this.noAppointments(q,memberId);
      if(before.paused_on)throw new ConflictException('会员卡暂停中，请先恢复再续卡');
      const current=displayCard(before)!,today=todayShanghai(),unexpired=!before.voided_at&&current.end_date>=today;
      if(unexpired&&input.startDate!==current.start_date)throw new BadRequestException('未到期续卡必须保持原开始日期，确保有效期连续');
      if(unexpired&&input.endDate<=current.end_date)throw new BadRequestException('续卡后的到期日期必须晚于当前到期日期');
      const renewalBase=unexpired?current.end_date:input.startDate;
      const durations=await membershipDurations(q),durationDays=membershipDays(input.kind,durations);
      if(cardRemarkRequired(renewalBase,input.endDate,input.kind,durations)&&!input.remark)throw new BadRequestException(`续卡期限不是月卡 ${durations.monthCardDays} 天或年卡 ${durations.yearCardDays} 天时，请填写备注`);
      const kind=unexpired&&before.kind==='year'?'year':input.kind;
      const after=(await q.query(`UPDATE memberships SET kind=$2,start_date=$3,end_date=$4,voided_at=NULL,void_reason=NULL,returned_at=NULL,
        cycle_id=CASE WHEN $5 THEN cycle_id ELSE gen_random_uuid() END,pause_review_required=CASE WHEN $5 THEN pause_review_required ELSE false END,
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[before.id,kind,input.startDate,input.endDate,unexpired])).rows[0];
      await cardEvent(q,memberId,'renewed',after,input.kind,input.remark,{before:current},durationDays,{kind:input.kind,grantedDays:Math.max(0,daysBetween(renewalBase,input.endDate))});
      await audit(q,'card_renewed',memberId,{selectedKind:input.kind,durationDays,remark:input.remark,before:current,after:displayCard(after)});
      return displayCard(after);
    });
  }

  async updateCard(memberId:string,input:any) {
    return this.db.tx(async q=>{
      if(!(await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[memberId])).rows[0])throw new NotFoundException('会员不存在');
      const before=(await q.query('SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
      if(!before)throw new NotFoundException('会员卡不存在');
      if(before.version!==input.version)throw new ConflictException('会员卡已更新，请刷新后重试');
      await this.noAppointments(q,memberId);
      if(before.voided_at)throw new ConflictException('已退卡或历史作废的会员卡请通过续卡重新启用');
      if(before.paused_on)throw new ConflictException('会员卡暂停中，请先恢复再修改');
      const current=displayCard(before)!;
      if((input.startDate!==current.start_date||input.endDate!==current.end_date)&&!input.remark)throw new BadRequestException('修改会员卡日期时必须填写备注');
      const after=(await q.query('UPDATE memberships SET kind=$2,start_date=$3,end_date=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[before.id,input.kind,input.startDate,input.endDate])).rows[0];
      await cardEvent(q,memberId,'updated',after,input.kind,input.remark,{before:current});
      await audit(q,'card_updated',memberId,{remark:input.remark,before:current,after:displayCard(after)});
      return displayCard(after);
    });
  }

  async noAppointments(q:Queryable,id:string){
    if((await q.query("SELECT 1 FROM card_appointments WHERE member_id=$1 AND status='pending'",[id])).rows.length)throw new ConflictException('请先取消待执行预约，再办理此操作');
  }

  async pauseCard(memberId:string,input:{remark:string;version:number;date?:string}){
    return this.db.tx(async q=>{
      const card=await this.lockCard(q,memberId,input.version),effective=input.date||todayShanghai();
      await this.noAppointments(q,memberId);await this.checkPause(q,card,effective);
      if(effective>todayShanghai()){
        const id=randomUUID();await q.query("INSERT INTO card_appointments(id,member_id,action,effective_date,remark) VALUES($1,$2,'pause',$3,$4)",[id,memberId,effective,input.remark]);
        await audit(q,'pause_scheduled',memberId,{date:effective,remark:input.remark});return {scheduled:true,id};
      }
      return this.applyPause(q,card,effective,input.remark);
    });
  }
  private async checkPause(q:Queryable,card:any,effective:string){
    if(card.voided_at||card.paused_on)throw new ConflictException('会员卡已停用或暂停');
    if(effective<date(card.start_date)||effective>date(card.end_date))throw new BadRequestException('暂停日期必须在会员卡有效期内');
    if(card.pause_review_required)throw new ConflictException('旧暂停历史异常，请先核查，无法办理暂停');
    if((await q.query('SELECT 1 FROM pause_intervals WHERE member_id=$1 AND cycle_id=$2 AND (end_date IS NULL OR end_date>$3::date)',[card.member_id,card.cycle_id,effective])).rows.length)throw new ConflictException('暂停日期不能早于上一段暂停的恢复日期');
  }
  private async applyPause(q:Queryable,before:any,effective:string,remark:string){
    await this.checkPause(q,before,effective);
    await q.query('INSERT INTO pause_intervals(id,member_id,cycle_id,start_date,remark) VALUES($1,$2,$3,$4,$5)',[randomUUID(),before.member_id,before.cycle_id,effective,remark]);
    const after=(await q.query('UPDATE memberships SET paused_on=$2,pause_count=pause_count+1,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[before.id,effective])).rows[0];
    const detail={pausedOn:effective,pauseNumber:after.pause_count,before:displayCard(before)};
    await cardEvent(q,before.member_id,'paused',after,undefined,remark,detail);await audit(q,'card_paused',before.member_id,{...detail,remark});return displayCard(after);
  }
  async resumeCard(memberId:string,input:{version:number;asOf?:string;date?:string}){
    return this.db.tx(async q=>{
      const before=await this.lockCard(q,memberId,input.version),effective=input.date||input.asOf||todayShanghai();
      if(!input.date&&input.asOf!==todayShanghai())throw new ConflictException('日期已变化，请重新打开恢复窗口后确认');
      const pending=(await q.query("SELECT * FROM card_appointments WHERE member_id=$1 AND status='pending'",[memberId])).rows;
      if(pending.some(r=>r.action==='resume'))throw new ConflictException('已有恢复预约，请修改现有预约');
      const parent=pending.find(r=>r.action==='pause'),pausedOn=before.paused_on?date(before.paused_on):parent?.effective_date;
      if(!pausedOn||before.voided_at)throw new ConflictException('会员卡未暂停，也没有暂停预约');
      if(effective<date(pausedOn))throw new BadRequestException('恢复日期不能早于暂停日期');
      if(effective>todayShanghai()){
        const id=randomUUID();await q.query("INSERT INTO card_appointments(id,member_id,action,effective_date,parent_id) VALUES($1,$2,'resume',$3,$4)",[id,memberId,effective,parent?.id||null]);
        await audit(q,'resume_scheduled',memberId,{date:effective});return {scheduled:true,id};
      }
      return this.applyResume(q,before,effective);
    });
  }
  private async applyResume(q:Queryable,before:any,effective:string){
    if(!before.paused_on||before.voided_at)throw new ConflictException('会员卡未暂停，无法恢复');
    const pausedOn=date(before.paused_on),pausedDays=daysBetween(pausedOn,effective);
    if(pausedDays<0)throw new BadRequestException('恢复日期不能早于暂停日期');
    const originalEnd=date(before.end_date),endDate=addDays(originalEnd,pausedDays);
    if(!dateSchema.safeParse(endDate).success)throw new BadRequestException('恢复后的到期日期超出支持范围');
    const interval=await q.query('UPDATE pause_intervals SET end_date=$2 WHERE member_id=$1 AND end_date IS NULL RETURNING id',[before.member_id,effective]);
    if(interval.rows.length!==1)throw new ConflictException('暂停历史异常，请联系管理员核查');
    const after=(await q.query('UPDATE memberships SET paused_on=NULL,end_date=$2,total_paused_days=total_paused_days+$3,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[before.id,endDate,pausedDays])).rows[0];
    const detail={pausedOn,resumedOn:effective,pausedDays,originalEnd,endDate,pauseNumber:before.pause_count};
    await cardEvent(q,before.member_id,'resumed',after,undefined,'',detail);await audit(q,'card_resumed',before.member_id,detail);return displayCard(after);
  }
  async appointment(memberId:string,id:string,input:{date?:string;remark?:string;cancel?:boolean}){
    return this.db.tx(async q=>{
      await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[memberId]);
      const row=(await q.query("SELECT * FROM card_appointments WHERE id=$1 AND member_id=$2 AND status IN ('pending','failed') FOR UPDATE",[id,memberId])).rows[0];
      if(!row)throw new ConflictException('预约已执行或已取消，请刷新');
      if(input.cancel){await q.query("UPDATE card_appointments SET status='cancelled',updated_at=now() WHERE id=$1 OR (parent_id=$1 AND status='pending')",[id]);}
      else{
        if(row.status!=='pending')throw new ConflictException('失败预约请取消后重新办理');
        const effective=input.date!;if(effective<=todayShanghai())throw new BadRequestException('修改预约请选择未来日期；立即办理请取消预约后重新操作');
        const card=(await q.query('SELECT * FROM memberships WHERE member_id=$1',[memberId])).rows[0];
        if(row.action==='pause'){
          await this.checkPause(q,card,effective);
          const child=(await q.query("SELECT effective_date FROM card_appointments WHERE parent_id=$1 AND status='pending'",[id])).rows[0];
          if(child&&effective>date(child.effective_date))throw new BadRequestException('暂停日期不能晚于预约恢复日期');
          if(!input.remark?.trim())throw new BadRequestException('请填写暂停备注');
        }else{
          const parent=row.parent_id?(await q.query('SELECT effective_date FROM card_appointments WHERE id=$1',[row.parent_id])).rows[0]:null;
          if(effective<date(card.paused_on||parent?.effective_date))throw new BadRequestException('恢复日期不能早于暂停日期');
        }
        await q.query('UPDATE card_appointments SET effective_date=$2,remark=$3,updated_at=now() WHERE id=$1',[id,effective,input.remark||row.remark]);
      }
      await audit(q,input.cancel?'appointment_cancelled':'appointment_updated',memberId,{id,...input});return {ok:true};
    });
  }
  async executeAppointment(id:string){
    return this.db.tx(async q=>{
      const item=(await q.query('SELECT * FROM card_appointments WHERE id=$1',[id])).rows[0];if(!item)return;
      await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[item.member_id]);
      const row=(await q.query("SELECT * FROM card_appointments WHERE id=$1 AND status='pending' FOR UPDATE",[id])).rows[0];if(!row||date(row.effective_date)>todayShanghai())return;
      const card=(await q.query('SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE',[row.member_id])).rows[0];
      if(row.parent_id&&(await q.query('SELECT status FROM card_appointments WHERE id=$1',[row.parent_id])).rows[0]?.status!=='completed')throw new ConflictException('关联暂停预约尚未成功执行，请核查');
      if(row.action==='pause')await this.applyPause(q,card,date(row.effective_date),row.remark);else await this.applyResume(q,card,date(row.effective_date));
      await q.query("UPDATE card_appointments SET status='completed',updated_at=now() WHERE id=$1",[id]);
      await q.query("INSERT INTO notifications(id,member_id,event_key,kind,title,effective_date) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(event_key) DO NOTHING",[randomUUID(),row.member_id,'appointment:'+id,row.action,row.action==='pause'?'预约暂停已执行':'预约恢复已执行',row.effective_date]);
    });
  }
  async refund(q:Queryable,card:any,asOf=todayShanghai()){
    if(card.pause_review_required)throw new ConflictException('旧暂停历史异常，请先核查，暂时无法估算退款');
    const intervals=(await q.query('SELECT start_date,end_date FROM pause_intervals WHERE member_id=$1 AND cycle_id=$2 ORDER BY start_date',[card.member_id,card.cycle_id])).rows;
    let days=0,last=date(card.start_date);
    for(const p of intervals){const start=[date(p.start_date),date(card.start_date),last].sort().at(-1)!,end=p.end_date&&date(p.end_date)<asOf?date(p.end_date):asOf;if(end>start){days+=daysBetween(start,end);last=end;}}
    const events=(await q.query(`SELECT id,event_type,selected_kind,kind,start_date,end_date,detail,created_at,
      refund_basis_days,refund_price,granted_days,gift_days FROM membership_events WHERE member_id=$1 ORDER BY created_at,id`,[card.member_id])).rows;
    let segments:RefundSegmentInput[]=[];
    for(const event of events){
      const detail=typeof event.detail==='string'?JSON.parse(event.detail||'{}'):event.detail||{};
      if(['opened','migrated','renewed'].includes(event.event_type)){
        const before=detail.before||{},operationDay=beijingDay(event.created_at);
        const startsCycle=event.event_type!=='renewed'||!!before.voided_at||(before.end_date&&date(before.end_date)<operationDay);
        if(startsCycle)segments=[];
        const kind=(event.selected_kind||event.kind) as 'year'|'month',basis=refundBasis(kind);
        const inferred=event.event_type==='renewed'&&before.end_date&&!startsCycle
          ?Math.max(0,daysBetween(date(before.end_date),date(event.end_date)))
          :Math.max(0,daysBetween(date(event.start_date),date(event.end_date)));
        const granted=event.granted_days===null||event.granted_days===undefined?inferred:Number(event.granted_days);
        const paidDays=Number(event.refund_basis_days)||basis.basisDays;
        segments.push({id:event.id,source:event.event_type as RefundSegmentInput['source'],kind,paidDays,
          grantedDays:granted,giftDays:Math.max(0,granted-paidDays),price:Number(event.refund_price)||basis.price});
      }else if(event.event_type==='updated'&&segments.length&&detail.before){
        const first=segments[0],last=segments.at(-1)!;
        const startDelta=daysBetween(date(event.start_date),date(detail.before.start_date));
        const endDelta=daysBetween(date(detail.before.end_date),date(event.end_date));
        first.grantedDays=Math.max(0,first.grantedDays+startDelta);first.giftDays=Math.max(0,first.grantedDays-first.paidDays);
        last.grantedDays=Math.max(0,last.grantedDays+endDelta);last.giftDays=Math.max(0,last.grantedDays-last.paidDays);
      }
    }
    if(!segments.length){
      const kind=card.kind as 'year'|'month',basis=refundBasis(kind),granted=Math.max(0,daysBetween(date(card.start_date),date(card.end_date))-Number(card.total_paused_days||0));
      segments=[{id:card.id,source:'migrated',kind,paidDays:basis.basisDays,grantedDays:granted,giftDays:Math.max(0,granted-basis.basisDays),price:basis.price}];
    }
    return segmentedReturnEstimate(displayCard(card),segments,asOf,days);
  }

  private async lockCard(q:Queryable,memberId:string,version:number){
    if(!(await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[memberId])).rows[0])throw new NotFoundException('会员不存在');
    const before=(await q.query('SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
    if(!before)throw new NotFoundException('会员卡不存在');
    if(before.version!==version)throw new ConflictException('会员卡已更新，请刷新后重试');
    return before;
  }

  async returnQuote(memberId:string){
    const card=(await this.db.query('SELECT * FROM memberships WHERE member_id=$1',[memberId])).rows[0];
    if(!card)throw new NotFoundException('会员卡不存在');
    if(card.voided_at)throw new ConflictException('会员卡已退卡或已作废');
    await this.noAppointments(this.db,memberId);return {...await this.refund(this.db,card),version:card.version};
  }

  async returnCard(memberId:string,input:{reason:string;version:number;asOf:string}){
    return this.db.tx(async q=>{
      const before=await this.lockCard(q,memberId,input.version),today=todayShanghai();
      if(input.asOf!==today)throw new ConflictException('日期已变化，请重新打开退卡窗口核对金额');
      if(before.voided_at)throw new ConflictException('会员卡已退卡或已作废');
      await this.noAppointments(q,memberId);const quote=await this.refund(q,before,today);
      await q.query('UPDATE pause_intervals SET end_date=$2 WHERE member_id=$1 AND end_date IS NULL',[memberId,today]);
      const after=(await q.query('UPDATE memberships SET voided_at=now(),returned_at=now(),void_reason=$2,paused_on=NULL,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[before.id,input.reason])).rows[0];
      const detail={before:displayCard(before),refund:quote};
      await cardEvent(q,memberId,'returned',after,undefined,input.reason,detail);
      await audit(q,'card_returned',memberId,{...detail,reason:input.reason});return {card:displayCard(after),refund:quote};
    });
  }

  async voidCard(memberId:string,reason:string) {
    return this.db.tx(async q=>{
      const before=(await q.query('SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
      if(!before)throw new NotFoundException('会员卡不存在');
      if(before.voided_at)return {ok:true};
      await this.noAppointments(q,memberId);if(before.paused_on)throw new ConflictException('会员卡暂停中，请先恢复');
      const after=(await q.query('UPDATE memberships SET voided_at=now(),void_reason=$2,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[before.id,reason])).rows[0];
      await cardEvent(q,memberId,'voided',after,undefined,'',{before:displayCard(before),reason});
      await audit(q,'card_voided',memberId,{before:displayCard(before),after:displayCard(after),reason});
      return {ok:true};
    });
  }

  async resetBinding(id:string,reason:string) {
    return this.db.tx(async q=>{
      if(!(await q.query('SELECT id FROM members WHERE id=$1 FOR UPDATE',[id])).rows.length)throw new NotFoundException('会员不存在');
      const {rows}=await q.query('DELETE FROM wechat_bindings WHERE member_id=$1 RETURNING openid',[id]);
      if(rows[0])await q.query('DELETE FROM sessions WHERE openid=$1',[rows[0].openid]);
      await audit(q,'binding_reset',id,{reason});return {ok:true};
    });
  }

  async bind(auth:AuthRequest['auth'],phone:string) {
    return this.db.tx(async q=>{
      if(!(await q.query('SELECT token_hash FROM sessions WHERE token_hash=$1 AND expires_at>now() FOR UPDATE',[auth.tokenHash])).rows.length)throw new UnauthorizedException('登录已失效，请重新登录');
      const existing=(await q.query('SELECT member_id FROM wechat_bindings WHERE openid=$1',[auth.openid])).rows[0];
      if(existing)return {bound:true};
      const {rows}=await q.query('SELECT id FROM members WHERE phone=$1 FOR UPDATE',[phone]);
      if(!rows[0])throw new ForbiddenException('未找到可领取的会员卡，请联系前台核实登记手机号');
      if((await q.query('SELECT 1 FROM wechat_bindings WHERE member_id=$1',[rows[0].id])).rows.length)throw new ConflictException('未找到可领取的会员卡，请联系前台核实绑定信息');
      await q.query('INSERT INTO wechat_bindings(openid,member_id) VALUES($1,$2)',[auth.openid,rows[0].id]);
      await audit(q,'wechat_bound',rows[0].id,{},'member');return {bound:true};
    });
  }

  async me(id:string) {
    const {rows}=await this.db.query('SELECT id,name,card_number,theme,avatar_key FROM members WHERE id=$1',[id]);
    if(!rows[0])throw new NotFoundException('会员不存在');
    const card=(await this.db.query('SELECT id,kind,start_date,end_date,voided_at,void_reason,version FROM memberships WHERE member_id=$1',[id])).rows[0];
    const history=await this.db.query(`SELECT id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,created_at
      FROM membership_events WHERE member_id=$1 ORDER BY created_at DESC,id DESC`,[id]);
    return {...rows[0],card:displayCard(card),cardHistory:displayHistory(history.rows)};
  }
}
