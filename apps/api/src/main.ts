import 'reflect-metadata';
import './config.js';
import { NestFactory, APP_GUARD } from '@nestjs/core';
import { Module, Catch, ExceptionFilter, ArgumentsHost, HttpException, Logger } from '@nestjs/common';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import express from 'express';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Db } from './db.js';
import { AuthGuard, AuthService } from './auth.js';
import { MembersService } from './members.js';
import { ImportsService } from './imports.js';
import { StorageService } from './storage.js';
import { PublicController, AdminController, DesktopController } from './controllers.js';
import { BackupsService } from './backups.js';
import { OperationLogsService } from './operation-logs.js';
import { checkConfig, production } from './config.js';
@Catch()
export class ErrorFilter implements ExceptionFilter {
  catch(exception:any,host:ArgumentsHost){
    const id=randomUUID(),response=host.switchToHttp().getResponse();let status=500,message='服务暂时不可用，请稍后重试';
    if(exception instanceof HttpException){status=exception.getStatus();const body=exception.getResponse();message=typeof body==='string'?body:(body as any).message;}
    else if(['23505','23P01','23514','40001','40P01'].includes(exception?.code)) {status=409;message=exception.code==='23P01'?'有效期与已有会员卡重叠，请调整日期':exception.code==='23505'?'手机号、会员号码或绑定信息已存在，请刷新并检查数据':'数据发生冲突，请刷新后重试';}
    if(status>=500)Logger.error(`Request ${id} failed (${exception?.constructor?.name||'Error'})`,'API');
    response.status(status).json({statusCode:status,message,requestId:id});
  }
}
@Module({controllers:[PublicController,AdminController,DesktopController],providers:[Db,AuthService,MembersService,ImportsService,StorageService,OperationLogsService,BackupsService,{provide:APP_GUARD,useClass:AuthGuard}]})
export class AppModule {}
export async function createApp(){
  checkConfig();const app=await NestFactory.create(AppModule,{logger:process.env.NODE_ENV==='test'?false:['error','warn','log']});
  app.getHttpAdapter().getInstance().set('trust proxy',production()?1:'loopback');
  app.use(helmet({contentSecurityPolicy:false}));app.use(cookieParser());app.use((req:any,res:any,next:any)=>{res.setHeader('Cache-Control','no-store');next();});
  const adminDist=process.env.ADMIN_DIST_PATH;
  if(adminDist&&existsSync(adminDist)){
    app.use(express.static(adminDist,{index:false,maxAge:'1h'}));
    app.getHttpAdapter().getInstance().get(/^(?!\/api(?:\/|$)).*/,(_req:any,res:any)=>res.sendFile(resolve(adminDist,'index.html')));
  }
  app.useGlobalFilters(new ErrorFilter());app.enableShutdownHooks();await app.init();return app;
}
if(process.argv[1] && fileURLToPath(import.meta.url)===resolve(process.argv[1]))createApp().then(async app=>{
  await app.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1');
  const cleanup=setInterval(()=>app.get(Db).tx(async q=>{await q.query('DELETE FROM sessions WHERE expires_at<now()');await q.query("DELETE FROM rate_limits WHERE reset_at<now()-interval '1 day'");}).catch(()=>Logger.warn('Session cleanup failed')),3600000);cleanup.unref();
  if(process.env.DESKTOP_MODE==='true'){const logs=setInterval(()=>app.get(OperationLogsService).flush().catch(()=>Logger.warn('Operation log flush failed')),2000);logs.unref();}
}).catch(e=>{Logger.error(e.message);process.exit(1);});
