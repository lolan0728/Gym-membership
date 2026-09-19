import { Injectable, Inject, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, SetMetadata, HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { Db } from './db.js';
import { digest, newToken, verifyPassword, hashPassword } from './security.js';
export const Public = () => SetMetadata('public',true);
export interface AuthRequest extends Request { auth: { role:string; openid:string | null; tokenHash:string; memberId:string | null } }
@Injectable()
export class AuthService {
  constructor(@Inject(Db) private db: Db) {}
  async limit(key:string,max:number,seconds:number) {
    const { rows } = await this.db.query(`INSERT INTO rate_limits(key,hits,reset_at) VALUES($1,1,now()+$2*interval '1 second')
      ON CONFLICT(key) DO UPDATE SET hits=CASE WHEN rate_limits.reset_at < now() THEN 1 ELSE rate_limits.hits+1 END,
      reset_at=CASE WHEN rate_limits.reset_at < now() THEN now()+$2*interval '1 second' ELSE rate_limits.reset_at END RETURNING hits`, [digest(key),seconds]);
    if (rows[0].hits>max) throw new HttpException('操作过于频繁，请稍后重试',429);
  }
  async issue(role:'admin'|'wechat',openid:string|null=null) {
    const token = newToken();
    await this.db.query(`INSERT INTO sessions(token_hash,role,openid,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 hour')`,[digest(token),role,openid,role==='admin'?12:720]);
    return token;
  }
  async login(password:string,ip:string) {
    await this.limit(`admin-login:${ip}`,10,900);
    const {rows} = await this.db.query('SELECT password_hash FROM administrators WHERE id=1');
    if (!await verifyPassword(password,rows[0].password_hash)) throw new UnauthorizedException('密码不正确');
    return this.issue('admin');
  }
  async password(current:string,next:string) {
    const hash = await hashPassword(next);
    await this.db.tx(async q=>{
      const {rows} = await q.query('SELECT password_hash FROM administrators WHERE id=1 FOR UPDATE');
      if (!await verifyPassword(current,rows[0].password_hash)) throw new ForbiddenException('原密码不正确');
      await q.query('UPDATE administrators SET password_hash=$1 WHERE id=1',[hash]);
      await q.query("DELETE FROM sessions WHERE role='admin'");
      await q.query("INSERT INTO audit_logs(id,action,detail) VALUES(gen_random_uuid(),'password_changed','{}')");
    });
  }
}
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Db) private db:Db,@Inject(Reflector) private reflector:Reflector) {}
  async canActivate(context:ExecutionContext) {
    const req = context.switchToHttp().getRequest<AuthRequest>();
    const admin = req.path.startsWith('/api/admin');
    if (admin && !['GET','HEAD','OPTIONS'].includes(req.method)) {
      const expected = process.env.ADMIN_ORIGIN || 'http://localhost:15173';
      if (req.get('origin') !== expected || req.get('x-gym-request') !== '1') throw new ForbiddenException('请求来源无效，请从管理后台操作');
    }
    if (this.reflector.getAllAndOverride<boolean>('public',[context.getHandler(),context.getClass()])) return true;
    const token = admin ? req.cookies?.gym_admin : req.get('authorization')?.replace(/^Bearer /,'');
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException('请重新登录');
    const hash = digest(token);
    const {rows} = await this.db.query(`SELECT s.role,s.openid,b.member_id FROM sessions s LEFT JOIN wechat_bindings b ON b.openid=s.openid WHERE s.token_hash=$1 AND s.expires_at>now()`,[hash]);
    const session = rows[0];
    if (!session) throw new UnauthorizedException('登录已失效，请重新登录');
    if (session.role !== (admin?'admin':'wechat')) throw new ForbiddenException('无权访问');
    req.auth = {role:session.role,openid:session.openid,tokenHash:hash,memberId:session.member_id};
    if (req.path.startsWith('/api/me') && !session.member_id) throw new ForbiddenException('请先领取会员卡');
    return true;
  }
}
