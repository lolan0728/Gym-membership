import { Controller, Get, Post, Patch, Put, Body, Param, Query, Req, Res, Inject, UploadedFile, UseInterceptors, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Response, Request } from 'express';
import { z } from 'zod';
import { Db } from './db.js';
import { AuthService, AuthRequest, Public } from './auth.js';
import { WechatService } from './wechat.js';
import { MembersService, audit } from './members.js';
import { ImportsService } from './imports.js';
import { StorageService } from './storage.js';
import { production } from './config.js';
import { parse,uuidSchema,createMemberSchema,updateMemberSchema,cardFields,cardRemarkSchema,dateSchema } from './domain.js';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const cookieOptions=()=>({httpOnly:true,secure:production(),sameSite:'strict' as const,path:'/api/admin',maxAge:12*3600*1000});
const upload=()=>FileInterceptor('file',{limits:{fileSize:5*1024*1024,files:1,fields:0}});
function fileBuffer(file:Express.Multer.File|undefined){if(!file?.buffer)throw new BadRequestException('请选择要上传的文件');return file.buffer;}
const reasonSchema=z.object({reason:z.string().trim().min(1,'请填写操作原因').max(300)}).strict();
@Controller('api')
export class PublicController {
  constructor(@Inject(Db) private db:Db,@Inject(AuthService) private auth:AuthService,@Inject(WechatService) private wx:WechatService,@Inject(StorageService) private storage:StorageService){}
  @Get('health') @Public() async health(){await this.db.query('SELECT 1');return {ok:true};}
  @Get('store') @Public() async store(){const s=(await this.db.query('SELECT name,phone FROM settings WHERE id=1')).rows[0];return {name:s.name,phone:s.phone,hasLogo:true};}
  @Get('store/logo') @Public() async logo(@Res()res:Response){
    const s=(await this.db.query('SELECT logo_key FROM settings WHERE id=1')).rows[0];
    if(s.logo_key)return res.type(s.logo_key.endsWith('.png')?'image/png':'image/jpeg').set('Cache-Control','public, max-age=300').send(await this.storage.get(s.logo_key));
    return res.type('image/png').set('Cache-Control','public, max-age=86400').send(await readFile(resolve(import.meta.dirname,'../assets/joyfit-logo.png')));
  }
  @Post('wechat/login') @Public() async login(@Body()body:unknown,@Req()req:Request){
    await this.auth.limit(`wx-login:${req.ip}`,60,60);const {code}=parse(z.object({code:z.string().min(1).max(256)}).strict(),body);
    const openid=await this.wx.login(code),token=await this.auth.issue('wechat',openid);
    const bound=!!(await this.db.query('SELECT 1 FROM wechat_bindings WHERE openid=$1',[openid])).rows.length;
    return {token,bound};
  }
}
@Controller('api/admin')
export class AdminController {
  constructor(@Inject(Db)private db:Db,@Inject(AuthService)private auth:AuthService,@Inject(MembersService)private members:MembersService,@Inject(ImportsService)private imports:ImportsService,@Inject(StorageService)private storage:StorageService,@Inject(WechatService)private wx:WechatService){}
  @Post('login') @Public() async login(@Body()body:unknown,@Req()req:Request,@Res({passthrough:true})res:Response){
    const {password}=parse(z.object({password:z.string().min(1).max(256)}).strict(),body);const token=await this.auth.login(password,req.ip||'unknown');res.cookie('gym_admin',token,cookieOptions());return {ok:true};
  }
  @Get('session') session(){return {name:'管理员',role:'owner'};}
  @Post('logout') async logout(@Req()req:AuthRequest,@Res({passthrough:true})res:Response){await this.db.query('DELETE FROM sessions WHERE token_hash=$1',[req.auth.tokenHash]);res.clearCookie('gym_admin',cookieOptions());return {ok:true};}
  @Post('password') async password(@Body()body:unknown,@Req()req:AuthRequest,@Res({passthrough:true})res:Response){
    await this.auth.limit(`password:${req.auth.tokenHash}`,5,900);
    const input=parse(z.object({current:z.string().max(256),next:z.string().min(12,'新密码至少 12 位').max(128)}).strict(),body);
    await this.auth.password(input.current,input.next);res.clearCookie('gym_admin',cookieOptions());return {ok:true};
  }
  @Get('stats') stats(){return this.members.stats();}
  @Get('members') list(@Query()query:unknown){
    return this.members.list(parse(z.object({search:z.string().max(80).optional(),status:z.enum(['active','upcoming','expired','voided']).optional(),endFrom:dateSchema.optional(),endTo:dateSchema.optional(),expiring:z.literal('true').transform(()=>true).optional(),page:z.coerce.number().int().min(1).default(1),pageSize:z.coerce.number().int().min(1).max(100).default(10)}).strict(),query));
  }
  @Post('members') create(@Body()body:unknown){return this.members.create(parse(createMemberSchema,body));}
  @Get('members/:id') detail(@Param('id')id:string){return this.members.detail(parse(uuidSchema,id));}
  @Patch('members/:id') update(@Param('id')id:string,@Body()body:unknown){return this.members.update(parse(uuidSchema,id),parse(updateMemberSchema,body));}
  @Post('members/:id/card/renew') renewCard(@Param('id')id:string,@Body()body:unknown){
    const input=parse(z.object({...cardFields,remark:cardRemarkSchema,version:z.number().int().positive()}).strict().refine(v=>v.endDate>=v.startDate,{message:'到期日期不能早于开始日期'}),body);
    return this.members.renewCard(parse(uuidSchema,id),input);
  }
  @Patch('members/:id/card') editCard(@Param('id')id:string,@Body()body:unknown){
    const input=parse(z.object({...cardFields,remark:cardRemarkSchema,version:z.number().int().positive()}).strict().refine(v=>v.endDate>=v.startDate,{message:'到期日期不能早于开始日期'}),body);
    return this.members.updateCard(parse(uuidSchema,id),input);
  }
  @Post('members/:id/card/void') voidCard(@Param('id')id:string,@Body()body:unknown){return this.members.voidCard(parse(uuidSchema,id),parse(reasonSchema,body).reason);}
  @Post('members/:id/reset-binding') reset(@Param('id')id:string,@Body()body:unknown){return this.members.resetBinding(parse(uuidSchema,id),parse(reasonSchema,body).reason);}
  @Get('imports/template') async template(@Res()res:Response){res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').attachment('members-template.xlsx').send(await this.imports.template());}
  @Post('imports/preview') @UseInterceptors(upload()) preview(@UploadedFile()file:Express.Multer.File){if(!file?.originalname.toLowerCase().endsWith('.xlsx'))throw new BadRequestException('请上传 .xlsx 文件');return this.imports.preview(fileBuffer(file));}
  @Post('imports/:id/confirm') confirm(@Param('id')id:string){return this.imports.confirm(parse(uuidSchema,id));}
  @Get('imports') batches(){return this.imports.list();}
  @Get('settings') async settings(){const s=(await this.db.query('SELECT name,phone FROM settings WHERE id=1')).rows[0];return {name:s.name,phone:s.phone,hasLogo:true};}
  @Patch('settings') async settingsUpdate(@Body()body:unknown){
    const input=parse(z.object({name:z.string().trim().min(1).max(50),phone:z.string().trim().max(30).regex(/^[0-9+()\- ]*$/)}).strict(),body);
    await this.db.tx(async q=>{await q.query('UPDATE settings SET name=$1,phone=$2,updated_at=now() WHERE id=1',[input.name,input.phone]);await audit(q,'settings_updated',null,input);});return {ok:true};
  }
  @Post('settings/logo') @UseInterceptors(upload()) async logo(@UploadedFile()file:Express.Multer.File){
    const key=await this.storage.putLogo(fileBuffer(file));let old:string|null=null;
    try{await this.db.tx(async q=>{old=(await q.query('SELECT logo_key FROM settings WHERE id=1 FOR UPDATE')).rows[0].logo_key;await q.query('UPDATE settings SET logo_key=$1,updated_at=now() WHERE id=1',[key]);await audit(q,'logo_updated',null,{});});}
    catch(e){await this.storage.remove(key).catch(()=>{});throw e;}
    if(old)await this.storage.remove(old).catch(()=>Logger.warn('Old logo cleanup failed','Storage'));return {ok:true};
  }
  @Get('qrcode') async qr(@Res()res:Response){res.type('image/png').attachment('gym-miniprogram-code.png').send(await this.wx.qrCode());}
}
@Controller('api')
export class MemberController {
  constructor(@Inject(Db)private db:Db,@Inject(MembersService)private members:MembersService,@Inject(WechatService)private wx:WechatService,@Inject(AuthService)private auth:AuthService,@Inject(StorageService)private storage:StorageService){}
  @Post('wechat/bind') async bind(@Req()req:AuthRequest,@Body()body:unknown){
    const {phoneCode}=parse(z.object({phoneCode:z.string().min(1).max(256)}).strict(),body);
    if(req.auth.memberId)return {bound:true};
    await this.auth.limit(`bind:${req.auth.openid}`,5,300);
    return this.members.bind(req.auth,await this.wx.phone(phoneCode));
  }
  @Get('me') me(@Req()req:AuthRequest){return this.members.me(req.auth.memberId!);}
  @Put('me/theme') async theme(@Req()req:AuthRequest,@Body()body:unknown){const {theme}=parse(z.object({theme:z.enum(['gold','blue','orange','white'])}).strict(),body);await this.db.query('UPDATE members SET theme=$2,updated_at=now() WHERE id=$1',[req.auth.memberId,theme]);return {ok:true};}
  @Post('me/avatar') @UseInterceptors(upload()) async avatar(@Req()req:AuthRequest,@UploadedFile()file:Express.Multer.File){
    await this.auth.limit(`avatar:${req.auth.memberId}`,20,3600);
    const key=await this.storage.putAvatar(fileBuffer(file));let old:string|null=null;
    try{await this.db.tx(async q=>{old=(await q.query('SELECT avatar_key FROM members WHERE id=$1 FOR UPDATE',[req.auth.memberId])).rows[0].avatar_key;await q.query('UPDATE members SET avatar_key=$2,updated_at=now() WHERE id=$1',[req.auth.memberId,key]);});}
    catch(e){await this.storage.remove(key).catch(()=>{});throw e;}
    if(old)await this.storage.remove(old).catch(()=>Logger.warn('Old avatar cleanup failed','Storage'));return {ok:true};
  }
  @Get('me/avatar') async avatarRead(@Req()req:AuthRequest,@Res()res:Response){const {rows}=await this.db.query('SELECT avatar_key FROM members WHERE id=$1',[req.auth.memberId]);if(!rows[0]?.avatar_key)throw new NotFoundException('尚未上传头像');res.type('image/jpeg').set('Cache-Control','no-store').send(await this.storage.get(rows[0].avatar_key));}
}
