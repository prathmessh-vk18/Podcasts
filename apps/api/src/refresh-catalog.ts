import { createRepos, openDb } from '@tangent/db';
import { AppleProvider } from '@tangent/providers';
import { loadConfig } from './config.js';
import { JobQueue } from './jobs/queue.js';
import { DiscoverService } from './services/discover.js';

/** Pull fresh episodes for every curated show now (local setup, or a manual production refresh). */
const config = loadConfig();
const db = await openDb({
  url: config.DATABASE_URL,
  dataDir: config.PGLITE_DIR,
  migrate: config.autoMigrate,
});
const log = {
  debug() {},
  info: (o: object, m?: string) => console.log(m ?? '', o),
  warn: (o: object, m?: string) => console.warn(m ?? '', o),
  error: (o: object, m?: string) => console.error(m ?? '', o),
};
const discover = new DiscoverService(
  createRepos(db.db),
  new AppleProvider({ country: config.APPLE_COUNTRY }),
  new JobQueue(1, log),
  log,
);
let report;
do {
  report = await discover.refresh(10 * 60_000);
} while (report.remaining && report.refreshed > 0);
await db.close();
