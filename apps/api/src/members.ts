import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthRequest } from './auth.js';
import { Db, Queryable } from './db.js';
import { cardRemarkRequired, membershipDays, MembershipDurations, statusOf, todayShanghai } from './domain.js';

export async function audit(q:Queryable,action:string,memberId:string|null,detail:unknown,actor='owner') {
  await q.query('INSERT INTO audit_logs(id,member_id,action,actor,detail) VALUES($1,$2,$3,$4,$5)',[randomUUID(),memberId,action,actor,JSON.stringify(detail)]);
  await q.query('UPDATE desktop_state SET data_revision=data_revision+1,updated_at=now() WHERE id=1');
}

export async function membershipDurations(q:Queryable):Promise<MembershipDurations>{
  const row=(await q.query('SELECT month_card_days,year_card_days FROM settings WHERE id=1')).rows[0];
  return {monthCardDays:Number(row.month_card_days),yearCardDays:Number(row.year_card_days)};
}

const date=(value:string|Date)=>value instanceof Date?value.toISOString().slice(0,10):value.slice(0,10);
export function displayCard(card:any) {
  if(!card)return null;
  const normalized={...card,start_date:date(card.start_date),end_date:date(card.end_date)};
  return {...normalized,status:statusOf(normalized)};
}

async function cardEvent(q:Queryable,memberId:string,eventType:string,card:any,selectedKind?:string,remark='',detail:unknown={},durationDays:number|null=null) {
  await q.query(`INSERT INTO membership_events(
    id,member_id,membership_id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,detail,duration_days
  ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[
    randomUUID(),memberId,card.id,eventType,selectedKind||null,card.kind,date(card.start_date),date(card.end_date),
    card.voided_at||null,card.void_reason||null,remark,JSON.stringify(detail),durationDays
  ]);
}

const displayHistory=(rows:any[])=>rows.map(row=>displayCard(row));

export async function insertMember(q:Queryable,input:any) {
  const durations=await membershipDurations(q),durationDays=membershipDays(input.kind,durations);
  if(cardRemarkRequired(input.startDate,input.endDate,input.kind,durations)&&!input.cardRemark)throw new BadRequestException(`期限不是月卡 ${durations.monthCardDays} 天或年卡 ${durations.yearCardDays} 天时，请填写备注`);
  const id=randomUUID(),cardNumber=`GYM${randomBytes(8).toString('hex').toUpperCase()}`,cardId=randomUUID();
  const {rows}=await q.query('INSERT INTO members(id,name,phone,card_number,note) VALUES($1,$2,$3,$4,$5) RETURNING *',[id,input.name,input.phone,cardNumber,input.note||'']);
  const card=(await q.query('INSERT INTO memberships(id,member_id,kind,start_date,end_date) VALUES($1,$2,$3,$4,$5) RETURNING *',[cardId,id,input.kind,input.startDate,input.endDate])).rows[0];
  await cardEvent(q,id,'opened',card,input.kind,input.cardRemark,{},durationDays);
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
      (SELECT count(*)::int FROM memberships WHERE voided_at IS NULL AND start_date<=$1 AND end_date>=$1) AS active,
      (SELECT count(*)::int FROM memberships WHERE voided_at IS NULL AND start_date<=$1 AND end_date>=$1
        AND ((kind='year' AND end_date<=$1::date+30) OR (kind='month' AND end_date<=$1::date+7))) AS expiring,
      (SELECT count(*)::int FROM memberships WHERE voided_at IS NULL AND end_date<$1) AS expired`,[today]);
    return rows[0];
  }

  async list(input:{search?:string;status?:string;endFrom?:string;endTo?:string;expiring?:boolean;page:number;pageSize:number}) {
    const values:any[]=[todayShanghai()],conditions:string[]=[];
    if(input.search) {
      values.push(`%${input.search.replace(/[\\%_]/g,'\\$&')}%`);
      conditions.push(`(m.name ILIKE $${values.length} OR m.phone LIKE $${values.length} OR m.card_number ILIKE $${values.length})`);
    }
    const cardConditions:string[]=['c.member_id=m.id'];
    if(input.status)cardConditions.push({active:'c.voided_at IS NULL AND c.start_date<=$1 AND c.end_date>=$1',upcoming:'c.voided_at IS NULL AND c.start_date>$1',expired:'c.voided_at IS NULL AND c.end_date<$1',voided:'c.voided_at IS NOT NULL'}[input.status]!);
    if(input.endFrom){values.push(input.endFrom);cardConditions.push(`c.end_date>=$${values.length}::date`);}
    if(input.endTo){values.push(input.endTo);cardConditions.push(`c.end_date<=$${values.length}::date`);}
    if(input.expiring)cardConditions.push(`c.voided_at IS NULL AND c.start_date<=$1 AND c.end_date>=$1 AND ((c.kind='year' AND c.end_date<=$1::date+30) OR (c.kind='month' AND c.end_date<=$1::date+7))`);
    if(cardConditions.length>1)conditions.push(`EXISTS(SELECT 1 FROM memberships c WHERE ${cardConditions.join(' AND ')})`);
    const where=`WHERE $1::date IS NOT NULL ${conditions.length?'AND '+conditions.join(' AND '):''}`;
    const total=(await this.db.query(`SELECT count(*)::int AS n FROM members m ${where}`,values)).rows[0].n;
    const {rows}=await this.db.query(`SELECT m.id,m.name,m.phone,m.card_number,m.note,m.version,m.created_at,m.updated_at,
      (SELECT to_jsonb(c) FROM memberships c WHERE c.member_id=m.id) AS card
      FROM members m ${where} ORDER BY m.created_at DESC,m.id LIMIT $${values.length+1} OFFSET $${values.length+2}`,[...values,input.pageSize,(input.page-1)*input.pageSize]);
    return {total,items:rows.map(member=>({...member,card:displayCard(member.card)}))};
  }

  async detail(id:string) {
    const {rows}=await this.db.query('SELECT m.id,m.name,m.phone,m.card_number,m.note,m.version,m.created_at,m.updated_at FROM members m WHERE id=$1',[id]);
    if(!rows[0])throw new NotFoundException('会员不存在');
    const card=(await this.db.query('SELECT * FROM memberships WHERE member_id=$1',[id])).rows[0];
    const history=await this.db.query(`SELECT id,event_type,selected_kind,kind,start_date,end_date,voided_at,void_reason,remark,duration_days,created_at
      FROM membership_events WHERE member_id=$1 ORDER BY created_at DESC,id DESC`,[id]);
    return {...rows[0],card:displayCard(card),cardHistory:displayHistory(history.rows)};
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
      const current=displayCard(before)!,today=todayShanghai(),unexpired=!before.voided_at&&current.end_date>=today;
      if(unexpired&&input.startDate!==current.start_date)throw new BadRequestException('未到期续卡必须保持原开始日期，确保有效期连续');
      if(unexpired&&input.endDate<=current.end_date)throw new BadRequestException('续卡后的到期日期必须晚于当前到期日期');
      const renewalBase=unexpired?current.end_date:input.startDate;
      const durations=await membershipDurations(q),durationDays=membershipDays(input.kind,durations);
      if(cardRemarkRequired(renewalBase,input.endDate,input.kind,durations)&&!input.remark)throw new BadRequestException(`续卡期限不是月卡 ${durations.monthCardDays} 天或年卡 ${durations.yearCardDays} 天时，请填写备注`);
      const kind=unexpired&&before.kind==='year'?'year':input.kind;
      const after=(await q.query(`UPDATE memberships SET kind=$2,start_date=$3,end_date=$4,voided_at=NULL,void_reason=NULL,
        version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,[before.id,kind,input.startDate,input.endDate])).rows[0];
      await cardEvent(q,memberId,'renewed',after,input.kind,input.remark,{before:current},durationDays);
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
      if(before.voided_at)throw new ConflictException('已作废会员卡请通过续卡重新启用');
      const current=displayCard(before)!;
      if((input.startDate!==current.start_date||input.endDate!==current.end_date)&&!input.remark)throw new BadRequestException('修改会员卡日期时必须填写备注');
      const after=(await q.query('UPDATE memberships SET kind=$2,start_date=$3,end_date=$4,version=version+1,updated_at=now() WHERE id=$1 RETURNING *',[before.id,input.kind,input.startDate,input.endDate])).rows[0];
      await cardEvent(q,memberId,'updated',after,input.kind,input.remark,{before:current});
      await audit(q,'card_updated',memberId,{remark:input.remark,before:current,after:displayCard(after)});
      return displayCard(after);
    });
  }

  async voidCard(memberId:string,reason:string) {
    return this.db.tx(async q=>{
      const before=(await q.query('SELECT * FROM memberships WHERE member_id=$1 FOR UPDATE',[memberId])).rows[0];
      if(!before)throw new NotFoundException('会员卡不存在');
      if(before.voided_at)return {ok:true};
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
