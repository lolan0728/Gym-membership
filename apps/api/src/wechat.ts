import { Injectable, ServiceUnavailableException, BadRequestException, Logger } from '@nestjs/common';
@Injectable()
export class WechatService {
  private token = ''; private expires = 0; private loading?: Promise<string>;
  private readonly log = new Logger('WeChat');
  private credentials() {
    const appid=process.env.WECHAT_APP_ID,secret=process.env.WECHAT_APP_SECRET;
    if (!appid || !secret) throw new ServiceUnavailableException('微信服务尚未配置，请联系门店');
    return {appid,secret};
  }
  private async request(url:string,init?:RequestInit): Promise<any> {
    let response: Response;
    try { response=await fetch(url,{...init,signal:AbortSignal.timeout(12000)}); }
    catch { throw new ServiceUnavailableException('微信服务暂时不可用，请稍后重试'); }
    if (!response.ok) throw new ServiceUnavailableException('微信服务暂时不可用，请稍后重试');
    const data:any = await response.json();
    if (data.errcode) {
      this.log.warn(`WeChat API error ${Number(data.errcode)}`);
      if ([40029,40163].includes(data.errcode)) throw new BadRequestException('微信凭证已失效，请重新授权');
      throw new ServiceUnavailableException('微信验证未完成，请重新尝试或联系门店');
    }
    return data;
  }
  async login(code:string):Promise<string> {
    const {appid,secret}=this.credentials();
    const data=await this.request(`https://api.weixin.qq.com/sns/jscode2session?${new URLSearchParams({appid,secret,js_code:code,grant_type:'authorization_code'})}`);
    if (!data.openid) throw new BadRequestException('微信登录失败，请重试'); return data.openid;
  }
  async accessToken():Promise<string> {
    if (this.token && Date.now()<this.expires) return this.token;
    if (this.loading) return this.loading;
    this.loading=(async()=>{
      const data=await this.request('https://api.weixin.qq.com/cgi-bin/stable_token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...this.credentials(),grant_type:'client_credential',force_refresh:false})});
      if (!data.access_token) throw new ServiceUnavailableException('微信服务配置异常');
      this.token=data.access_token; this.expires=Date.now()+(data.expires_in-300)*1000; return this.token;
    })();
    try { return await this.loading; } finally { this.loading=undefined; }
  }
  async phone(code:string):Promise<string> {
    const access_token=await this.accessToken();
    const data=await this.request(`https://api.weixin.qq.com/wxa/business/getuserphonenumber?${new URLSearchParams({access_token})}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code})});
    if (data.phone_info?.countryCode !== '86' || !/^1[3-9]\d{9}$/.test(data.phone_info?.purePhoneNumber || '')) throw new BadRequestException('请使用办理会员卡时登记的中国大陆手机号');
    if (data.phone_info?.watermark?.appid !== process.env.WECHAT_APP_ID) throw new BadRequestException('微信验证结果无效');
    return data.phone_info.purePhoneNumber;
  }
  async qrCode():Promise<Buffer> {
    const access_token=await this.accessToken();
    let response:Response;
    try { response=await fetch(`https://api.weixin.qq.com/wxa/getwxacodeunlimit?${new URLSearchParams({access_token})}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scene:'store',page:'pages/index/index',check_path:true,env_version:process.env.WECHAT_QRCODE_ENV||'release',width:430}),signal:AbortSignal.timeout(15000)}); }
    catch { throw new ServiceUnavailableException('小程序码暂时无法生成'); }
    if (!response.ok || !response.headers.get('content-type')?.startsWith('image/')) throw new BadRequestException('小程序码生成失败，请确认小程序已发布且 AppID 配置正确');
    return Buffer.from(await response.arrayBuffer());
  }
}
