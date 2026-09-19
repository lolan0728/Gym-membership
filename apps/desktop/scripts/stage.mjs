import {cp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here=dirname(fileURLToPath(import.meta.url)),desktop=resolve(here,'..'),root=resolve(desktop,'../..'),resources=resolve(desktop,'src-tauri/resources'),server=resolve(resources,'server');
execFileSync('npm',['run','build','-w','@gym/api'],{cwd:root,stdio:'inherit',shell:true});
execFileSync('npm',['run','build','-w','@gym/admin'],{cwd:root,stdio:'inherit',shell:true});
await rm(resources,{recursive:true,force:true});await mkdir(resolve(resources,'runtime'),{recursive:true});await mkdir(resolve(server,'api'),{recursive:true});
const apiPackage=JSON.parse(await readFile(resolve(root,'apps/api/package.json'),'utf8'));
await writeFile(resolve(server,'package.json'),JSON.stringify({private:true,type:'module',dependencies:apiPackage.dependencies},null,2));
execFileSync('npm',['install','--omit=dev','--no-audit','--no-fund','--workspaces=false','--package-lock=false','--registry=https://registry.npmjs.org'],{cwd:server,stdio:'inherit',shell:true});
await cp(resolve(root,'apps/api/dist'),resolve(server,'api/dist'),{recursive:true});
await cp(resolve(root,'apps/api/migrations'),resolve(server,'api/migrations'),{recursive:true});
await cp(resolve(root,'apps/api/assets'),resolve(server,'api/assets'),{recursive:true});
await cp(resolve(root,'apps/admin/dist'),resolve(server,'admin/dist'),{recursive:true});
const nodePath=process.execPath;await cp(nodePath,resolve(resources,'runtime/node.exe'));
console.log(`Desktop resources staged at ${resources}`);
