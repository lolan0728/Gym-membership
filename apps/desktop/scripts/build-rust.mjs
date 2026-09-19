import {execFileSync} from 'node:child_process';
import {existsSync,writeFileSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const noBundle=process.argv.includes('--no-bundle');
const desktop=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const tauriCli=resolve(desktop,'../../node_modules/@tauri-apps/cli/tauri.js');
const tauriArgs=[tauriCli,'build',...(noBundle?['--no-bundle']:[])];
if(!existsSync(tauriCli))throw new Error('未找到 Tauri CLI，请先在项目根目录运行 npm install。');

if(process.platform!=='win32'||process.env.VCINSTALLDIR){
  execFileSync(process.execPath,tauriArgs,{stdio:'inherit'});
  process.exit(0);
}

const programFilesX86=process.env['ProgramFiles(x86)']||'C:\\Program Files (x86)';
const vswhere=join(programFilesX86,'Microsoft Visual Studio','Installer','vswhere.exe');
let installation='';
if(existsSync(vswhere)){
  try{installation=execFileSync(vswhere,['-latest','-products','Microsoft.VisualStudio.Product.BuildTools','-property','installationPath'],{encoding:'utf8'}).trim();}catch{}
}
const devCommand=installation&&join(installation,'Common7','Tools','VsDevCmd.bat');
if(!devCommand||!existsSync(devCommand)){
  throw new Error('未找到 Visual Studio 2022 Build Tools。请安装“使用 C++ 的桌面开发”组件。');
}
const environmentScript=join(tmpdir(),`joyfit-vs-env-${process.pid}.cmd`);
writeFileSync(environmentScript,`@call "${devCommand}" -arch=x64 -host_arch=x64 >nul\r\n@set\r\n`,'ascii');
try{
  const output=execFileSync('cmd.exe',['/d','/u','/c',environmentScript],{encoding:'utf16le'});
  const buildEnvironment={...process.env};
  for(const line of output.split(/\r?\n/)){
    const separator=line.indexOf('=');
    if(separator>0)buildEnvironment[line.slice(0,separator)]=line.slice(separator+1);
  }
  execFileSync(process.execPath,tauriArgs,{stdio:'inherit',env:buildEnvironment});
}finally{try{unlinkSync(environmentScript);}catch{}}
