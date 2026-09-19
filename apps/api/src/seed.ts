import './config.js';
import { Db } from './db.js';
import { insertMember } from './members.js';
import { todayShanghai } from './domain.js';
async function seed(){
  if(process.env.NODE_ENV==='production'||process.env.DB_DRIVER==='postgres')throw new Error('Demo seed is restricted to the local development database');
  const db=new Db();await db.onModuleInit();
  try{
    if((await db.query('SELECT 1 FROM members LIMIT 1')).rows.length){console.log('Members already exist; no demo data inserted.');return;}
    const today=todayShanghai(),offset=(n:number)=>new Date(Date.parse(today)+n*86400000).toISOString().slice(0,10);
    const names=['陈嘉宁','林远舟','许知夏','周亦辰','沈安然','陆星野','苏念','江以恒','顾时予','唐可欣','何予安','陆子昂'];
    await db.tx(async q=>{
      await q.query("UPDATE settings SET name='悦体健身',phone='13800000000' WHERE id=1");
      for(let i=0;i<names.length;i++){
        const m=await insertMember(q,{name:names[i],phone:`1390000${String(i+1).padStart(4,'0')}`,kind:i%3===1?'month':'year',startDate:offset(i===5?8:-90),endDate:offset(i===3?-10:i===1?7:i===6?0:120+i*12),note:'演示数据，非真实会员'});
        await q.query('UPDATE members SET theme=$2 WHERE id=$1',[m.id,['gold','blue','orange','white'][i%4]]);
        if(i%3===0)await q.query('INSERT INTO wechat_bindings(openid,member_id) VALUES($1,$2)',[`demo-non-login-openid-${i}`,m.id]);
      }
    });console.log('12 clearly marked demo members created in the local database only.');
  }finally{await db.onModuleDestroy();}
}
seed().catch(e=>{console.error(e.message);process.exit(1);});
