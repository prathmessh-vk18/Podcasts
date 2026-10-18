import { openDb } from '@tangent/db';

/**
 * Applies pending migrations. Runs during the Vercel build (before the new code goes live) and
 * can be run by hand: `npm run db:migrate -w @tangent/api`. Prefers a direct (unpooled)
 * connection for schema changes when the provider offers one.
 */
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!url) {
  process.stderr.write(
    'No DATABASE_URL set. On Vercel, connect a Postgres database to the API project (Storage → Neon).\n',
  );
  process.exit(1);
}
const started = Date.now();
const db = await openDb({ url, migrate: true, maxConnections: 1 });
await db.close();
process.stdout.write(`Migrations applied in ${Date.now() - started} ms\n`);
