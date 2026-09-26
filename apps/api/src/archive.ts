import JSZip from 'jszip';
import {fromBuffer} from 'yauzl';
import {BadRequestException} from '@nestjs/common';
import {createHash} from 'node:crypto';
export const sha256=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function inspectArchive(buffer:Buffer,maxSize=250*1024*1024){
  if(buffer.length>100*1024*1024)throw new BadRequestException('备份文件不能超过100MB');
  await new Promise<void>((resolve,reject)=>fromBuffer(buffer,{lazyEntries:true},(error,zip)=>{
    if(error||!zip)return reject(new BadRequestException('压缩文件无法读取'));
    let size=0,count=0;const names=new Set<string>();
    zip.on('error',()=>reject(new BadRequestException('压缩文件已损坏')));
    zip.on('entry',e=>{
      size+=e.uncompressedSize;count++;
      if(size>maxSize||count>20000||names.has(e.fileName)||e.fileName.includes('..')||e.fileName.includes('\\')||e.fileName.startsWith('/')||e.fileName.includes(':')){zip.close();return reject(new BadRequestException('备份过大或包含无效路径'));}
      names.add(e.fileName);zip.readEntry();
    });zip.on('end',resolve);zip.readEntry();
  }));
}
export async function pack(files:Map<string,Buffer>){
  const zip=new JSZip();const hashes:Record<string,string>={};
  for(const [name,bytes]of files){zip.file(name,bytes);hashes[name]=sha256(bytes);}
  zip.file('manifest.json',JSON.stringify({version:4,files:hashes}));return zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'});
}
export async function unpack(buffer:Buffer){
  await inspectArchive(buffer);const zip=await JSZip.loadAsync(buffer);if(!zip.file('manifest.json'))return null;
  try{
    const manifest=JSON.parse(await zip.file('manifest.json')!.async('string'));
    if(manifest.version!==4||!manifest.files||typeof manifest.files!=='object')throw new Error();
    const files=new Map<string,Buffer>();
    for(const [name,hash]of Object.entries(manifest.files)){
      if(!/^(members\.xlsx|state\.json|avatars\/[a-f0-9-]{36}\.jpg)$/.test(name))throw new Error();
      const bytes=await zip.file(name)?.async('nodebuffer');if(!bytes||sha256(bytes)!==hash)throw new Error();files.set(name,bytes);
    }
    if(Object.values(zip.files).filter(f=>!f.dir&&f.name!=='manifest.json').length!==files.size||!files.has('members.xlsx')||!files.has('state.json'))throw new Error();
    return files;
  }catch{throw new BadRequestException('备份清单或文件校验失败');}
}
