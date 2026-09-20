import {chromium} from '@playwright/test';
import {readFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createServer as createNetServer} from 'node:net';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const credentials=await readFile(resolve(root,'.local-credentials.txt'),'utf8');
const password=credentials.match(/管理员密码：(.+)/)?.[1];
if(!password)throw new Error('Run npm run setup:local first');
await mkdir(resolve(root,'test-results'),{recursive:true});
let apiApp,vite,fixtureDb,historyFixture;
let baseUrl=process.env.UI_BASE_URL;
if(!baseUrl){
  process.chdir(resolve(root,'apps/api'));
  const {createApp}=await import('../apps/api/dist/main.js');apiApp=await createApp();await apiApp.listen(0,'127.0.0.1');const apiUrl=await apiApp.getUrl();
  const {Db}=await import('../apps/api/dist/db.js');fixtureDb=apiApp.get(Db);
  const fixture=(await fixtureDb.query(`SELECT e.id,e.remark,e.event_type,e.selected_kind,m.card_number FROM membership_events e JOIN members m ON m.id=e.member_id ORDER BY m.created_at DESC,e.created_at DESC LIMIT 1`)).rows[0];
  if(fixture){historyFixture=fixture;await fixtureDb.query("UPDATE membership_events SET remark=$2,event_type='renewed',selected_kind='month' WHERE id=$1",[fixture.id,'这是一条用于检查长备注折叠与展开功能的测试内容。'.repeat(8)]);}
  process.chdir(root);
  const uiPort=await new Promise((resolvePort,reject)=>{const server=createNetServer();server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();const port=typeof address==='object'&&address?address.port:0;server.close(error=>error?reject(error):resolvePort(port));});});
  const {createServer}=await import('vite');vite=await createServer({root:resolve(root,'apps/admin'),server:{host:'127.0.0.1',port:uiPort,strictPort:true,proxy:{'/api':{target:apiUrl,changeOrigin:false}}},logLevel:'silent'});await vite.listen();baseUrl=vite.resolvedUrls.local[0].replace(/\/$/,'');process.env.ADMIN_ORIGIN=baseUrl;
}
assert.equal((await fetch(baseUrl+'/api/health')).status,200,'API must be ready before the browser test');
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL||'chrome',headless:true,args:['--disable-background-mode']});
const page=await browser.newPage({viewport:{width:1440,height:1080},deviceScaleFactor:1});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
page.on('response',r=>{if(r.url().includes('/api/')&&r.status()>=400&&!(r.url().endsWith('/admin/session')&&r.status()===401))errors.push(`${r.status()} ${new URL(r.url()).pathname}`);});
try{
  await page.goto(baseUrl);await page.getByRole('heading',{name:'欢迎回到悦体健身'}).waitFor();
  assert.equal(await page.title(),'悦体健身 · JOYFIT 会员管理');
  const loginLogo=page.getByAltText('悦体健身 JOYFIT').first();await loginLogo.waitFor();const loginLogoBox=await loginLogo.boundingBox();assert.ok(loginLogoBox&&loginLogoBox.width/loginLogoBox.height>2,'Horizontal JOYFIT logo must not be square-cropped');
  await page.screenshot({path:resolve(root,'test-results/login.png'),fullPage:true});
  await page.getByPlaceholder('输入你的管理员密码').fill(password);await page.getByRole('button',{name:'进入工作台'}).click();
  await page.getByRole('heading',{name:'会员管理',exact:true}).waitFor();
  await page.getByText('杭宁府店',{exact:true}).waitFor();
  assert.equal(await page.locator('.sidebar .nav-count').count(),0,'Sidebar must not show a member-count badge');
  assert.equal(await page.getByPlaceholder('全部卡种').count(),0,'Member search must not include a card-kind filter');
  await page.locator('.members-table .member-identity').first().waitFor();
  const allMembersText=await page.locator('.table-footer>span').innerText();
  await page.getByRole('button',{name:/及时关注续卡/}).click();
  await page.getByText('当前筛选：即将到期（年卡 30 天、月卡 7 天）',{exact:true}).waitFor();
  await page.getByRole('button',{name:'查看全部会员',exact:true}).click();
  await page.getByText('当前筛选：即将到期（年卡 30 天、月卡 7 天）',{exact:true}).waitFor({state:'hidden'});
  await page.locator('.table-footer>span').filter({hasText:allMembersText}).waitFor();
  assert.equal(await page.locator('.table-footer>span').innerText(),allMembersText,'Clearing the expiry filter must restore the full member list');
  const monthBadge=page.locator('.members-table .kind-badge.month').first(),yearBadge=page.locator('.members-table .kind-badge.year').first();await monthBadge.waitFor();await yearBadge.waitFor();
  assert.equal(await monthBadge.evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(1, 85, 86)');assert.equal(await yearBadge.evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(27, 33, 31)');
  const activeStatus=page.locator('.members-table .member-status.active').first();await activeStatus.waitFor();
  assert.equal(await activeStatus.evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(33, 128, 74)');assert.equal(await activeStatus.evaluate(element=>getComputedStyle(element).color),'rgb(255, 255, 255)');
  const expiredStatus=page.locator('.members-table .member-status.expired').first();await expiredStatus.waitFor();assert.equal(await expiredStatus.evaluate(element=>getComputedStyle(element).backgroundColor),'rgb(107, 114, 128)');
  await page.screenshot({path:resolve(root,'test-results/admin-dashboard.png'),fullPage:true});
  for(const [kind,color] of [['month','rgb(1, 85, 86)'],['year','rgb(27, 33, 31)']]){
    const row=page.locator('.members-table tbody tr').filter({has:page.locator(`.kind-badge.${kind}`)}).first();await row.click();const card=page.locator(`.member-card.kind-${kind}`);await card.waitFor();const cardBackground=await card.evaluate(element=>getComputedStyle(element).backgroundImage);assert.ok(cardBackground.includes(color));assert.notEqual(await card.locator('.card-status').evaluate(element=>getComputedStyle(element).backgroundColor),'rgba(0, 0, 0, 0)');if(kind==='year'){assert.ok(cardBackground.includes('radial-gradient'));assert.equal(await card.evaluate(element=>getComputedStyle(element).borderColor),'rgb(168, 141, 78)');}await page.locator('.el-drawer__close-btn').click();
  }
  if(historyFixture){await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill(historyFixture.card_number);const fixtureRow=page.locator('.members-table tbody tr').filter({hasText:historyFixture.card_number});await fixtureRow.waitFor();await fixtureRow.click();await page.getByText('续月卡',{exact:true}).waitFor();assert.equal(await page.locator('.history-record .kind-badge').count(),0);const remark=page.locator('.history-record .event-remark').first(),remarkText=remark.locator('span');await remarkText.waitFor();assert.ok((await remarkText.innerText()).startsWith('备注：'));assert.equal(await remark.evaluate(element=>getComputedStyle(element).fontSize),'11px');assert.ok(await remarkText.evaluate(element=>element.classList.contains('collapsed')));await remark.getByRole('button',{name:'展开全部'}).click();assert.equal(await remarkText.evaluate(element=>element.classList.contains('collapsed')),false);await remark.getByRole('button',{name:'收起'}).click();assert.ok(await remarkText.evaluate(element=>element.classList.contains('collapsed')));await page.screenshot({path:resolve(root,'test-results/member-history.png'),fullPage:true});await page.locator('.el-drawer__close-btn').click();await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('');await page.locator('.members-table .member-identity').first().waitFor();}
  const activeRow=page.locator('.members-table tbody tr').filter({has:page.locator('.member-status.active')}).first();await activeRow.click();
  assert.equal(await page.getByRole('tab',{name:'操作记录'}).count(),0,'Audit logs must remain hidden from the member detail drawer');
  const actions=page.locator('.record-actions .el-button');assert.equal(await actions.first().innerText(),'作废会员卡');assert.match(await actions.first().evaluate(element=>getComputedStyle(element).backgroundColor),/rgb\(199, 53, 61\)/);assert.equal(await actions.nth(1).innerText(),'修改卡片');
  await page.getByRole('button',{name:'办理续卡',exact:true}).click();
  await page.getByText('原到期日期',{exact:true}).waitFor();await page.getByText('新到期日期',{exact:true}).waitFor();await page.locator('.el-dialog:visible').getByText('备注（选填）',{exact:true}).waitFor();
  assert.ok(await page.getByText('原到期日期',{exact:true}).locator('..').locator('input').isDisabled());
  const dateControlWidths=await page.locator('.el-dialog:visible .card-date-control').evaluateAll(elements=>elements.map(element=>Math.round(element.getBoundingClientRect().width)));assert.equal(dateControlWidths.length,3);assert.equal(new Set(dateControlWidths).size,1,'Start, original expiry and new expiry controls must have equal widths');
  await page.screenshot({path:resolve(root,'test-results/renewal.png'),fullPage:true});
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.el-drawer__close-btn').click();
  // Exercise real read/write UI against the local database, restoring the changed field afterwards.
  await page.locator('.members-table .member-identity').first().click();await page.getByRole('tab',{name:'会员资料'}).click();
  await page.getByRole('button',{name:'编辑会员资料'}).click();
  const note=page.getByPlaceholder('补充长期需要留意的信息');const old=await note.inputValue();await note.fill(old+'\n浏览器测试');await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.getByText('会员资料已更新',{exact:true}).waitFor();
  await page.getByRole('button',{name:'编辑会员资料'}).click();await note.fill(old);await page.getByRole('button',{name:'保存修改',exact:true}).click();
  await page.getByRole('tab',{name:'会员卡记录'}).click();
  await page.locator('.record-card').first().waitFor();assert.match(await page.locator('.record-card>p').first().innerText(),/\d{4}\/\d{2}\/\d{2}/);
  await page.locator('.el-message').last().waitFor({state:'hidden'}).catch(()=>{});
  await page.screenshot({path:resolve(root,'test-results/member-detail.png'),fullPage:true});
  await page.locator('.el-drawer__close-btn').click();
  await page.locator('.sidebar nav button').filter({hasText:'统计报表'}).click();await page.getByRole('heading',{name:'统计报表',exact:true}).waitFor();await page.getByRole('heading',{name:'最近 12 个月趋势'}).waitFor();assert.equal(await page.locator('.trend-item').count(),12);await page.getByText(/即将到期 \d+/).first().waitFor();await page.screenshot({path:resolve(root,'test-results/reports.png'),fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'批量导入'}).click();await page.getByRole('heading',{name:'导入会员档案'}).waitFor();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载模板',exact:true}).click();const file=await download;await file.saveAs(resolve(root,'test-results/会员导入模板.xlsx'));
  await page.screenshot({path:resolve(root,'test-results/import.png'),fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'系统设置'}).click();await page.getByRole('heading',{name:'门店与会员卡设置',exact:true}).waitFor();
  await page.screenshot({path:resolve(root,'test-results/settings.png'),fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'会员管理'}).click();await page.getByRole('button',{name:'新增会员',exact:true}).first().click();
  await page.getByRole('dialog').waitFor();assert.equal(await page.getByText('原有卡号（选填）').count(),0);await page.locator('.el-dialog:visible').getByText('备注（选填）',{exact:true}).waitFor();await page.getByText('会员档案备注',{exact:true}).waitFor();
  const newMemberEnd=page.getByPlaceholder('选择到期日期');const originalEnd=await newMemberEnd.inputValue();const customEnd=new Date(`${originalEnd}T00:00:00Z`);customEnd.setUTCDate(customEnd.getUTCDate()+1);await newMemberEnd.fill(customEnd.toISOString().slice(0,10));await newMemberEnd.press('Enter');await page.locator('.el-dialog:visible').getByText('备注 *',{exact:true}).waitFor();
  await page.screenshot({path:resolve(root,'test-results/new-member.png'),fullPage:true});await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('不存在的会员-UI');await page.getByText('没有找到匹配的会员',{exact:true}).waitFor();
  await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('');await page.locator('.members-table .member-identity').first().waitFor();
  await page.setViewportSize({width:1024,height:900});await page.screenshot({path:resolve(root,'test-results/tablet.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false,'Page must fit the viewport');
  await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('heading',{name:'欢迎回到悦体健身'}).waitFor();
  assert.deepEqual(errors,[]);console.log('Browser checks passed: sidebar count removed, PDF report dashboard, void action styling, card status, renewal history, responsive layout, logout.');
}finally{await browser.close();if(historyFixture&&fixtureDb)await fixtureDb.query('UPDATE membership_events SET remark=$2,event_type=$3,selected_kind=$4 WHERE id=$1',[historyFixture.id,historyFixture.remark,historyFixture.event_type,historyFixture.selected_kind]);await vite?.close();await apiApp?.close();}
