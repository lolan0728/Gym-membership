export interface Card {id:string;kind:'year'|'month';start_date:string;end_date:string;status:'active'|'expired'|'upcoming'|'voided';voided_at:string|null;void_reason?:string;version:number;}
export interface CardHistory extends Card {event_type:'opened'|'renewed'|'updated'|'voided'|'migrated';selected_kind?:'year'|'month';remark:string;duration_days?:number;created_at:string;}
export interface Member {id:string;name:string;phone:string;card_number:string;note:string;version:number;created_at:string;card:Card|null;cardHistory:CardHistory[];}
export interface Store {name:string;phone:string;monthCardDays:number;yearCardDays:number;hasLogo:boolean;}
export interface ImportBatch {id:string;status:string;count:number;rows:any[];errors:{row:number;message:string}[];created_at?:string;committedAt?:string;}
export interface BackupJob {id:string;filePath:string;fileName:string;dataRevision:number;status:'local_saved'|'sent'|'email_failed';error:string;triggerSource:'manual'|'automatic'|'pre_restore';scheduledDate?:string;createdAt:string;sentAt?:string;}
export interface BackupSettings {directory:string;senderEmail:string;recipientEmail:string;scheduleTime:string;retentionCount:number;latest:BackupJob|null;automaticStatus:'waiting'|'completed'|'failed';automaticStatusText:string;today:string;latestAutomaticDate:string|null;initializedDate:string|null;}
export interface ReportMetrics {newMembers:number;newYear:number;newMonth:number;renewMembers:number;renewCount:number;renewYear:number;renewMonth:number;early:number;late:number;reopened:number;unclassified:number;voidCount:number;}
export interface ReportMember {id:string;name:string;phone:string;card_number:string;status:'active'|'expired'|'upcoming'|'voided'|'none';card:(Card&{kind:'year'|'month'})|null;expiredDays?:number;}
export interface MonthlyReport {month:string;generatedAt:string;today:string;storeName:string;metrics:ReportMetrics;unknownFirst:number;current:{total:number;active:number;upcoming:number;expired:number;voided:number;none:number;activeYear:number;activeMonth:number};trend:{month:string;newMembers:number;renewMembers:number}[];expiring:ReportMember[];expired:ReportMember[];}
export async function api<T=any>(path:string,options:RequestInit={}):Promise<T>{
  const headers=new Headers(options.headers);headers.set('x-gym-request','1');
  if(options.body&&!(options.body instanceof FormData))headers.set('content-type','application/json');
  const res=await fetch(`/api${path}`,{...options,headers,credentials:'same-origin'});
  if(!res.ok){let message='网络请求失败，请重试';try{const data=await res.json();message=Array.isArray(data.message)?data.message.join('；'):data.message||message;}catch{}
    if(res.status===401&&!path.endsWith('/login'))window.dispatchEvent(new Event('auth-expired'));throw new Error(message);
  }
  return res.json();
}
export const post=<T=any>(path:string,body:unknown={})=>api<T>(path,{method:'POST',body:JSON.stringify(body)});
export const patch=<T=any>(path:string,body:unknown)=>api<T>(path,{method:'PATCH',body:JSON.stringify(body)});
export async function upload<T=any>(path:string,file:File){const form=new FormData();form.append('file',file);return api<T>(path,{method:'POST',body:form});}
export async function desktopInvoke<T=any>(command:string,args:Record<string,unknown>={}):Promise<T>{
  const tauri=(window as any).__TAURI_INTERNALS__;
  if(!tauri)throw new Error('此功能只能在悦体健身桌面程序中使用');
  const {invoke}=await import('@tauri-apps/api/core');return invoke<T>(command,args);
}
export async function download(path:string,name:string){
  const response=await fetch(`/api${path}`,{credentials:'same-origin'});
  if(!response.ok){const e=await response.json().catch(()=>({message:'下载失败'}));throw new Error(e.message);}
  const url=URL.createObjectURL(await response.blob()),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);
}
export async function savePdf(path:string,name:string){
  const response=await fetch(`/api${path}`,{credentials:'same-origin'});
  if(!response.ok){const e=await response.json().catch(()=>({message:'PDF报表生成失败'}));throw new Error(e.message);}
  const bytes=Array.from(new Uint8Array(await response.arrayBuffer()));
  if((window as any).__TAURI_INTERNALS__)return desktopInvoke<string|null>('save_report_pdf',{fileName:name,bytes});
  const url=URL.createObjectURL(new Blob([new Uint8Array(bytes)],{type:'application/pdf'})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),10000);return name;
}
export const statusLabels:Record<string,string>={active:'有效',expired:'已到期',upcoming:'未生效',voided:'已作废'};
export const kindLabel=(kind:string)=>kind==='year'?'年卡':'月卡';
export function mainCard(member:Member):Card|undefined{return member.card||undefined;}
export const day=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export function addDays(date:string,days:number){const value=new Date(`${date}T00:00:00Z`);value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);}
const beijingDateTime=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
export function formatDateTime(value:string|Date){const p=Object.fromEntries(beijingDateTime.formatToParts(value instanceof Date?value:new Date(value)).map(x=>[x.type,x.value]));return `${p.year}/${p.month}/${p.day} ${p.hour}:${p.minute}:${p.second}`;}
export function formatDate(value:string){return value.slice(0,10).replaceAll('-','/');}
