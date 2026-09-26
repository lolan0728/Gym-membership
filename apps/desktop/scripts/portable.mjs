import {cp,mkdir,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url));
const desktop=resolve(here,'..');
const root=resolve(desktop,'../..');
const release=resolve(desktop,'src-tauri/target/release');
const resources=resolve(desktop,'src-tauri/resources');
const output=resolve(root,'output/windows');
const folderName='悦体健身会员管理_1.5.0_便携版';
const folder=resolve(output,folderName);
const archive=resolve(output,`${folderName}.zip`);

await mkdir(output,{recursive:true});
await rm(folder,{recursive:true,force:true});
await rm(archive,{force:true});
await mkdir(folder,{recursive:true});
await cp(resolve(release,'joyfit-desktop.exe'),resolve(folder,'悦体健身会员管理.exe'));
await cp(resources,resolve(folder,'resources'),{recursive:true});
await writeFile(resolve(folder,'使用说明.txt'),[
  '悦体健身会员管理 1.5.0 便携版',
  '',
  '1. 请先完整解压 ZIP 文件。',
  '2. 双击“悦体健身会员管理.exe”启动。',
  '3. 不要单独移动 EXE；resources 文件夹必须和 EXE 放在一起。',
  '4. 会员数据和头像保存在当前 Windows 用户的本地应用数据目录，替换程序文件不会删除数据。',
  '5. 首次运行时按向导设置管理员密码、会员卡天数与备份信息。',
  '6. 每次完整关闭并重新启动后都需要输入管理员密码。',
  '7. 自动备份每天最多发送一次；退出程序不会发送备份邮件。',
  '8. “统计报表”可以查看经营月报，并导出全部会员名单或月度经营PDF。',
  '9. 升级前请在旧版执行“立即完整备份”，完整退出旧程序，再将新版解压至新文件夹运行。',
  '10. 退卡按本次连续会员周期内的首次开卡和每次续卡分段估算；每段先扣付费天数、再扣赠送天数，暂停天数不计入使用。',
  '11. 完整备份现在为 ZIP，包含 Excel、头像及预约状态；恢复时请选择整个 ZIP。',
  '12. 详情与列表显示大头像，点击可查看大图；编辑时支持点击选择或从Windows资源管理器拖入照片；会员卡面不显示头像。',
  '13. 已暂停、续卡或退卡的数据请使用本版及更新版本管理，不要再用旧版程序打开。',
  ''
].join('\r\n'),'utf8');

const zipCommand=`Compress-Archive -Path '${folder.replaceAll("'","''")}\\*' -DestinationPath '${archive.replaceAll("'","''")}' -CompressionLevel Optimal -Force`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',zipCommand],{stdio:'inherit'});
console.log(`Portable package created: ${archive}`);
