import PDFDocument from 'pdfkit';
import {resolve} from 'node:path';
import type {ReportData} from './reports.js';
import {formatBeijingDateTime} from './time.js';

const labels:Record<string,string>={active:'有效',upcoming:'未生效',expired:'已到期',voided:'已作废',none:'无会员卡'};
const date=(v:string)=>v.replaceAll('-','/');
const kind=(v:string)=>v==='year'?'年卡':'月卡';
export async function renderReportPdf(data:ReportData,type:'members'|'monthly',logo:Buffer):Promise<Buffer>{
  const doc=new PDFDocument({size:'A4',layout:type==='members'?'landscape':'portrait',margin:36,bufferPages:true,info:{Title:type==='members'?'悦体健身全部会员名单':'悦体健身月度经营报表',Author:'JOYFIT'}});
  doc.registerFont('Chinese',resolve(import.meta.dirname,'../assets/fonts/NotoSansCJKsc-Regular.otf'));doc.font('Chinese');
  const chunks:Buffer[]=[];const result=new Promise<Buffer>((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const width=doc.page.width-72;let y=36;
  const text=(value:string,x:number,top:number,w:number,size=10,color='#263c36')=>{doc.font('Chinese').fontSize(size).fillColor(color).text(value,x,top,{width:w,lineGap:3});};
  const header=()=>{
    doc.image(logo,36,30,{fit:[108,40]});
    text(data.storeName+' · JOYFIT / 杭宁府店',156,31,width-120,12);
    text('导出时间：'+formatBeijingDateTime(data.generatedAt)+' 北京时间',156,53,width-120,8,'#65746d');
    doc.moveTo(36,80).lineTo(36+width,80).strokeColor('#015556').lineWidth(1).stroke();y=96;
  };
  const newPage=()=>{doc.addPage();header();};
  const ensure=(height:number)=>{if(y+height>doc.page.height-82)newPage();};
  const paragraph=(value:string,size=10)=>{doc.fontSize(size);const h=doc.heightOfString(value,{width,lineGap:3});ensure(h+12);text(value,36,y,width,size);y+=h+12;};
  const title=(value:string)=>{ensure(42);text(value,36,y,width,17,'#015556');y+=38;};
  const table=(headers:string[],weights:number[],rows:string[][])=>{
    const sum=weights.reduce((a,b)=>a+b,0),widths=weights.map(v=>width*v/sum);
    const drawHeader=()=>{doc.rect(36,y,width,28).fill('#015556');let x=36;headers.forEach((h,i)=>{text(h,x+6,y+7,widths[i]-12,9,'#ffffff');x+=widths[i];});y+=28;};
    ensure(70);drawHeader();
    if(!rows.length)rows=[headers.map((_,i)=>i===0?'暂无符合条件的会员':'')];
    rows.forEach((row,index)=>{
      doc.fontSize(9);const h=Math.max(30,...row.map((v,i)=>doc.heightOfString(v,{width:widths[i]-12,lineGap:3})+14));
      if(y+h>doc.page.height-82){newPage();drawHeader();}
      doc.rect(36,y,width,h).fill(index%2?'#ffffff':'#f1f6f4');let x=36;
      row.forEach((v,i)=>{text(v,x+6,y+7,widths[i]-12,9);x+=widths[i];});y+=h;
    });y+=18;
  };
  header();
  if(type==='members'){
    title('全部会员名单');
    paragraph('全部 '+data.current.total+' 人  ·  有效 '+data.current.active+' 人  ·  未生效 '+data.current.upcoming+' 人  ·  已到期 '+data.current.expired+' 人  ·  已作废 '+data.current.voided+' 人'+(data.current.none?'  ·  无会员卡 '+data.current.none+' 人':''));
    paragraph('包含所有会员，不受列表筛选和分页影响。',9);
    table(['姓名','会员号码','手机号','卡种','开始日期','到期日期','状态'],[1.5,1.8,1.7,.8,1.4,1.4,.8],data.members.map(m=>[m.name,m.card_number,m.phone,m.card?kind(m.card.kind):'-',m.card?date(m.card.start_date):'-',m.card?date(m.card.end_date):'-',labels[m.status]]));
  }else{
    title(date(data.month)+' 月度经营报表');
    paragraph('新增按首次开卡开始日期统计；续卡、作废按办理时间统计。所有月份按北京时间划分。',9);
    const m=data.metrics;
    table(['指标','人数 / 次数','指标','人数 / 次数'],[2,1,2,1],[
      ['新增会员人数',String(m.newMembers),'续卡人数',String(m.renewMembers)],
      ['新办年卡人数',String(m.newYear),'新办月卡人数',String(m.newMonth)],
      ['续卡次数',String(m.renewCount),'作废次数',String(m.voidCount)],
      ['续年卡次数',String(m.renewYear),'续月卡次数',String(m.renewMonth)],
      ['未到期续卡人数',String(m.early),'到期后续卡人数',String(m.late)],
      ['作废后重新开卡人数',String(m.reopened),'未分类续卡次数',String(m.unclassified)]
    ]);
    paragraph('续卡人数按会员去重；次数逐次统计。同一会员可能进入不同续卡时机分类，分类人数不能直接相加。缺少原卡快照的续卡列为未分类。',9);
    paragraph('首次开卡历史不足：'+data.unknownFirst+' 位会员未计入新增统计。首次记录缺失时使用最早迁移卡片记录。已发生的办卡及续卡不会因后续作废而扣减。',9);
    ensure(370);title('最近12个月趋势');
    const max=Math.max(1,...data.trend.flatMap(t=>[t.newMembers,t.renewMembers]));
    text('新增会员',36,y,100,9,'#015556');text('续卡会员',140,y,100,9,'#b67a25');y+=24;
    for(const t of data.trend){
      text(date(t.month),36,y,66,9);
      const start=110,barWidth=width-145;
      doc.rect(start,y+2,barWidth*t.newMembers/max,6).fill('#015556');
      doc.rect(start,y+11,barWidth*t.renewMembers/max,6).fill('#b67a25');
      text(t.newMembers+' / '+t.renewMembers,start+barWidth+8,y,55,8);y+=22;
    }
    newPage();title('当前会员概况与跟进名单');
    paragraph('以下为截至 '+formatBeijingDateTime(data.generatedAt)+' 的当前情况，不是所选月份的月末快照。',9);
    table(['全部会员','有效','未生效','已到期','已作废'],[1,1,1,1,1],[[data.current.total,data.current.active,data.current.upcoming,data.current.expired,data.current.voided].map(String)]);
    paragraph('有效会员：年卡 '+data.current.activeYear+' 人，月卡 '+data.current.activeMonth+' 人。'+(data.current.none?'无会员卡 '+data.current.none+' 人。':''));
    title('即将到期 · '+data.expiring.length+' 人');
    paragraph('仅包含当前有效会员，年卡提前30天、月卡提前7天，包含到期当天。',9);
    const follow=(list:any[],expired=false)=>table(['姓名','会员号码','手机号','卡种','到期日期',expired?'过期天数':'状态'],[1.1,1.55,1.55,.6,1.25,.85],list.map(m=>[m.name,m.card_number,m.phone,kind(m.card.kind),date(m.card.end_date),expired?String(m.expiredDays):'有效']));
    follow(data.expiring);
    title('最近30天已到期未续卡 · '+data.expired.length+' 人');
    paragraph('仅包含当前已到期、未作废的会员；已经续卡的会员不在此名单。',9);follow(data.expired,true);
  }
  const range=doc.bufferedPageRange();
  for(let i=range.start;i<range.start+range.count;i++){
    doc.switchToPage(i);doc.font('Chinese').fontSize(8).fillColor('#71827a').text('JOYFIT · 悦体健身     '+(i+1)+' / '+range.count+' 页',36,doc.page.height-48,{width,align:'center',lineBreak:false});
  }
  doc.end();return result;
}
