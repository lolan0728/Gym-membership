import { config } from 'dotenv';
import { resolve } from 'node:path';
config({ path: resolve(process.cwd(), '../../.env'), quiet: true });
config({ quiet: true });
export const production = () => process.env.NODE_ENV === 'production';
export const desktopMode = () => process.env.DESKTOP_MODE === 'true';
export function checkConfig() {
  if (!production() || desktopMode()) return;
  const required = ['DATABASE_URL','ADMIN_ORIGIN','PUBLIC_URL','WECHAT_APP_ID','WECHAT_APP_SECRET','COS_SECRET_ID','COS_SECRET_KEY','COS_BUCKET','COS_REGION'];
  for (const key of required) if (!process.env[key]) throw new Error(`Missing production configuration: ${key}`);
  if (process.env.DB_DRIVER !== 'postgres' || process.env.STORAGE_DRIVER !== 'cos') throw new Error('Production requires PostgreSQL and COS');
  for (const key of ['ADMIN_ORIGIN','PUBLIC_URL']) if (!process.env[key]?.startsWith('https://')) throw new Error(`${key} must use HTTPS`);
}
