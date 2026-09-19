import {test} from 'node:test';
import assert from 'node:assert/strict';
import {addDays,dateSchema,statusOf,todayShanghai,createMemberSchema,cardRemarkRequired,defaultEndDate} from '../src/domain.js';
test('Beijing dates: end date inclusive and changes exactly at local midnight',()=>{
  const card={start_date:'2026-01-01',end_date:'2026-09-18',voided_at:null};
  assert.equal(statusOf(card,todayShanghai(new Date('2026-09-18T15:59:59Z'))),'active');
  assert.equal(statusOf(card,todayShanghai(new Date('2026-09-18T16:00:00Z'))),'expired');
  assert.equal(statusOf(card,'2025-12-31'),'upcoming');
  assert.equal(statusOf({...card,voided_at:new Date()},'2025-12-31'),'voided');
  assert.equal(statusOf({...card,start_date:'2026-09-18'},'2026-09-18'),'active');
});
test('Calendar validation rejects non-dates, rollover dates, invalid phone and reversed periods',()=>{
  assert.equal(dateSchema.safeParse('2024-02-29').success,true);
  for(const date of ['2026-02-29','2026-04-31','2026-13-01','2026-1-1'])assert.equal(dateSchema.safeParse(date).success,false);
  const input={name:'测试',phone:'13900000000',kind:'year',startDate:'2026-01-01',endDate:'2027-01-01'};
  assert.equal(createMemberSchema.safeParse(input).success,true);
  assert.equal(createMemberSchema.safeParse({...input,endDate:'2025-12-31'}).success,false);
  assert.equal(createMemberSchema.safeParse({...input,phone:'12345678901'}).success,false);
});
test('Membership duration uses exact calendar-day addition',()=>{
  assert.equal(addDays('2026-09-19',30),'2026-10-19');
  assert.equal(addDays('2026-09-19',365),'2027-09-19');
  assert.equal(addDays('2024-02-29',365),'2025-02-28');
  assert.equal(defaultEndDate('2026-03-01','month'),'2026-03-31');
  assert.equal(cardRemarkRequired('2026-03-01','2026-03-31','month'),false);
  assert.equal(cardRemarkRequired('2026-03-01','2026-04-01','month'),true);
  assert.equal(createMemberSchema.safeParse({name:'测试',phone:'13900000001',kind:'month',startDate:'2026-03-01',endDate:'2026-04-01'}).success,false);
  const parsed=createMemberSchema.parse({name:'测试',phone:'13900000001',kind:'month',startDate:'2026-03-01',endDate:'2026-04-01',cardRemark:'  赠送一天  '});
  assert.equal(parsed.cardRemark,'赠送一天');
});
