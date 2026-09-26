import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {addDays,dateSchema,statusOf,todayShanghai,createMemberSchema,cardRemarkRequired,defaultEndDate,daysBetween,returnEstimate} from '../src/domain.js';
import {formatBeijingDateTime,normalizeExcelDateTime} from '../src/time.js';
import {summarize} from '../src/reports.js';
test('Backup time migration changes only the old default and sets new installs to 13:00',async()=>{
  const db=new PGlite();
  await db.exec("CREATE TABLE backup_settings(id integer PRIMARY KEY,schedule_time varchar(5) NOT NULL DEFAULT '20:00',updated_at timestamptz NOT NULL DEFAULT now()); INSERT INTO backup_settings(id,schedule_time) VALUES(1,'20:00'),(2,'17:30');");
  await db.exec(await readFile(resolve(import.meta.dirname,'../migrations/007_backup_time_1300.sql'),'utf8'));
  await db.exec('INSERT INTO backup_settings(id) VALUES(3)');
  const rows=(await db.query<{id:number;schedule_time:string}>('SELECT id,schedule_time FROM backup_settings ORDER BY id')).rows;
  assert.deepEqual(rows,[{id:1,schedule_time:'13:00'},{id:2,schedule_time:'17:30'},{id:3,schedule_time:'13:00'}]);
  await db.close();
});
test('Beijing dates: end date inclusive and changes exactly at local midnight',()=>{
  const card={start_date:'2026-01-01',end_date:'2026-09-18',voided_at:null};
  assert.equal(statusOf(card,todayShanghai(new Date('2026-09-18T15:59:59Z'))),'active');
  assert.equal(statusOf(card,todayShanghai(new Date('2026-09-18T16:00:00Z'))),'expired');
  assert.equal(statusOf(card,'2025-12-31'),'upcoming');
  assert.equal(statusOf({...card,voided_at:new Date()},'2025-12-31'),'voided');
  assert.equal(statusOf({...card,start_date:'2026-09-18'},'2026-09-18'),'active');
});
test('Pause duration uses natural days and refund uses the unrounded remaining proportion',()=>{
  assert.equal(daysBetween('2026-09-01','2026-10-01'),30);assert.equal(daysBetween('2026-09-01','2026-09-01'),0);
  assert.equal(daysBetween('2024-02-28','2024-03-01'),2);assert.equal(daysBetween('2026-12-31','2027-01-01'),1);
  const month=returnEstimate({kind:'month',start_date:'2026-09-01'},'2026-09-14');
  assert.equal(month.usedDays,13);assert.equal(month.estimatedRefund,57); // 56.1 rounds up to 57.
  assert.equal(returnEstimate({kind:'year',start_date:'2026-01-01'},'2026-01-02').estimatedRefund,498);
  assert.equal(returnEstimate({kind:'month',start_date:'2026-09-01'},'2026-10-01').estimatedRefund,0);
  assert.equal(returnEstimate({kind:'month',start_date:'2026-09-01'},'2026-11-01').estimatedRefund,0);
  assert.equal(returnEstimate({kind:'month',start_date:'2026-10-01'},'2026-09-01').estimatedRefund,99);
  assert.equal(statusOf({start_date:'2026-01-01',end_date:'2026-02-01',voided_at:null,paused_on:'2026-01-15'},'2026-12-01'),'paused');
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
  // The schema validates shape; the service validates the configured month/year duration.
  assert.equal(createMemberSchema.safeParse({name:'测试',phone:'13900000001',kind:'month',startDate:'2026-03-01',endDate:'2026-04-01'}).success,true);
  const parsed=createMemberSchema.parse({name:'测试',phone:'13900000001',kind:'month',startDate:'2026-03-01',endDate:'2026-04-01',cardRemark:'  赠送一天  '});
  assert.equal(parsed.cardRemark,'赠送一天');
});
test('Date-time output is fixed to Beijing 24-hour format',()=>{
  assert.equal(formatBeijingDateTime('2026-09-20T13:35:08Z'),'2026/09/20 21:35:08');
  assert.equal(normalizeExcelDateTime('2026/09/20 21:35:08'),'2026-09-20T21:35:08+08:00');
  assert.equal(normalizeExcelDateTime('2026-09-20T13:35:08.000Z'),'2026-09-20T13:35:08.000Z');
});
test('Monthly report separates first openings, renewal timing and follow-up lists',()=>{
  const now=new Date('2026-09-20T04:00:00Z');
  const members=[
    {id:'m1',name:'年卡会员',phone:'13900000001',card_number:'Y2026090001',card:{kind:'year',start_date:'2026-09-01',end_date:'2026-10-10',voided_at:null}},
    {id:'m2',name:'月卡会员',phone:'13900000002',card_number:'Y2026090002',card:{kind:'month',start_date:'2026-08-01',end_date:'2026-09-19',voided_at:null}}
  ];
  const events=[
    {id:'e1',member_id:'m1',event_type:'opened',kind:'year',selected_kind:'year',start_date:'2026-09-01',created_at:'2026-08-30T02:00:00Z',detail:{}},
    {id:'e2',member_id:'m1',event_type:'renewed',kind:'year',selected_kind:'year',start_date:'2026-09-01',created_at:'2026-09-10T02:00:00Z',detail:{before:{end_date:'2026-09-30',voided_at:null}}},
    {id:'e3',member_id:'m2',event_type:'migrated',kind:'month',selected_kind:'month',start_date:'2026-08-01',created_at:'2026-08-01T02:00:00Z',detail:{}}
  ];
  const result=summarize(members,events,'2026-09',now);
  assert.equal(result.metrics.newMembers,1);assert.equal(result.metrics.newYear,1);
  assert.equal(result.metrics.renewMembers,1);assert.equal(result.metrics.renewCount,1);assert.equal(result.metrics.early,1);
  assert.equal(result.expiring.length,1);assert.equal(result.expiring[0].id,'m1');
  assert.equal(result.expired.length,1);assert.equal(result.expired[0].id,'m2');
});
