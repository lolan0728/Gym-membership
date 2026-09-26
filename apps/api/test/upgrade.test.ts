import 'reflect-metadata';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {btree_gist} from '@electric-sql/pglite/contrib/btree_gist';
import {Db} from '../src/db.js';

test('v1.2.2 upgrade preserves all existing business fields and takes a restorable snapshot once',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'joyfit-upgrade-')),path=join(dir,'database');
  const old=new PGlite(path,{extensions:{btree_gist}});
  let db:Db|undefined;
  try{
    await old.exec('CREATE TABLE schema_migrations(version integer PRIMARY KEY)');
    const migrations=resolve(import.meta.dirname,'../migrations');
    for(const file of (await readdir(migrations)).filter(x=>/^00[1-7]_/.test(x)).sort()){
      await old.exec(await readFile(join(migrations,file),'utf8'));
      await old.query('INSERT INTO schema_migrations VALUES($1)',[Number(file.slice(0,3))]);
    }
    await old.exec(`INSERT INTO administrators VALUES(1,'existing-password-hash',now());
      INSERT INTO members(id,name,phone,card_number,note) VALUES('10000000-0000-4000-8000-000000000001','真实使用前的升级样本','13900000101','Y2026090042','保留内部备注');
      INSERT INTO memberships(id,member_id,kind,start_date,end_date) VALUES('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','year','2026-09-01','2027-09-01');
      INSERT INTO membership_events(id,member_id,membership_id,event_type,kind,start_date,end_date,remark,detail) VALUES('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','opened','year','2026-09-01','2027-09-01','原备注','{"legacy":true}');
      UPDATE backup_settings SET schedule_time='17:30';
      INSERT INTO member_number_sequences VALUES('202609',42);`);
    const tables=['members','memberships','membership_events','administrators','settings','backup_settings','member_number_sequences'];
    const before=new Map<string,any[]>();for(const table of tables)before.set(table,(await old.query('SELECT * FROM '+table)).rows);
    await old.close();
    process.env.DESKTOP_MODE='true';process.env.DB_DRIVER='pglite';process.env.PGLITE_PATH=path;
    db=new Db();await db.onModuleInit();
    for(const table of tables){
      const columns=Object.keys(before.get(table)![0]).join(',');
      assert.deepEqual((await db.query('SELECT '+columns+' FROM '+table)).rows,before.get(table),`${table} must be unchanged`);
    }
    assert.deepEqual((await db.query('SELECT paused_on,pause_count,total_paused_days,returned_at FROM memberships')).rows,[{paused_on:null,pause_count:0,total_paused_days:0,returned_at:null}]);
    const snapshots=await readdir(join(dir,'upgrade-backups'));assert.equal(snapshots.length,1);
    const snapshot=new PGlite({loadDataDir:new Blob([new Uint8Array(await readFile(join(dir,'upgrade-backups',snapshots[0])))]),extensions:{btree_gist}});
    try{assert.deepEqual((await snapshot.query('SELECT * FROM members')).rows,before.get('members'));assert.equal((await snapshot.query('SELECT max(version) AS n FROM schema_migrations')).rows[0]!.n,7);}finally{await snapshot.close();}
    await db.onModuleDestroy();db=new Db();await db.onModuleInit();
    assert.equal((await readdir(join(dir,'upgrade-backups'))).length,1,'Second launch does not repeat upgrade or backup');
  }finally{await db?.onModuleDestroy();if(!old.closed)await old.close();await rm(dir,{recursive:true,force:true});}
});


test('v1.3 pause history migrates without changing cards; malformed history is flagged',async()=>{
  const db=new PGlite({extensions:{btree_gist}}),directory=resolve(import.meta.dirname,'../migrations');
  try{
    for(const file of (await readdir(directory)).filter(x=>/^00[1-8]_/.test(x)).sort())await db.exec(await readFile(join(directory,file),'utf8'));
    for(const [n,detail]of [[1,{pausedOn:'2026-08-01',resumedOn:'2026-08-31'}],[2,{pausedOn:'2026-99-01',resumedOn:'2026-99-31'}]] as const){
      const member='10000000-0000-4000-8000-00000000000'+n,card='20000000-0000-4000-8000-00000000000'+n,event='30000000-0000-4000-8000-00000000000'+n;
      await db.query('INSERT INTO members(id,name,phone,card_number) VALUES($1,$2,$3,$4)',[member,'升级样本'+n,'1390000000'+n,'Y202609000'+n]);
      await db.query("INSERT INTO memberships(id,member_id,kind,start_date,end_date,pause_count,total_paused_days) VALUES($1,$2,'year','2026-07-01','2027-07-31',1,30)",[card,member]);
      await db.query("INSERT INTO membership_events(id,member_id,membership_id,event_type,kind,start_date,end_date,detail) VALUES($1,$2,$3,'resumed','year','2026-07-01','2027-07-31',$4)",[event,member,card,JSON.stringify(detail)]);
    }
    const before=(await db.query('SELECT id,start_date,end_date,pause_count,total_paused_days FROM memberships ORDER BY id')).rows;
    await db.exec(await readFile(join(directory,'009_schedules_avatars_notifications.sql'),'utf8'));
    assert.deepEqual((await db.query('SELECT id,start_date,end_date,pause_count,total_paused_days FROM memberships ORDER BY id')).rows,before);
    assert.deepEqual((await db.query('SELECT pause_review_required FROM memberships ORDER BY id')).rows,[{pause_review_required:false},{pause_review_required:true}]);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM pause_intervals')).rows[0]!.n,1);
  }finally{await db.close();}
});
