import { Injectable, BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import sharp from 'sharp';
import COS from 'cos-nodejs-sdk-v5';
import { randomUUID } from 'node:crypto';
import { mkdir,writeFile,readFile,unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
@Injectable()
export class StorageService {
  private cos?:COS;
  private root=resolve(process.env.LOCAL_STORAGE_PATH||'../../.local-data/uploads');
  private client(){return this.cos??=new COS({SecretId:process.env.COS_SECRET_ID,SecretKey:process.env.COS_SECRET_KEY});}
  private location(key:string){return {Bucket:process.env.COS_BUCKET!,Region:process.env.COS_REGION!,Key:`${process.env.COS_PREFIX||'gym'}/${key}`};}
  private safeKey(key:string){if(!/^[a-f0-9-]{36}\.(jpg|png)$/.test(key))throw new BadRequestException('图片路径无效');return key;}
  private async readImage(buffer:Buffer){
    if(!buffer.length||buffer.length>5*1024*1024)throw new BadRequestException('请选择不超过 5 MB 的 JPEG 或 PNG 图片');
    try{
      const image=sharp(buffer,{limitInputPixels:16000000,animated:false});const meta=await image.metadata();
      if(!['jpeg','png'].includes(meta.format||''))throw new Error('format');
      return image.rotate();
    }catch{throw new BadRequestException('图片无法读取，请选择有效的 JPEG 或 PNG 图片');}
  }
  private async save(data:Buffer,extension:'jpg'|'png',contentType:string){
    const key=`${randomUUID()}.${extension}`;
    try{
      if(process.env.STORAGE_DRIVER==='cos')await this.client().putObject({...this.location(key),Body:data,ContentType:contentType,ACL:'private',ServerSideEncryption:'AES256'});
      else{await mkdir(this.root,{recursive:true});await writeFile(resolve(this.root,key),data);}
    }catch{throw new ServiceUnavailableException('图片保存失败，请稍后重试');}
    return key;
  }
  async putAvatar(buffer:Buffer){
    let data:Buffer;
    try{const image=await this.readImage(buffer);data=await image.resize(512,512,{fit:'cover',withoutEnlargement:true}).jpeg({quality:85}).toBuffer();}
    catch(error){if(error instanceof BadRequestException)throw error;throw new BadRequestException('图片无法读取，请选择有效的 JPEG 或 PNG 图片');}
    return this.save(data,'jpg','image/jpeg');
  }
  async putLogo(buffer:Buffer){
    let data:Buffer;
    try{const image=await this.readImage(buffer);data=await image.resize({width:1024,height:512,fit:'inside',withoutEnlargement:true}).png({compressionLevel:9}).toBuffer();}
    catch(error){if(error instanceof BadRequestException)throw error;throw new BadRequestException('图片无法读取，请选择有效的 JPEG 或 PNG 图片');}
    return this.save(data,'png','image/png');
  }
  async get(key:string){
    this.safeKey(key);
    if(process.env.STORAGE_DRIVER==='cos'){
      const result=await this.client().getObject(this.location(key));return Buffer.from(result.Body as Buffer);
    }
    return readFile(resolve(this.root,key));
  }
  async remove(key:string){this.safeKey(key);if(process.env.STORAGE_DRIVER==='cos')await this.client().deleteObject(this.location(key));else await unlink(resolve(this.root,key));}
}
