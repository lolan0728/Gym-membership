import {chromium} from '@playwright/test';
import {readFile,mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer as createNetServer} from 'node:net';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const password=process.env.UI_BASE_URL?(await readFile(resolve(root,'.local-credentials.txt'),'utf8')).match(/管理员密码：(.+)/)?.[1]:'Ui-Test-Password-123';
if(!password)throw new Error('Missing UI test password');
await mkdir(resolve(root,'test-results'),{recursive:true});
let apiApp,vite,fixtureDb,historyFixture,uiDataDirectory;
let baseUrl=process.env.UI_BASE_URL;
if(!baseUrl){
  uiDataDirectory=await mkdtemp(resolve(tmpdir(),'joyfit-ui-'));
  Object.assign(process.env,{NODE_ENV:'test',DESKTOP_MODE:'true',DB_DRIVER:'pglite',PGLITE_PATH:'memory://',STORAGE_DRIVER:'local',LOCAL_STORAGE_PATH:resolve(uiDataDirectory,'uploads'),JOYFIT_BACKUP_PATH:resolve(uiDataDirectory,'backups'),JOYFIT_OPERATION_LOG_PATH:resolve(uiDataDirectory,'logs')});
  process.chdir(resolve(root,'apps/api'));
  const {createApp}=await import('../apps/api/dist/main.js');apiApp=await createApp();await apiApp.listen(0,'127.0.0.1');const apiUrl=await apiApp.getUrl();
  const {Db}=await import('../apps/api/dist/db.js');fixtureDb=apiApp.get(Db);
  const {hashPassword}=await import('../apps/api/dist/security.js');const {insertMember}=await import('../apps/api/dist/members.js');const {todayShanghai,addDays}=await import('../apps/api/dist/domain.js');
  await fixtureDb.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1)',[await hashPassword(password)]);
  const today=todayShanghai();
  for(let i=0;i<13;i++)await fixtureDb.tx(q=>insertMember(q,{name:i===12?'暂停流程测试':`测试会员${i+1}`,phone:`1390000${String(i+1).padStart(4,'0')}`,kind:i%2?'month':'year',startDate:addDays(today,-60),endDate:addDays(today,i===2?-5:i===1?3:120+i),note:'仅用于自动化测试',cardRemark:'测试期限'}));

  const fixture=(await fixtureDb.query(`SELECT e.id,e.remark,e.event_type,e.selected_kind,m.card_number FROM membership_events e JOIN members m ON m.id=e.member_id ORDER BY m.created_at DESC,e.created_at DESC LIMIT 1`)).rows[0];
  if(fixture){historyFixture=fixture;await fixtureDb.query("UPDATE membership_events SET remark=$2,event_type='renewed',selected_kind='month' WHERE id=$1",[fixture.id,'这是一条用于检查长备注折叠与展开功能的测试内容。'.repeat(8)]);}
  process.chdir(root);
  const uiPort=await new Promise((resolvePort,reject)=>{const server=createNetServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();const port=typeof address==='object'&&address?address.port:0;server.close(error=>error?reject(error):resolvePort(port));});});
  const {createServer}=await import('vite');vite=await createServer({root:resolve(root,'apps/admin'),server:{host:'127.0.0.1',port:uiPort,strictPort:true,proxy:{'/api':{target:apiUrl,changeOrigin:false}}},logLevel:'silent'});await vite.listen();baseUrl=vite.resolvedUrls.local[0].replace(/\/$/,'');process.env.ADMIN_ORIGIN=baseUrl;
}
assert.equal((await fetch(baseUrl+'/api/health')).status,200,'API must be ready before the browser test');
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--disable-background-mode']});
const page=await browser.newPage({viewport:{width:1440,height:1080},deviceScaleFactor:1});
page.setDefaultTimeout(15000);

const {runDoorTests}=await import('./hikvision-ui-cases.mjs');
try{await runDoorTests(page,baseUrl,password,root,fixtureDb);}catch(e){await page.screenshot({path:resolve(root,'test-results/hikvision-failure.png'),fullPage:true});throw e;}finally{await browser.close();await vite?.close();await apiApp?.close();if(uiDataDirectory)await rm(uiDataDirectory,{recursive:true,force:true});}
