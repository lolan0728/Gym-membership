import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
export function todayShanghai(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
}
export function statusOf(card: { start_date: string; end_date: string; voided_at: unknown }, today = todayShanghai()) {
  return card.voided_at ? 'voided' : today < card.start_date ? 'upcoming' : today > card.end_date ? 'expired' : 'active';
}
export function addDays(date: string, days: number) {
  const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);
}
export interface MembershipDurations { monthCardDays:number; yearCardDays:number }
export const defaultMembershipDurations:MembershipDurations={monthCardDays:30,yearCardDays:365};
export const membershipDays=(kind:'year'|'month',durations:MembershipDurations=defaultMembershipDurations)=>kind==='year'?durations.yearCardDays:durations.monthCardDays;
export const defaultEndDate=(baseDate:string,kind:'year'|'month',durations:MembershipDurations=defaultMembershipDurations)=>addDays(baseDate,membershipDays(kind,durations));
export const cardRemarkRequired=(baseDate:string,endDate:string,kind:'year'|'month',durations:MembershipDurations=defaultMembershipDurations)=>endDate!==defaultEndDate(baseDate,kind,durations);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/,'日期须为 YYYY-MM-DD').refine(value => {
  const d = new Date(`${value}T00:00:00Z`); return !isNaN(d.getTime()) && d.toISOString().slice(0,10) === value && value >= '1900-01-01' && value <= '2199-12-31';
},'日期无效');
export const cardFields = { kind: z.enum(['year','month']), startDate: dateSchema, endDate: dateSchema };
export const cardRemarkSchema=z.string().trim().max(500,'备注不能超过 500 字').default('');
export const cardSchema = z.object(cardFields).strict().refine(v=>v.endDate >= v.startDate,{message:'到期日期不能早于开始日期',path:['endDate']});
export const memberFields = { name:z.string().trim().min(1).max(50),phone:z.string().regex(/^1[3-9]\d{9}$/,'请输入 11 位中国大陆手机号'),note:z.string().max(2000).default('') };
export const createMemberSchema = z.object({...memberFields,...cardFields,cardRemark:cardRemarkSchema}).strict()
  .refine(v=>v.endDate>=v.startDate,{message:'到期日期不能早于开始日期',path:['endDate']});
export const updateMemberSchema = z.object({...memberFields,version:z.number().int().positive()}).strict();
export const uuidSchema = z.string().uuid();
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value); if (!result.success) throw new BadRequestException(result.error.issues.map(e=>`${e.path.join('.')}: ${e.message}`).join('；'));
  return result.data;
}
