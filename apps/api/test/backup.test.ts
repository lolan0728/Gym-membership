import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {encryptFile,decryptFile,parseKey}=require('../../../ops/backup-crypto.cjs');
test('Backup AES-GCM round-trip, wrong key and tamper detection',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'gym-crypto-')),source=join(dir,'source'),encrypted=join(dir,'encrypted'),restored=join(dir,'restored'),key=randomBytes(32),data=randomBytes(140000);
  try{await writeFile(source,data);await encryptFile(source,encrypted,key);await decryptFile(encrypted,restored,key);assert.deepEqual(await readFile(restored),data);assert.throws(()=>parseKey('short'));await assert.rejects(decryptFile(encrypted,restored,randomBytes(32)));const changed=await readFile(encrypted);changed[100]^=1;await writeFile(encrypted,changed);await assert.rejects(decryptFile(encrypted,restored,key));}finally{await rm(dir,{recursive:true,force:true});}
});
