import {existsSync,writeFileSync} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..');
if(existsSync(resolve(root,'.env'))){console.log('Existing .env preserved. No credentials were changed.');process.exit(0);}
const password=randomBytes(18).toString('base64url');
writeFileSync(resolve(root,'.env'),`NODE_ENV=development\nPORT=3000\nHOST=127.0.0.1\nADMIN_ORIGIN=http://localhost:15173\nPUBLIC_URL=http://localhost:3000\nDB_DRIVER=pglite\nPGLITE_PATH=../../.local-data/db\nLOCAL_STORAGE_PATH=../../.local-data/uploads\nSTORAGE_DRIVER=local\nADMIN_INITIAL_PASSWORD=${password}\nWECHAT_APP_ID=\nWECHAT_APP_SECRET=\n`,{mode:0o600});
writeFileSync(resolve(root,'.local-credentials.txt'),`本地后台：http://localhost:15173\n管理员密码：${password}\n\n此密码仅用于本地开发。请勿提交或分享此文件。首次启动后可在后台修改密码。\n`,{mode:0o600});
console.log('Local configuration created. See .local-credentials.txt for your generated password. Run npm run dev.');
