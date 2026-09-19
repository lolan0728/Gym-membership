const {createCipheriv,createDecipheriv,randomBytes}=require('node:crypto');
const {createReadStream,createWriteStream}=require('node:fs');
const {open,stat}=require('node:fs/promises');
const {pipeline}=require('node:stream/promises');
const MAGIC=Buffer.from('GYMBKP01');
function parseKey(value){if(!/^[a-fA-F0-9]{64}$/.test(value||''))throw new Error('BACKUP_KEY_HEX must contain 64 hex characters');return Buffer.from(value,'hex');}
async function encryptFile(source,target,key){
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv),file=await open(target,'w',0o600);
  try{await file.write(Buffer.concat([MAGIC,iv]));}finally{await file.close();}
  await pipeline(createReadStream(source),cipher,createWriteStream(target,{flags:'a'}));
  const append=await open(target,'a');try{await append.write(cipher.getAuthTag());}finally{await append.close();}
}
async function decryptFile(source,target,key){
  const size=(await stat(source)).size;if(size<36)throw new Error('Invalid encrypted backup');
  const file=await open(source,'r'),header=Buffer.alloc(20),tag=Buffer.alloc(16);
  try{await file.read(header,0,20,0);await file.read(tag,0,16,size-16);}finally{await file.close();}
  if(!header.subarray(0,8).equals(MAGIC))throw new Error('Invalid backup header');
  const decipher=createDecipheriv('aes-256-gcm',key,header.subarray(8));decipher.setAuthTag(tag);
  await pipeline(createReadStream(source,{start:20,end:size-17}),decipher,createWriteStream(target,{mode:0o600}));
}
module.exports={parseKey,encryptFile,decryptFile};
