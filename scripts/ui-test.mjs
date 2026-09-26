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
  assert.equal(await page.locator('.page-heading').getByRole('button',{name:'导入会员',exact:true}).count(),0,'Member page must not duplicate the batch-import entry');
  assert.equal(await page.locator('.sidebar .nav-count').count(),0,'Sidebar must not show a member-count badge');
  assert.equal(await page.getByPlaceholder('全部卡种').count(),0,'Member search must not include a card-kind filter');
  await page.locator('.members-table .member-identity').first().waitFor();
  await page.getByText(/每页 12 位/).waitFor();
  const compactRowHeight=await page.locator('.members-table tbody tr').first().evaluate(element=>Math.round(element.getBoundingClientRect().height));assert.ok(compactRowHeight<=62,`Member rows should remain compact, got ${compactRowHeight}px`);
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
    const row=page.locator('.members-table tbody tr').filter({has:page.locator(`.kind-badge.${kind}`)}).first();await row.click();const card=page.locator(`.member-card.kind-${kind}`);await card.waitFor();const cardBackground=await card.evaluate(element=>getComputedStyle(element).backgroundImage);assert.ok(cardBackground.includes(color));assert.notEqual(await card.locator('.card-status').evaluate(element=>getComputedStyle(element).backgroundColor),'rgba(0, 0, 0, 0)');if(kind==='year'){assert.ok(cardBackground.includes('radial-gradient'));assert.equal(await card.evaluate(element=>getComputedStyle(element).borderColor),'rgb(168, 141, 78)');}await page.locator('.el-drawer__close-btn:visible').click();
  }
  if(historyFixture){await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill(historyFixture.card_number);const fixtureRow=page.locator('.members-table tbody tr').filter({hasText:historyFixture.card_number});await fixtureRow.waitFor();await fixtureRow.click();await page.getByText('续月卡',{exact:true}).waitFor();assert.equal(await page.locator('.history-record .kind-badge').count(),0);const remark=page.locator('.history-record .event-remark').first(),remarkText=remark.locator('span');await remarkText.waitFor();assert.ok((await remarkText.innerText()).startsWith('备注：'));assert.equal(await remark.evaluate(element=>getComputedStyle(element).fontSize),'11px');assert.ok(await remarkText.evaluate(element=>element.classList.contains('collapsed')));await remark.getByRole('button',{name:'展开全部'}).click();assert.equal(await remarkText.evaluate(element=>element.classList.contains('collapsed')),false);await remark.getByRole('button',{name:'收起'}).click();assert.ok(await remarkText.evaluate(element=>element.classList.contains('collapsed')));await page.screenshot({path:resolve(root,'test-results/member-history.png'),fullPage:true});await page.locator('.el-drawer__close-btn:visible').click();await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('');await page.locator('.members-table .member-identity').first().waitFor();}
  const activeRow=page.locator('.members-table tbody tr').filter({has:page.locator('.member-status.active')}).first();await activeRow.click();
  assert.equal(await page.getByRole('tab',{name:'操作记录'}).count(),0,'Audit logs must remain hidden from the member detail drawer');
  const actions=page.locator('.record-actions .el-button');assert.equal(await actions.first().innerText(),'退卡');assert.match(await actions.first().evaluate(element=>getComputedStyle(element).backgroundColor),/rgb\(199, 53, 61\)/);assert.equal(await actions.last().innerText(),'修改卡片');
  await page.getByRole('button',{name:'办理续卡',exact:true}).click();
  await page.getByText('原到期日期',{exact:true}).waitFor();await page.getByText('新到期日期',{exact:true}).waitFor();await page.locator('.el-dialog:visible').getByText('备注（选填）',{exact:true}).waitFor();
  assert.ok(await page.getByText('原到期日期',{exact:true}).locator('..').locator('input').isDisabled());
  const dateControlWidths=await page.locator('.el-dialog:visible .card-date-control').evaluateAll(elements=>elements.map(element=>Math.round(element.getBoundingClientRect().width)));assert.equal(dateControlWidths.length,3);assert.equal(new Set(dateControlWidths).size,1,'Start, original expiry and new expiry controls must have equal widths');
  await page.screenshot({path:resolve(root,'test-results/renewal.png'),fullPage:true});
  await page.getByRole('button',{name:'取消',exact:true}).click();await page.locator('.el-drawer__close-btn:visible').click();
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
  await page.locator('.el-drawer__close-btn:visible').click();
  await page.locator('.sidebar nav button').filter({hasText:'统计报表'}).click();await page.getByRole('heading',{name:'统计报表',exact:true}).waitFor();await page.getByRole('heading',{name:'最近 12 个月趋势'}).waitFor();assert.equal(await page.locator('.trend-item').count(),12);await page.getByText(/即将到期 \d+/).first().waitFor();await page.screenshot({path:resolve(root,'test-results/reports.png'),fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'批量导入'}).click();await page.getByRole('heading',{name:'导入会员档案'}).waitFor();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'下载模板',exact:true}).click();const file=await download;await file.saveAs(resolve(root,'test-results/会员导入模板.xlsx'));
  await page.screenshot({path:resolve(root,'test-results/import.png'),fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'系统设置'}).click();await page.getByRole('heading',{name:'门店与会员卡设置',exact:true}).waitFor();
  const smtpRow=page.locator('.smtp-credential-row');await smtpRow.waitFor();const smtpInput=smtpRow.locator('input');const smtpButton=smtpRow.getByRole('button',{name:'发送测试邮件',exact:true});await smtpButton.waitFor();
  const smtpBox=await smtpInput.boundingBox(),smtpButtonBox=await smtpButton.boundingBox();assert.ok(smtpBox&&smtpBox.width<=480,'SMTP credential field should have a moderate desktop width');assert.ok(smtpButtonBox&&smtpBox&&smtpButtonBox.x>smtpBox.x+smtpBox.width,'Test-email button should sit immediately after the credential field');
  const backupButtons=page.locator('.backup-primary-actions').getByRole('button');assert.deepEqual(await backupButtons.allInnerTexts(),['立即完整备份','从完整备份恢复']);const backupBoxes=await backupButtons.evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().y));assert.equal(new Set(backupBoxes.map(Math.round)).size,1,'Backup and restore buttons must share one row');
  assert.equal(await page.getByRole('button',{name:'手动导出',exact:true}).count(),0,'Manual export entry must be removed');
  assert.match(await page.getByPlaceholder('至少 8 位，可使用纯数字').getAttribute('placeholder'),/至少 8 位/);
  await page.screenshot({path:resolve(root,'test-results/settings.png'),fullPage:true});
  await page.locator('.sidebar nav button').filter({hasText:'会员管理'}).click();await page.getByRole('button',{name:'新增会员',exact:true}).first().click();
  await page.getByRole('dialog').waitFor();assert.equal(await page.getByText('原有卡号（选填）').count(),0);await page.locator('.el-dialog:visible').getByText('备注（选填）',{exact:true}).waitFor();await page.getByText('会员档案备注',{exact:true}).waitFor();
  const newMemberEnd=page.getByPlaceholder('选择到期日期');const originalEnd=await newMemberEnd.inputValue();const customEnd=new Date(`${originalEnd}T00:00:00Z`);customEnd.setUTCDate(customEnd.getUTCDate()+1);await newMemberEnd.fill(customEnd.toISOString().slice(0,10));await newMemberEnd.press('Enter');await page.locator('.el-dialog:visible').getByText('备注 *',{exact:true}).waitFor();
  await page.screenshot({path:resolve(root,'test-results/new-member.png'),fullPage:true});await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('不存在的会员-UI');await page.getByText('没有找到匹配的会员',{exact:true}).waitFor();
  await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('');await page.locator('.members-table .member-identity').first().waitFor();
  await page.setViewportSize({width:1024,height:900});await page.screenshot({path:resolve(root,'test-results/tablet.png'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth);assert.equal(overflow,false,'Page must fit the viewport');

  if(fixtureDb){
    await page.setViewportSize({width:1400,height:900});
    const captureLifecycle=async name=>{
      await page.waitForFunction(()=>document.querySelectorAll('.el-message').length===0);
      await page.waitForFunction(()=>!document.querySelector('[class*="dialog-fade-enter"], [class*="dialog-fade-leave"]'));
      await page.screenshot({path:resolve(root,`test-results/${name}.png`),fullPage:true,animations:'disabled'});
    };
    await page.getByPlaceholder('搜索姓名、手机号或会员号码').fill('暂停流程测试');
    await page.getByRole('button',{name:/日期提醒/}).click();await page.getByRole('heading',{name:'日期提醒',exact:true}).waitFor();await page.locator('.reminder-item').first().waitFor();await page.screenshot({path:resolve(root,'test-results/date-reminders.png'),fullPage:true,animations:'disabled'});await page.locator('.reminder-item').first().click();await page.getByRole('dialog',{name:'日期提醒',exact:true}).waitFor({state:'hidden'});await page.getByRole('heading',{name:'会员详情',exact:true}).waitFor();await page.locator('.el-drawer__close-btn:visible').click();
    const lifecycleRow=page.locator('.members-table tbody tr').filter({hasText:'暂停流程测试'});await lifecycleRow.waitFor();await lifecycleRow.click();
    await page.getByRole('tab',{name:'会员资料'}).click();await page.getByRole('button',{name:'编辑会员资料'}).click();
    const sharp=(await import('sharp')).default;const imageBytes=await sharp({create:{width:640,height:480,channels:3,background:'#015556'}}).png().toBuffer();
    await page.locator('.avatar-editor input[type=file]').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:imageBytes});
    await page.getByRole('heading',{name:'裁剪会员头像',exact:true}).waitFor();await page.locator('.avatar-crop').waitFor();await page.screenshot({path:resolve(root,'test-results/avatar-crop.png'),fullPage:true,animations:'disabled'});await page.getByRole('button',{name:'使用此头像',exact:true}).click();
    await page.getByRole('button',{name:'保存修改',exact:true}).click();await page.locator('.detail-heading img.member-avatar').waitFor();await page.getByRole('tab',{name:'会员卡记录'}).click();
    await page.getByRole('button',{name:'暂停会员卡',exact:true}).click();const tomorrow=new Date();tomorrow.setDate(tomorrow.getDate()+1);const {addDays,todayShanghai}=await import('../apps/api/dist/domain.js');const future=addDays(todayShanghai(),1);
    const bookingDialog=page.locator('.lifecycle-dialog:visible');await bookingDialog.getByPlaceholder('暂停开始日期').fill(future.replaceAll('-','/'));await bookingDialog.getByPlaceholder('暂停开始日期').press('Enter');await bookingDialog.getByPlaceholder('请说明暂停原因').fill('预约测试');await bookingDialog.getByRole('button',{name:'确认暂停',exact:true}).click();await bookingDialog.waitFor({state:'hidden'});await page.locator('.appointment-item').waitFor();
    await page.getByRole('button',{name:'修改预约',exact:true}).click();await bookingDialog.getByPlaceholder('暂停开始日期').fill(addDays(future,1).replaceAll('-','/'));await bookingDialog.getByPlaceholder('暂停开始日期').press('Enter');await bookingDialog.getByRole('button',{name:'确认暂停',exact:true}).click();await bookingDialog.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'取消预约',exact:true}).click();await page.locator('.el-message-box').getByRole('button',{name:'确定',exact:true}).click();await page.locator('.appointment-item').waitFor({state:'hidden'});

    await page.getByRole('button',{name:'暂停会员卡',exact:true}).click();const lifecycle=page.locator('.lifecycle-dialog:visible');
    await lifecycle.getByText('该会员已经暂停过 0 次，本次为第 1 次。',{exact:true}).waitFor();
    await lifecycle.getByRole('button',{name:'确认暂停',exact:true}).click();await page.getByText('请填写暂停备注',{exact:true}).waitFor();
    await lifecycle.getByPlaceholder('请说明暂停原因').fill('出差一个月，返回后恢复');
    await captureLifecycle('card-pause');
    await lifecycle.getByRole('button',{name:'确认暂停',exact:true}).click();await lifecycle.waitFor({state:'hidden'});
    await page.locator('.pause-summary').waitFor();assert.ok(await page.getByRole('button',{name:'办理续卡',exact:true}).isDisabled());
    await page.getByRole('button',{name:'恢复会员卡',exact:true}).click();await lifecycle.getByRole('button',{name:'确认恢复',exact:true}).waitFor();await captureLifecycle('card-resume');
    await lifecycle.getByRole('button',{name:'确认恢复',exact:true}).click();await lifecycle.waitFor({state:'hidden'});
    await page.getByRole('button',{name:'暂停会员卡',exact:true}).click();await lifecycle.getByText('该会员已经暂停过 1 次，本次为第 2 次。',{exact:true}).waitFor();await lifecycle.getByRole('button',{name:'取消',exact:true}).click();
    await page.getByRole('button',{name:'退卡',exact:true}).click();await lifecycle.getByText('估算退款额',{exact:true}).waitFor();
    await lifecycle.getByPlaceholder('请说明退卡原因及线下退款约定').fill('会员申请退卡，线下核实退款');
    await captureLifecycle('card-return');
    await lifecycle.getByRole('button',{name:'确认退卡',exact:true}).click();await lifecycle.waitFor({state:'hidden'});await page.locator('.current-card .member-status.returned').waitFor();
    await page.locator('.el-drawer__close-btn:visible').click();
    const snapshot=(await fixtureDb.query("SELECT id FROM members WHERE name='测试会员5'")).rows[0];
    const {MembersService}=await import('../apps/api/dist/members.js');await apiApp.get(MembersService).pauseCard(snapshot.id,{version:1,remark:'报表暂停样本'});
    const {ReportsService}=await import('../apps/api/dist/reports.js');await mkdir(resolve(root,'tmp/pdfs'),{recursive:true});

    for(const type of ['members','monthly'])await writeFile(resolve(root,`tmp/pdfs/v1.4.0-${type}.pdf`),await apiApp.get(ReportsService).pdf(type,todayShanghai().slice(0,7)));
  }
await page.getByRole('button',{name:'退出登录',exact:true}).click();await page.getByRole('heading',{name:'欢迎回到悦体健身'}).waitFor();
  assert.deepEqual(errors,[]);console.log('Browser checks passed: membership management, pause/resume/return dialogs, mandatory remarks, refund estimate, PDF reports, backup settings, responsive layout and logout.');
}finally{await browser.close();if(historyFixture&&fixtureDb)await fixtureDb.query('UPDATE membership_events SET remark=$2,event_type=$3,selected_kind=$4 WHERE id=$1',[historyFixture.id,historyFixture.remark,historyFixture.event_type,historyFixture.selected_kind]);await vite?.close();await apiApp?.close();if(uiDataDirectory)await rm(uiDataDirectory,{recursive:true,force:true});}
