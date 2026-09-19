import {API_BASE} from '../config';
export interface MemberCard {id:string;kind:string;start_date:string;end_date:string;status:string;void_reason?:string;event_type?:string;selected_kind?:string;created_at?:string;}
export interface Member {id:string;name:string;card_number:string;theme:string;avatar_key:string|null;card:MemberCard|null;cardHistory:MemberCard[];}
export class ApiError extends Error{constructor(message:string,public status:number){super(message);}}
let loggingIn:Promise<void>|null=null;
export const token=()=>wx.getStorageSync('gym-session') as string;
export const clearSession=()=>wx.removeStorageSync('gym-session');
export function request<T=any>(path:string,method:'GET'|'POST'|'PUT'='GET',data?:any,auth=true):Promise<T>{
  return new Promise((resolve,reject)=>wx.request({url:API_BASE+path,method,data,timeout:15000,header:{'content-type':'application/json',...(auth?{Authorization:`Bearer ${token()}`}:{})},success(res){
    if(res.statusCode>=200&&res.statusCode<300)resolve(res.data as T);
    else{if(res.statusCode===401)clearSession();reject(new ApiError((res.data as any)?.message||'请求未完成，请重试',res.statusCode));}
  },fail(){reject(new ApiError('网络连接失败，请检查网络后重试',0));}}));
}
export async function ensureSession(){
  if(token())return;if(loggingIn)return loggingIn;
  loggingIn=(async()=>{const code=await new Promise<string>((resolve,reject)=>wx.login({success:r=>r.code?resolve(r.code):reject(new Error('微信登录失败')),fail:()=>reject(new Error('微信登录失败'))}));const result=await request<{token:string}>('/wechat/login','POST',{code},false);wx.setStorageSync('gym-session',result.token);})();
  try{await loggingIn;}finally{loggingIn=null;}
}
export async function loadMe():Promise<Member>{
  await ensureSession();try{return await request<Member>('/me');}catch(e){if(e instanceof ApiError&&e.status===401){await ensureSession();return request<Member>('/me');}throw e;}
}
export async function uploadAvatar(path:string){
  return new Promise<void>((resolve,reject)=>wx.uploadFile({url:API_BASE+'/me/avatar',filePath:path,name:'file',header:{Authorization:`Bearer ${token()}`},success:r=>{if(r.statusCode>=200&&r.statusCode<300)resolve();else{if(r.statusCode===401)clearSession();try{reject(new Error(JSON.parse(r.data).message));}catch{reject(new Error('头像保存失败，请重试'));}}},fail:()=>reject(new Error('头像上传失败，请检查网络'))}));
}
export async function downloadAvatar():Promise<string>{return new Promise((resolve)=>wx.downloadFile({url:API_BASE+'/me/avatar',header:{Authorization:`Bearer ${token()}`},success:r=>resolve(r.statusCode===200?r.tempFilePath:''),fail:()=>resolve('')}));}
export const statusLabels:Record<string,string>={active:'有效',upcoming:'未生效',expired:'已到期',voided:'已作废'};
export const kindLabel=(value:string)=>value==='year'?'年卡':'月卡';
export function present(card:MemberCard){return {...card,kindLabel:kindLabel(card.kind),statusLabel:statusLabels[card.status],period:`${card.start_date.replace(/-/g,'.')} — ${card.end_date.replace(/-/g,'.')}`};}
export function primaryCard(member:Member){return member.card||undefined;}
export function notify(e:unknown){wx.showToast({title:e instanceof Error?e.message:'操作失败，请重试',icon:'none',duration:3500});}
