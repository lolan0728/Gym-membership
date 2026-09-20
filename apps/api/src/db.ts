import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool, types } from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { hashPassword } from './security.js';
import { desktopMode } from './config.js';
import './config.js';
types.setTypeParser(1082, value => value);
export interface Result<T = any> { rows: T[]; rowCount: number | null }
export interface Queryable { query<T = any>(sql: string, args?: any[]): Promise<Result<T>> }
@Injectable()
export class Db implements Queryable, OnModuleInit, OnModuleDestroy {
  private pool?: Pool;
  private local?: PGlite;
  async onModuleInit() {
    if (process.env.DB_DRIVER === 'postgres') this.pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
    else { const { btree_gist } = await import('@electric-sql/pglite/contrib/btree_gist'); const path=process.env.PGLITE_PATH || 'memory://'; if(path!=='memory://')await mkdir(resolve(path),{recursive:true});this.local = new PGlite(path, { extensions: { btree_gist } }); }
    await this.migrate();
    // The desktop process owns the only local API instance. Clearing sessions
    // here makes every real application restart require the administrator
    // password while a second launch is still handled by Tauri's single-instance lock.
    if(desktopMode())await this.query("DELETE FROM sessions WHERE role='admin'");
    const existing = await this.query('SELECT id FROM administrators WHERE id=1');
    if (!existing.rows.length) {
      if (desktopMode()) return;
      const password = process.env.ADMIN_INITIAL_PASSWORD;
      if (!password || password.length < 12 || password.includes('REPLACE_')) throw new Error('Set a unique ADMIN_INITIAL_PASSWORD (at least 12 characters) before first start');
      await this.query('INSERT INTO administrators(id,password_hash) VALUES(1,$1) ON CONFLICT DO NOTHING', [await hashPassword(password)]);
    }
  }
  async migrate() {
    const directory=resolve(import.meta.dirname,'../migrations');
    const migrations=readdirSync(directory)
      .map(file=>({file,version:Number(file.match(/^(\d+)_.*\.sql$/)?.[1])}))
      .filter(migration=>Number.isInteger(migration.version))
      .sort((a,b)=>a.version-b.version);
    if (this.local) {
      await this.local.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY)');
      for(const migration of migrations){
        if((await this.local.query('SELECT 1 FROM schema_migrations WHERE version=$1',[migration.version])).rows.length)continue;
        await this.local.exec(readFileSync(resolve(directory,migration.file),'utf8'));
        await this.local.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
      }
    } else {
      const client = await this.pool!.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(8217942)');
        await client.query('CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY)');
        for(const migration of migrations){
          if((await client.query('SELECT 1 FROM schema_migrations WHERE version=$1',[migration.version])).rows.length)continue;
          await client.query(readFileSync(resolve(directory,migration.file),'utf8'));
          await client.query('INSERT INTO schema_migrations(version) VALUES($1)',[migration.version]);
        }
        await client.query('COMMIT');
      } catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
    }
  }
  async query<T = any>(sql: string, args: any[] = []): Promise<Result<T>> {
    if (this.pool) return this.pool.query(sql, args) as unknown as Promise<Result<T>>;
    const r = await this.local!.query<T>(sql, args); return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  }
  async tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
    if (this.local) return this.local.transaction(async tx => fn({ query: async (sql, args = []) => {
      const r = await tx.query(sql, args); return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
    } }));
    const client = await this.pool!.connect();
    try { await client.query('BEGIN'); const result = await fn(client); await client.query('COMMIT'); return result; }
    catch (e) { await client.query('ROLLBACK'); throw e; } finally { client.release(); }
  }
  async onModuleDestroy() { await this.pool?.end(); await this.local?.close(); }
}
