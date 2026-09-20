import { BadRequestException, Body, Controller, Get, Headers, Inject, Logger, Param, Patch, Post, Query, Req, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { AuthRequest, AuthService, Public } from './auth.js';
import { BACKUP_MIME, BackupsService } from './backups.js';
import { desktopMode, production } from './config.js';
import { Db } from './db.js';
import { cardFields, cardRemarkSchema, createMemberSchema, dateSchema, parse, updateMemberSchema, uuidSchema } from './domain.js';
import { ImportsService } from './imports.js';
import { audit, MembersService } from './members.js';
import { hashPassword } from './security.js';
import { StorageService } from './storage.js';

const cookieOptions=()=>({httpOnly:true,secure:production()&&!desktopMode(),sameSite:'strict' as const,path:'/api/admin',maxAge:12*3600*1000});
const upload=(size=5*1024*1024)=>FileInterceptor('file',{limits:{fileSize:size,files:1,fields:0}});
function fileBuffer(file:Express.Multer.File|undefined){if(!file?.buffer)throw new BadRequestException('请选择要上传的文件');return file.buffer;}
const reasonSchema=z.object({reason:z.string().trim().min(1,'请填写操作原因').max(300)}).strict();
const email=z.string().trim().email('请输入正确的邮箱地址').or(z.literal(''));
const settingsSchema=z.object({name:z.string().trim().min(1).max(50),phone:z.string().trim().max(30).regex(/^[0-9+()\- ]*$/),monthCardDays:z.number().int().min(1).max(3650),yearCardDays:z.number().int().min(1).max(3650)}).strict();
const backupSettingsSchema=z.object({directory:z.string().trim().max(500),senderEmail:email,recipientEmail:email,scheduleTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),retentionCount:z.number().int().min(1).max(365)}).strict();

@Controller('api')
export class PublicController {
  constructor(@Inject(Db) private db:Db,@Inject(StorageService) private storage:StorageService){}
  @Get('health') @Public() async health(){await this.db.query('SELECT 1');return {ok:true,desktop:desktopMode()};}
  @Get('setup/status') @Public() async setupStatus(){return {required:!(await this.db.query('SELECT 1 FROM administrators WHERE id=1')).rows.length};}
  @Post('setup') @Public() async setup(@Body()body:unknown){
    const input=parse(settingsSchema.extend({password:z.string().min(12,'管理员密码至少 12 位').max(128),backupDirectory:z.string().trim().max(500).default(''),senderEmail:email.default(''),recipientEmail:email.default('')}),body);
    await this.db.tx(async q=>{
      if((await q.query('SELECT 1 FROM administrators WHERE id=1 FOR UPDATE')).rows.length)throw new BadRequestException('初始化已经完成');
      await q.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1)',[await hashPassword(input.password)]);
      await q.query('UPDATE settings SET name=$1,phone=$2,month_card_days=$3,year_card_days=$4,updated_at=now() WHERE id=1',[input.name,input.phone,input.monthCardDays,input.yearCardDays]);
      if(input.backupDirectory||input.senderEmail||input.recipientEmail)await q.query('UPDATE backup_settings SET directory=$1,sender_email=$2,recipient_email=$3,updated_at=now() WHERE id=1',[input.backupDirectory,input.senderEmail,input.recipientEmail||input.senderEmail]);
      await audit(q,'desktop_initialized',null,{name:input.name,phone:input.phone,monthCardDays:input.monthCardDays,yearCardDays:input.yearCardDays});
    });return {ok:true};
  }
  @Get('store') @Public() async store(){const s=(await this.db.query('SELECT name,phone,month_card_days,year_card_days FROM settings WHERE id=1')).rows[0];return {name:s.name,phone:s.phone,monthCardDays:Number(s.month_card_days),yearCardDays:Number(s.year_card_days),hasLogo:true};}
  @Get('store/logo') @Public() async logo(@Res()res:Response){const s=(await this.db.query('SELECT logo_key FROM settings WHERE id=1')).rows[0];if(s.logo_key)return res.type(s.logo_key.endsWith('.png')?'image/png':'image/jpeg').set('Cache-Control','public, max-age=300').send(await this.storage.get(s.logo_key));return res.type('image/png').set('Cache-Control','public, max-age=86400').send(await readFile(resolve(import.meta.dirname,'../assets/joyfit-logo.png')));}
}

@Controller('api/admin')
export class AdminController {
  constructor(@Inject(Db)private db:Db,@Inject(AuthService)private auth:AuthService,@Inject(MembersService)private members:MembersService,@Inject(ImportsService)private imports:ImportsService,@Inject(StorageService)private storage:StorageService,@Inject(BackupsService)private backups:BackupsService){}
  @Post('login') @Public() async login(@Body()body:unknown,@Req()req:Request,@Res({passthrough:true})res:Response){const {password}=parse(z.object({password:z.string().min(1).max(256)}).strict(),body);const token=await this.auth.login(password,req.ip||'unknown');res.cookie('gym_admin',token,cookieOptions());return {ok:true};}
  @Get('session') session(){return {name:'管理员',role:'owner'};}
  @Post('logout') async logout(@Req()req:AuthRequest,@Res({passthrough:true})res:Response){await this.db.query('DELETE FROM sessions WHERE token_hash=$1',[req.auth.tokenHash]);res.clearCookie('gym_admin',cookieOptions());return {ok:true};}
  @Post('password') async password(@Body()body:unknown,@Req()req:AuthRequest,@Res({passthrough:true})res:Response){await this.auth.limit(`password:${req.auth.tokenHash}`,5,900);const input=parse(z.object({current:z.string().max(256),next:z.string().min(12,'新密码至少 12 位').max(128)}).strict(),body);await this.auth.password(input.current,input.next);res.clearCookie('gym_admin',cookieOptions());return {ok:true};}
  @Get('stats') stats(){return this.members.stats();}
  @Get('members') list(@Query()query:unknown){return this.members.list(parse(z.object({search:z.string().max(80).optional(),status:z.enum(['active','upcoming','expired','voided']).optional(),endFrom:dateSchema.optional(),endTo:dateSchema.optional(),expiring:z.literal('true').transform(()=>true).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10)}).strict(),query));}
  @Post('members') create(@Body()body:unknown){return this.members.create(parse(createMemberSchema,body));}
  @Get('members/:id') detail(@Param('id')id:string){return this.members.detail(parse(uuidSchema,id));}
  @Patch('members/:id') update(@Param('id')id:string,@Body()body:unknown){return this.members.update(parse(uuidSchema,id),parse(updateMemberSchema,body));}
  @Post('members/:id/card/renew') renewCard(@Param('id')id:string,@Body()body:unknown){const input=parse(z.object({...cardFields,remark:cardRemarkSchema,version:z.number().int().positive()}).strict().refine(v=>v.endDate>=v.startDate,{message:'到期日期不能早于开始日期'}),body);return this.members.renewCard(parse(uuidSchema,id),input);}
  @Patch('members/:id/card') editCard(@Param('id')id:string,@Body()body:unknown){const input=parse(z.object({...cardFields,remark:cardRemarkSchema,version:z.number().int().positive()}).strict().refine(v=>v.endDate>=v.startDate,{message:'到期日期不能早于开始日期'}),body);return this.members.updateCard(parse(uuidSchema,id),input);}
  @Post('members/:id/card/void') voidCard(@Param('id')id:string,@Body()body:unknown){return this.members.voidCard(parse(uuidSchema,id),parse(reasonSchema,body).reason);}
  @Get('imports/template') async template(@Res()res:Response){res.type(BACKUP_MIME).attachment('members-template.xlsx').send(await this.imports.template());}
  @Post('imports/preview') @UseInterceptors(upload()) preview(@UploadedFile()file:Express.Multer.File){if(!file?.originalname.toLowerCase().endsWith('.xlsx'))throw new BadRequestException('请上传 .xlsx 文件');return this.imports.preview(fileBuffer(file));}
  @Post('imports/:id/confirm') confirm(@Param('id')id:string){return this.imports.confirm(parse(uuidSchema,id));}
  @Get('imports') batches(){return this.imports.list();}
  @Get('settings') async settings(){const s=(await this.db.query('SELECT name,phone,month_card_days,year_card_days FROM settings WHERE id=1')).rows[0];return {name:s.name,phone:s.phone,monthCardDays:Number(s.month_card_days),yearCardDays:Number(s.year_card_days),hasLogo:true};}
  @Patch('settings') async settingsUpdate(@Body()body:unknown){const input=parse(settingsSchema,body);await this.db.tx(async q=>{await q.query('UPDATE settings SET name=$1,phone=$2,month_card_days=$3,year_card_days=$4,updated_at=now() WHERE id=1',[input.name,input.phone,input.monthCardDays,input.yearCardDays]);await audit(q,'settings_updated',null,input);});return {ok:true};}
  @Post('settings/logo') @UseInterceptors(upload()) async logo(@UploadedFile()file:Express.Multer.File){const key=await this.storage.putLogo(fileBuffer(file));let old:string|null=null;try{await this.db.tx(async q=>{old=(await q.query('SELECT logo_key FROM settings WHERE id=1 FOR UPDATE')).rows[0].logo_key;await q.query('UPDATE settings SET logo_key=$1,updated_at=now() WHERE id=1',[key]);await audit(q,'logo_updated',null,{});});}catch(e){await this.storage.remove(key).catch(()=>{});throw e;}if(old)await this.storage.remove(old).catch(()=>Logger.warn('Old logo cleanup failed','Storage'));return {ok:true};}
  @Get('backup/settings') backupSettings(){return this.backups.settings();}
  @Patch('backup/settings') updateBackupSettings(@Body()body:unknown){return this.backups.updateSettings(parse(backupSettingsSchema,body));}
  @Post('backup/run') runBackup(){return this.backups.createLocal('manual');}
  @Get('backup/jobs') backupJobs(){return this.backups.jobs();}
  @Get('backup/export') async exportBackup(@Res()res:Response){res.type(BACKUP_MIME).attachment(`joyfit-full-backup-${Date.now()}.xlsx`).send(await this.backups.exportBuffer());}
  @Post('backup/restore') @UseInterceptors(upload(25*1024*1024)) async restoreBackup(@UploadedFile()file:Express.Multer.File){if(!file?.originalname.toLowerCase().endsWith('.xlsx'))throw new BadRequestException('请选择完整备份 .xlsx 文件');return this.backups.restore(fileBuffer(file));}
}

@Controller('api/desktop')
export class DesktopController {
  constructor(@Inject(BackupsService)private backups:BackupsService){}
  private authorize(token:string|undefined){const expected=process.env.DESKTOP_CONTROL_TOKEN||'';if(!expected||!token)throw new BadRequestException('桌面控制凭证无效');const a=Buffer.from(expected),b=Buffer.from(token);if(a.length!==b.length||!timingSafeEqual(a,b))throw new BadRequestException('桌面控制凭证无效');}
  @Post('backup/run') @Public() run(@Headers('x-desktop-token')token:string|undefined,@Body()body:unknown){this.authorize(token);const input=parse(z.object({trigger:z.enum(['manual','automatic']).default('manual'),scheduledDate:dateSchema.optional()}).strict(),body||{});return this.backups.createLocal(input.trigger,input.scheduledDate);}
  @Get('backup/pending') @Public() async pending(@Headers('x-desktop-token')token:string|undefined){this.authorize(token);return {job:await this.backups.automaticPending(),settings:await this.backups.settings()};}
  @Post('backup/:id/email') @Public() mark(@Headers('x-desktop-token')token:string|undefined,@Param('id')id:string,@Body()body:unknown){this.authorize(token);const input=parse(z.object({ok:z.boolean(),error:z.string().max(1000).default('')}).strict(),body);return this.backups.markEmail(parse(uuidSchema,id),input.ok,input.error);}
}
