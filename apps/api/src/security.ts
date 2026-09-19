import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCallback);
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${hash.toString('hex')}`;
}
export async function verifyPassword(password: string, value: string) {
  const [algorithm,salt,hash] = value.split(':'); if (algorithm !== 'scrypt' || !salt || !hash) return false;
  const input = await scrypt(password, salt, 64) as Buffer; const expected = Buffer.from(hash,'hex');
  return input.length === expected.length && timingSafeEqual(input,expected);
}
