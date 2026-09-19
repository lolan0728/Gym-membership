import {test} from 'node:test';
import assert from 'node:assert/strict';
import {WechatService} from '../src/wechat.js';
test('WeChat exchanges login server-side, checks phone watermark, and reuses access token',async()=>{
  const original=globalThis.fetch;process.env.WECHAT_APP_ID='wx-unit-test';process.env.WECHAT_APP_SECRET='unit-test-secret';
  const seen:{url:string;body?:any}[]=[];
  globalThis.fetch=async (input:any,options:any)=>{
    const url=String(input);seen.push({url,body:options?.body?JSON.parse(options.body):undefined});
    if(url.includes('jscode2session'))return Response.json({openid:'server-identity',session_key:'never-return-this'});
    if(url.includes('stable_token'))return Response.json({access_token:'server-token',expires_in:7200});
    return Response.json({phone_info:{purePhoneNumber:'13900000000',countryCode:'86',watermark:{appid:'wx-unit-test'}}});
  };
  try{
    const service=new WechatService();assert.equal(await service.login('wx-login-code'),'server-identity');assert.equal(await service.phone('phone-code'),'13900000000');await service.phone('phone-code-2');
    assert.equal(seen.filter(r=>r.url.includes('stable_token')).length,1);assert.equal(seen[2].body.code,'phone-code');
    globalThis.fetch=async()=>Response.json({phone_info:{purePhoneNumber:'13900000000',countryCode:'86',watermark:{appid:'other-app'}}});
    await assert.rejects(service.phone('forged-watermark'),/验证结果无效/);
  }finally{globalThis.fetch=original;}
});
test('WeChat failures and missing config never create a fallback identity',async()=>{
  const original=globalThis.fetch;const service=new WechatService();
  try{
    process.env.WECHAT_APP_ID='';await assert.rejects(service.login('code'),/尚未配置/);
    process.env.WECHAT_APP_ID='wx-test';process.env.WECHAT_APP_SECRET='test';globalThis.fetch=async()=>Response.json({errcode:40029});await assert.rejects(service.login('used-code'),/失效/);
    globalThis.fetch=async()=>{throw new Error('offline');};await assert.rejects(service.login('code'),/暂时不可用/);
  }finally{globalThis.fetch=original;}
});
