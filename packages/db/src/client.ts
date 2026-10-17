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
 * Migrations live in packages/db/drizzle. In the bundled API build they're copied next to
 * main.js, so check both layouts (source: ../drizzle, bundle: ./drizzle).
 */
function defaultMigrationsDir(): string {
  const candidates = [new URL('../drizzle', import.meta.url), new URL('./drizzle', import.meta.url)].map(
    (u) => fileURLToPath(u),
  );
  const found = candidates.find((dir) => existsSync(`${dir}/meta/_journal.json`));
  if (!found) throw new Error(`Database migrations not found (looked in ${candidates.join(', ')})`);
  return found;
}

/**
 * - DATABASE_URL set → real Postgres (production).
 * - Otherwise → PGlite (embedded Postgres) at `dataDir`, or in memory when dataDir is "memory".
 * Migrations run on open in both cases.
 */
export async function openDb(opts: {
  url?: string;
  dataDir?: string;
  migrationsDir?: string;
}): Promise<DbHandle> {
  const migrationsFolder = opts.migrationsDir ?? process.env.MIGRATIONS_DIR ?? defaultMigrationsDir();

  if (opts.url) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const sqlClient = postgres(opts.url, { max: 10, idle_timeout: 30, connect_timeout: 10, prepare: true });
    const db = drizzle(sqlClient, { schema });
    await migrate(db, { migrationsFolder });
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
  await migrate(db, { migrationsFolder });
  return {
    db: db as unknown as Db,
    driver: 'pglite',
    close: () => client.close(),
    ping: async () => {
      await client.query('select 1');
    },
  };
}
