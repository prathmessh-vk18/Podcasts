import { openDb } from '@tangent/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const db = await openDb({ url: config.DATABASE_URL, dataDir: config.PGLITE_DIR });
  const { app, exports } = await buildApp({ config, db });

  for (const w of config.warnings) app.log.warn(w);
  app.log.info({ driver: db.driver }, 'database ready');

  const resumed = await exports.resumeInterrupted();
  if (resumed) app.log.info({ resumed }, 'resumed interrupted export jobs');

  await app.listen({ host: config.HOST, port: config.PORT });

  // Graceful shutdown: stop taking requests, let running jobs finish (bounded), close the DB.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 30_000);
    force.unref();
    try {
      await app.close();
      await db.close();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => app.log.error({ reason }, 'unhandled rejection'));
}

main().catch((err) => {
  // Logger may not exist yet (bad config); write plainly and exit non-zero.
  process.stderr.write(`Failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
