import { Injectable, Inject, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { Db } from './db.js';
import { digest } from './security.js';
import { cardRemarkRequired, createMemberSchema } from './domain.js';
import { audit, insertMember, membershipDurations } from './members.js';
import { fromBuffer } from 'yauzl';
export const columns=['姓名','手机号','卡种','开始日期','到期日期','备注','会员档案备注'];
async function inspectZip(buffer:Buffer) {
  await new Promise<void>((resolve,reject)=>fromBuffer(buffer,{lazyEntries:true},(err,zip)=>{
    if(err||!zip)return reject(new BadRequestException('文件不是有效的 .xlsx 工作簿'));
    let size=0,count=0;
    zip.on('error',()=>reject(new BadRequestException('工作簿损坏')));
    zip.on('entry',entry=>{
      size+=entry.uncompressedSize;count++;
      if(size>30*1024*1024||count>300){zip.close();reject(new BadRequestException('工作簿解压后过大，请使用模板分批导入'));return;}
      zip.readEntry();
    });zip.on('end',()=>resolve());zip.readEntry();
  }));
}
@Injectable()
export class ImportsService {
  constructor(@Inject(Db) private db:Db) {}
  async template() {
    const durations=await membershipDurations(this.db);
    const workbook=new ExcelJS.Workbook(),sheet=workbook.addWorksheet('会员导入');
    sheet.addRow(columns);sheet.views=[{state:'frozen',ySplit:1}];
    sheet.getRow(1).font={bold:true,color:{argb:'FFFFFFFF'}};sheet.getRow(1).fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF173F35'}};
    sheet.columns.forEach((c,i)=>{c.width=[18,20,12,18,18,32,32][i];c.numFmt='@';});
    for(let i=2;i<=2001;i++)sheet.getCell(`C${i}`).dataValidation={type:'list',allowBlank:true,formulae:['"年卡,月卡"']};
    sheet.getCell('A1').note=`每行一名会员。日期请填写 YYYY-MM-DD。不要修改表头。最多 2000 名会员。期限偏离月卡 ${durations.monthCardDays} 天或年卡 ${durations.yearCardDays} 天时，必须填写备注。`;
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }
  async preview(buffer:Buffer) {
    if(buffer.length>5*1024*1024)throw new BadRequestException('文件不能超过 5 MB');
    const hash=digest(buffer);
    const existing=(await this.db.query('SELECT * FROM import_batches WHERE file_hash=$1',[hash])).rows[0];
    if(existing?.status==='committed')return this.present(existing);
    await inspectZip(buffer);
    const workbook=new ExcelJS.Workbook();
    try{await workbook.xlsx.load(buffer as any);}catch{throw new BadRequestException('无法读取工作簿，请使用提供的 Excel 模板');}
    if(workbook.worksheets.length!==1)throw new BadRequestException('工作簿必须只有一张会员数据表');
    const sheet=workbook.worksheets[0];
    if(sheet.rowCount>2001||sheet.columnCount>7)throw new BadRequestException('每批最多 2000 名会员，且只允许模板中的 7 列');
    const errors:{row:number;message:string}[]=[],rows:any[]=[],durations=await membershipDurations(this.db);
    const text=(cell:ExcelJS.Cell,row:number)=>{
      if(cell.value instanceof Date)return cell.value.toISOString().slice(0,10);
      if(cell.value===null||cell.value===undefined)return '';
      if(typeof cell.value==='object'){errors.push({row,message:`${cell.address} 不支持公式、链接或富文本`});return '';}
      return String(cell.value).trim();
    };
    if(columns.some((name,i)=>text(sheet.getRow(1).getCell(i+1),1)!==name))throw new BadRequestException('表头与模板不一致，请重新下载模板');
    const phones=new Set<string>();
    for(let i=2;i<=sheet.rowCount;i++){
      const cells=columns.map((_,j)=>text(sheet.getRow(i).getCell(j+1),i));
      if(cells.every(v=>v===''))continue;
      const [name,phone,label,startDate,endDate,cardRemark,note]=cells;
      const parsed=createMemberSchema.safeParse({name,phone,kind:label==='年卡'?'year':label==='月卡'?'month':label,startDate,endDate,cardRemark,note});
      if(!parsed.success){errors.push({row:i,message:parsed.error.issues.map(e=>`${e.path.join('.')}: ${e.message}`).join('；')});continue;}
      if(cardRemarkRequired(parsed.data.startDate,parsed.data.endDate,parsed.data.kind,durations)&&!parsed.data.cardRemark){errors.push({row:i,message:`期限不是月卡 ${durations.monthCardDays} 天或年卡 ${durations.yearCardDays} 天时，请填写备注`});continue;}
      if(phones.has(phone))errors.push({row:i,message:'文件内手机号重复'});
      phones.add(phone);
      rows.push({row:i,...parsed.data});
    }
    if(!rows.length&&!errors.length)errors.push({row:0,message:'文件中没有会员数据'});
    if(rows.length){
      const taken=(await this.db.query('SELECT phone FROM members WHERE phone=ANY($1::text[])',[[...phones]])).rows;
      const existingPhones=new Set(taken.map(m=>m.phone));
      for(const row of rows)if(existingPhones.has(row.phone))errors.push({row:row.row,message:'手机号已存在于系统'});
    }
    const status=errors.length?'invalid':'ready';
    const batch=await this.db.query(`INSERT INTO import_batches(id,file_hash,rows,errors,status) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(file_hash) DO UPDATE SET rows=CASE WHEN import_batches.status='committed' THEN import_batches.rows ELSE EXCLUDED.rows END,
      errors=CASE WHEN import_batches.status='committed' THEN import_batches.errors ELSE EXCLUDED.errors END,
      status=CASE WHEN import_batches.status='committed' THEN 'committed' ELSE EXCLUDED.status END RETURNING *`,[randomUUID(),hash,JSON.stringify(rows),JSON.stringify(errors),status]);
    return this.present(batch.rows[0]);
  }
  async confirm(id:string){
    return this.db.tx(async q=>{
      const batch=(await q.query('SELECT * FROM import_batches WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!batch)throw new NotFoundException('导入批次不存在');
      if(batch.status==='committed')return this.present(batch);
      if(batch.status!=='ready')throw new ConflictException('请先修正所有错误后重新上传');
      for(const row of batch.rows)await insertMember(q,row);
      const updated=(await q.query("UPDATE import_batches SET status='committed',committed_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];
      await audit(q,'import_committed',null,{batchId:id,count:batch.rows.length});return this.present(updated);
    });
  }
  async list(){return (await this.db.query('SELECT id,status,jsonb_array_length(rows) AS count,created_at,committed_at FROM import_batches ORDER BY created_at DESC LIMIT 30')).rows;}
  private present(batch:any){return {id:batch.id,status:batch.status,rows:batch.rows,errors:batch.errors,count:batch.rows.length,committedAt:batch.committed_at};}
}
