const COS=require('cos-nodejs-sdk-v5');
const {spawn}=require('node:child_process');
const {mkdir,mkdtemp,readFile,writeFile,rm,stat}=require('node:fs/promises');
const {createReadStream,createWriteStream}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {encryptFile,decryptFile,parseKey}=require('./backup-crypto.cjs');
const state=process.env.BACKUP_STATE_DIR||'/state',prefix=process.env.BACKUP_PREFIX||'gym-production/';
function client(){for(const k of ['BACKUP_COS_SECRET_ID','BACKUP_COS_SECRET_KEY','BACKUP_COS_BUCKET','BACKUP_COS_REGION'])if(!process.env[k]||process.env[k].includes('REPLACE'))throw new Error(`Missing ${k}`);return new COS({SecretId:process.env.BACKUP_COS_SECRET_ID,SecretKey:process.env.BACKUP_COS_SECRET_KEY});}
const location=Key=>({Bucket:process.env.BACKUP_COS_BUCKET,Region:process.env.BACKUP_COS_REGION,Key});
function command(name,args){return new Promise((resolve,reject)=>{const p=spawn(name,args,{stdio:['ignore','ignore','inherit'],env:process.env});p.on('error',reject);p.on('exit',code=>code===0?resolve():reject(new Error(`${name} failed with code ${code}`)));});}
async function notify(text){console.error(new Date().toISOString(),text);if(process.env.ALERT_WEBHOOK_URL){try{await fetch(process.env.ALERT_WEBHOOK_URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text}),signal:AbortSignal.timeout(10000)});}catch{console.error('Alert delivery failed');}}}
async function health(){const last=JSON.parse(await readFile(join(state,'last-success.json'),'utf8'));if(Date.now()-Date.parse(last.at)>26*3600000)throw new Error('Backup is older than 26 hours');}
async function backup(){
  const cos=client(),key=parseKey(process.env.BACKUP_KEY_HEX),base=process.env.BACKUP_TEMP_DIR||tmpdir();await mkdir(base,{recursive:true});const temp=await mkdtemp(join(base,'gym-backup-'));
  try{
    const dump=join(temp,'db.dump'),encrypted=join(temp,'db.enc');await command('pg_dump',['--format=custom','--no-owner','--no-acl','--file',dump]);await command('pg_restore',['--list',dump]);
    await encryptFile(dump,encrypted,key);const object=prefix+new Date().toISOString().replace(/[:.]/g,'-')+'.dump.enc';
    await cos.putObject({...location(object),Body:createReadStream(encrypted),ContentLength:(await stat(encrypted)).size,ACL:'private',ServerSideEncryption:'AES256'});
    await cos.headObject(location(object));await mkdir(state,{recursive:true});await writeFile(join(state,'last-success.json'),JSON.stringify({at:new Date().toISOString(),key:object}));
    // Delete only old objects created by this backup namespace, after a successful upload.
    let Marker='';do{const page=await cos.getBucket({Bucket:process.env.BACKUP_COS_BUCKET,Region:process.env.BACKUP_COS_REGION,Prefix:prefix,Marker,MaxKeys:1000});for(const item of page.Contents||[])if(item.Key?.startsWith(prefix)&&item.Key.endsWith('.dump.enc')&&Date.parse(item.LastModified)<Date.now()-30*86400000)await cos.deleteObject(location(item.Key));Marker=String(page.IsTruncated)==='true'?page.NextMarker||'':'';}while(Marker);
    console.log(new Date().toISOString(),'Encrypted backup uploaded and retention applied');
  }finally{await rm(temp,{recursive:true,force:true});}
}
async function restoreCheck(object){
  if(!object?.startsWith(prefix)||!object.endsWith('.dump.enc'))throw new Error('Provide a backup object key under BACKUP_PREFIX');
  const target=process.env.RESTORE_DATABASE;if(!/^gym_restore_[a-z0-9_]+$/.test(target||''))throw new Error('RESTORE_DATABASE must start with gym_restore_; production database names are refused');
  const cos=client(),key=parseKey(process.env.BACKUP_KEY_HEX),temp=await mkdtemp(join(process.env.BACKUP_TEMP_DIR||tmpdir(),'gym-restore-'));
  try{
    const encrypted=join(temp,'db.enc'),dump=join(temp,'db.dump');
    await cos.getObject({...location(object),Output:createWriteStream(encrypted)});
    await decryptFile(encrypted,dump,key);await command('pg_restore',['--list',dump]);
    await command('createdb',[target]);await command('pg_restore',['--exit-on-error','--single-transaction','--no-owner','--no-acl','--dbname',target,dump]);
    await command('psql',['--dbname',target,'--set','ON_ERROR_STOP=1','--command',"SELECT count(*) FROM members; SELECT count(*) FROM memberships; SELECT count(*) FROM membership_events; SELECT count(*) FROM audit_logs; SELECT indexname FROM pg_indexes WHERE indexname='memberships_one_per_member_idx';"]);
    console.log(`Restore verified in isolated database ${target}. Inspect it, then remove it explicitly when no longer needed.`);
  }finally{await rm(temp,{recursive:true,force:true});}
}
async function main(){const mode=process.argv[2]||'once';if(mode==='health')return health();if(mode==='restore-check')return restoreCheck(process.argv[3]);if(mode==='once')return backup();if(mode!=='schedule')throw new Error('Unknown mode');
  for(;;){try{await backup();}catch{await notify('Gym membership database backup FAILED. Inspect backup service logs and COS credentials.');}
    // Wait until the next 03:00 Beijing time. Restarting the worker also takes a fresh backup.
    const now=Date.now(),local=new Date(now+8*3600000),next=Date.UTC(local.getUTCFullYear(),local.getUTCMonth(),local.getUTCDate(),3)-8*3600000;
    await new Promise(resolve=>setTimeout(resolve,(next<=now?next+86400000:next)-now));
  }
}
main().catch(async()=>{await notify('Gym backup operation failed. Check database connectivity, encryption key and backup bucket.');process.exit(1);});
