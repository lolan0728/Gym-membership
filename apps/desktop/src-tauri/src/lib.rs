use chrono::Local;
use keyring::Entry;
use lettre::message::{header::ContentType, Attachment, Mailbox, MultiPart, SinglePart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters};
use lettre::{Message, SmtpTransport, Transport};
use reqwest::blocking::Client;
use serde::Deserialize;
use serde_json::json;
use std::fs;
use std::fs::OpenOptions;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

const SMTP_SERVICE: &str = "JOYFIT Backup";

fn windows_path(path:PathBuf)->PathBuf{let value=path.to_string_lossy();PathBuf::from(value.strip_prefix(r"\\?\").unwrap_or(&value))}

struct DesktopState {
    base_url: String,
    token: String,
    child: Mutex<Option<Child>>,
    closing: AtomicBool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupJob { id:String, file_path:String, file_name:String }

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupSettings { directory:String, sender_email:String, recipient_email:String, schedule_time:String }

#[derive(Deserialize)]
struct RunResult { job:BackupJob }

#[derive(Deserialize)]
struct PendingResult { job:Option<BackupJob>, settings:BackupSettings }

fn client()->Result<Client,String>{Client::builder().no_proxy().timeout(Duration::from_secs(30)).build().map_err(|e|e.to_string())}

fn pending(state:&DesktopState)->Result<PendingResult,String>{
    client()?.get(format!("{}/api/desktop/backup/pending",state.base_url)).header("x-desktop-token",&state.token).send().map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().map_err(|e|e.to_string())
}

fn mark_email(state:&DesktopState,id:&str,ok:bool,error:&str){
    let _=client().and_then(|c|c.post(format!("{}/api/desktop/backup/{}/email",state.base_url,id)).header("x-desktop-token",&state.token).json(&json!({"ok":ok,"error":error})).send().map_err(|e|e.to_string()).map(|_|()));
}

fn smtp_password(sender:&str)->Result<String,String>{Entry::new(SMTP_SERVICE,sender).map_err(|e|e.to_string())?.get_password().map_err(|_|"尚未保存QQ邮箱SMTP授权码".to_string())}

fn send_message(settings:&BackupSettings,attachment:Option<&BackupJob>,test:bool)->Result<(),String>{
    if settings.sender_email.is_empty(){return Err("请先填写QQ发件邮箱".into())}
    let password=smtp_password(&settings.sender_email)?;
    let from:Mailbox=settings.sender_email.parse().map_err(|_|"QQ发件邮箱格式不正确".to_string())?;
    let recipient=if settings.recipient_email.is_empty(){&settings.sender_email}else{&settings.recipient_email};
    let to:Mailbox=recipient.parse().map_err(|_|"收件邮箱格式不正确".to_string())?;
    let now=Local::now();
    let subject=if test{"悦体健身自动备份测试邮件".to_string()}else{format!("悦体健身会员数据备份 {}",now.format("%Y-%m-%d %H:%M"))};
    let text=if test{"这是一封测试邮件。悦体健身Windows单机版已经可以使用QQ邮箱发送每日备份。".to_string()}else{format!("悦体健身会员数据已于 {} 完成Excel备份。附件可用于完整数据恢复。",now.format("%Y-%m-%d %H:%M:%S"))};
    let builder=Message::builder().from(from).to(to).subject(subject);
    let message=if let Some(job)=attachment{
        let bytes=fs::read(&job.file_path).map_err(|e|format!("读取备份文件失败：{e}"))?;
        let content_type=ContentType::parse("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").map_err(|e|e.to_string())?;
        builder.multipart(MultiPart::mixed().singlepart(SinglePart::plain(text)).singlepart(Attachment::new(job.file_name.clone()).body(bytes,content_type))).map_err(|e|e.to_string())?
    }else{builder.body(text).map_err(|e|e.to_string())?};
    let tls=TlsParameters::new("smtp.qq.com".to_string()).map_err(|e|e.to_string())?;
    let mailer=SmtpTransport::builder_dangerous("smtp.qq.com").port(465).tls(Tls::Wrapper(tls)).credentials(Credentials::new(settings.sender_email.clone(),password)).timeout(Some(Duration::from_secs(15))).build();
    mailer.send(&message).map_err(|e|format!("QQ邮箱发送失败：{e}"))?;Ok(())
}

fn send_pending(state:&DesktopState)->Result<bool,String>{
    let result=pending(state)?;let Some(job)=result.job else{return Ok(false)};
    match send_message(&result.settings,Some(&job),false){Ok(())=>{mark_email(state,&job.id,true,"");Ok(true)},Err(e)=>{mark_email(state,&job.id,false,&e);Err(e)}}
}

fn execute_backup(state:&DesktopState,force:bool)->Result<String,String>{
    let result:RunResult=client()?.post(format!("{}/api/desktop/backup/run",state.base_url)).header("x-desktop-token",&state.token).json(&json!({"force":force})).send().map_err(|e|e.to_string())?.error_for_status().map_err(|e|e.to_string())?.json().map_err(|e|e.to_string())?;
    match pending(state){Ok(p) if !p.settings.sender_email.is_empty()&&!p.settings.recipient_email.is_empty()=>{send_pending(state)?;Ok(format!("{}（邮件已发送）",result.job.file_name))},_=>Ok(format!("{}（已保存到本地）",result.job.file_name))}
}

#[tauri::command]
fn save_smtp_credential(sender_email:String,authorization_code:String)->Result<(),String>{
    if sender_email.trim().is_empty()||authorization_code.trim().is_empty(){return Err("请填写QQ邮箱和SMTP授权码".into())}
    Entry::new(SMTP_SERVICE,sender_email.trim()).map_err(|e|e.to_string())?.set_password(authorization_code.trim()).map_err(|e|e.to_string())
}

#[tauri::command]
fn test_backup_email(state:tauri::State<'_,Arc<DesktopState>>)->Result<(),String>{let result=pending(&state)?;send_message(&result.settings,None,true)}

#[tauri::command]
fn run_backup(state:tauri::State<'_,Arc<DesktopState>>,force:bool)->Result<String,String>{execute_backup(&state,force)}

#[tauri::command]
fn choose_backup_directory(current:String)->Result<String,String>{
    let mut dialog=rfd::FileDialog::new();if !current.is_empty(){dialog=dialog.set_directory(&current)}
    Ok(dialog.pick_folder().map(|p|p.to_string_lossy().to_string()).unwrap_or(current))
}

#[tauri::command]
fn open_backup_directory(state:tauri::State<'_,Arc<DesktopState>>)->Result<(),String>{
    let settings=pending(&state)?.settings;fs::create_dir_all(&settings.directory).map_err(|e|e.to_string())?;
    Command::new("explorer.exe").arg(&settings.directory).spawn().map_err(|e|e.to_string())?;Ok(())
}

fn start_server(app:&tauri::AppHandle)->Result<Arc<DesktopState>,String>{
    let resource=windows_path(app.path().resource_dir().map_err(|e|e.to_string())?);
    let data=app.path().app_local_data_dir().map_err(|e|e.to_string())?;
    let documents=app.path().document_dir().map_err(|e|e.to_string())?;
    let database=data.join("database");
    let uploads=data.join("uploads");
    let backup=documents.join("悦体健身").join("自动备份");
    for path in [&data,&database,&uploads,&backup]{fs::create_dir_all(path).map_err(|e|e.to_string())?}
    let packaged=if resource.join("runtime/node.exe").exists(){resource.clone()}else{resource.join("resources")};
    let node=packaged.join("runtime/node.exe");
    let entry=packaged.join("server/api/dist/main.js");
    let admin=packaged.join("server/admin/dist");
    let log_path=data.join("desktop.log");
    fs::write(&log_path,format!("resource={}\npackaged={}\nnode={}\nentry={}\n",resource.display(),packaged.display(),node.display(),entry.display())).map_err(|e|e.to_string())?;
    if !node.exists()||!entry.exists(){return Err(format!("桌面运行资源不完整：{}",packaged.display()))}
    let token=Uuid::new_v4().to_string();
    let base_url="http://127.0.0.1:15273".to_string();
    let output=OpenOptions::new().create(true).append(true).open(&log_path).map_err(|e|e.to_string())?;
    let error=output.try_clone().map_err(|e|e.to_string())?;
    let mut command=Command::new(node);command.arg(entry).current_dir(packaged.join("server/api")).env("NODE_ENV","production").env("DESKTOP_MODE","true").env("DB_DRIVER","pglite").env("PGLITE_PATH",database).env("STORAGE_DRIVER","local").env("LOCAL_STORAGE_PATH",uploads).env("JOYFIT_BACKUP_PATH",backup).env("ADMIN_DIST_PATH",admin).env("DESKTOP_CONTROL_TOKEN",&token).env("ADMIN_ORIGIN",&base_url).env("HOST","127.0.0.1").env("PORT","15273").stdin(Stdio::null()).stdout(Stdio::from(output)).stderr(Stdio::from(error));
    #[cfg(windows)] command.creation_flags(CREATE_NO_WINDOW);
    let child=command.spawn().map_err(|e|format!("无法启动本地服务：{e}"))?;
    let state=Arc::new(DesktopState{base_url:base_url.clone(),token,child:Mutex::new(Some(child)),closing:AtomicBool::new(false)});
    let http=client()?;let mut ready=false;for _ in 0..100{if http.get(format!("{base_url}/api/health")).send().map(|r|r.status().is_success()).unwrap_or(false){ready=true;break}thread::sleep(Duration::from_millis(200));}
    if !ready{if let Some(mut child)=state.child.lock().unwrap().take(){let _=child.kill();}return Err("本地服务启动超时".into())}
    Ok(state)
}

fn schedule(state:Arc<DesktopState>){thread::spawn(move||{let mut last_day=String::new();loop{thread::sleep(Duration::from_secs(30));let now=Local::now();let day=now.format("%Y-%m-%d").to_string();let time=now.format("%H:%M").to_string();if let Ok(p)=pending(&state){if time>=p.settings.schedule_time&&last_day!=day{let _=execute_backup(&state,false);last_day=day;}}}});}

pub fn run(){
    let instance=single_instance::SingleInstance::new("JOYFIT-Membership-Desktop-7F913F47").expect("无法创建单实例锁");
    if !instance.is_single(){return;}
    let app=tauri::Builder::default().plugin(tauri_plugin_single_instance::init(|app,_,_|{if let Some(window)=app.get_webview_window("main"){let _=window.set_focus();}})).invoke_handler(tauri::generate_handler![save_smtp_credential,test_backup_email,run_backup,choose_backup_directory,open_backup_directory]).setup(|app|{
        let state=start_server(app.handle()).map_err(std::io::Error::other)?;app.manage(state.clone());
        let url=state.base_url.parse().map_err(|e|std::io::Error::other(format!("{e}")))?;
        let window=WebviewWindowBuilder::new(app,"main",WebviewUrl::External(url)).title("悦体健身 · JOYFIT 会员管理").inner_size(1280.0,820.0).min_inner_size(1024.0,680.0).center().build()?;
        let close_state=state.clone();window.on_window_event(move|event|if let WindowEvent::CloseRequested{..}=event{if !close_state.closing.swap(true,Ordering::SeqCst){let _=execute_backup(&close_state,false);}});
        let startup=state.clone();thread::spawn(move||{let _=send_pending(&startup);});schedule(state);Ok(())
    }).build(tauri::generate_context!()).expect("无法启动悦体健身会员管理程序");
    app.run(|handle,event|if let RunEvent::Exit=event{let state=handle.state::<Arc<DesktopState>>();if let Some(mut child)=state.child.lock().unwrap().take(){let _=child.kill();};});
}
