import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync } from 'node:fs';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Schema = typeof schema;
/** Common type for both drivers: code never depends on which one is in use. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;

export interface DbHandle {
  db: Db;
  driver: 'pglite' | 'postgres';
  close(): Promise<void>;
  ping(): Promise<void>;
}

/**
 * Migrations live in packages/db/drizzle. Bundled builds copy them next to the entry file,
 * so check both layouts (source: ../drizzle, bundle: ./drizzle).
 */
function defaultMigrationsDir(): string {
  const candidates = [new URL('../drizzle', import.meta.url), new URL('./drizzle', import.meta.url)].map(
    (u) => fileURLToPath(u),
  );
  const found = candidates.find((dir) => existsSync(`${dir}/meta/_journal.json`));
  if (!found) throw new Error(`Database migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

export interface OpenDbOptions {
  url?: string;
  dataDir?: string;
  migrationsDir?: string;
  /** Default true. Serverless deployments migrate at build time instead of on every cold start. */
  migrate?: boolean;
  /** Postgres pool size. Keep small on serverless: instances × pool must stay under the DB's limit. */
  maxConnections?: number;
}

/**
 * - `url` set → real Postgres (production; use the provider's pooled connection string on serverless).
 * - Otherwise → PGlite (embedded Postgres) at `dataDir`, or in memory when dataDir is "memory".
 */
export async function openDb(opts: OpenDbOptions): Promise<DbHandle> {
  const shouldMigrate = opts.migrate ?? true;
  const migrationsFolder = () => opts.migrationsDir ?? process.env.MIGRATIONS_DIR ?? defaultMigrationsDir();

  if (opts.url) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const sqlClient = postgres(opts.url, {
      max: opts.maxConnections ?? 10,
      idle_timeout: 20,
      connect_timeout: 10,
      // Transaction-mode poolers (Neon/Supabase "pooled" URLs) don't support prepared statements.
      prepare: false,
    });
    const db = drizzle(sqlClient, { schema });
    if (shouldMigrate) await migrate(db, { migrationsFolder: migrationsFolder() });
    return {
      db: db as unknown as Db,
      driver: 'postgres',
      close: () => sqlClient.end({ timeout: 5 }),
      ping: async () => {
        await sqlClient`select 1`;
      },
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const dir = opts.dataDir && opts.dataDir !== 'memory' ? opts.dataDir : undefined;
  if (dir) mkdirSync(dir, { recursive: true });
  const client = new PGlite(dir);
  const db = drizzle(client, { schema });
  if (shouldMigrate) await migrate(db, { migrationsFolder: migrationsFolder() });
  return {
    db: db as unknown as Db,
    driver: 'pglite',
    close: () => client.close(),
    ping: async () => {
      await client.query('select 1');
    },
  };
}
