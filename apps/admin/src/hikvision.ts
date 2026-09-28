import {desktopInvoke} from './api';
export const isDesktop=()=>!!(window as any).__TAURI_INTERNALS__;
export const normalizedName=(name:string)=>name.replace(/\s/g,'');
export function compatibleNames(a:string,b:string){a=normalizedName(a);b=normalizedName(b);return !!a&&!!b&&(a.startsWith(b)||b.startsWith(a));}
export interface HikvisionOrigin {phone:string;deviceName:string;approvedName?:string}
export interface HikvisionSettings {address:string;username:string;hasPassword:boolean}
export interface HikvisionPhoto {bytes:number[];mime:string;deviceName:string}
export async function hikvisionInvoke<T>(command:string,args:Record<string,unknown>={}):Promise<T>{
  try{return await desktopInvoke<T>(command,args);}catch(error:any){throw new Error(typeof error?.message==='string'?error.message:typeof error==='string'?error:'门禁操作失败，请查看诊断日志');}
}
