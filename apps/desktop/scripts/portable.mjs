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
const folderName='悦体健身会员管理_1.0.1_便携版';
const folder=resolve(output,folderName);
const archive=resolve(output,`${folderName}.zip`);

await mkdir(output,{recursive:true});
await rm(folder,{recursive:true,force:true});
await rm(archive,{force:true});
await mkdir(folder,{recursive:true});
await cp(resolve(release,'joyfit-desktop.exe'),resolve(folder,'悦体健身会员管理.exe'));
await cp(resources,resolve(folder,'resources'),{recursive:true});
await writeFile(resolve(folder,'使用说明.txt'),[
  '悦体健身会员管理 1.0.1 便携版',
  '',
  '1. 请先完整解压 ZIP 文件。',
  '2. 双击“悦体健身会员管理.exe”启动。',
  '3. 不要单独移动 EXE；resources 文件夹必须和 EXE 放在一起。',
  '4. 会员数据保存在当前 Windows 用户的本地应用数据目录，替换程序文件不会删除数据。',
  '5. 首次运行时按向导设置管理员密码、会员卡天数与备份信息。',
  ''
].join('\r\n'),'utf8');

const zipCommand=`Compress-Archive -Path '${folder.replaceAll("'","''")}\\*' -DestinationPath '${archive.replaceAll("'","''")}' -CompressionLevel Optimal -Force`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',zipCommand],{stdio:'inherit'});
console.log(`Portable package created: ${archive}`);
