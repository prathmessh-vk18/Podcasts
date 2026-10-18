import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { openDb } from '@tangent/db';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';

/**
 * Vercel function entry. One Fastify app per warm instance, created on the first request and
 * reused after that. Background work is attached to each invocation via `waitUntil`
 * (see jobs/runner.ts). If start-up fails, the next request retries instead of the instance
 * staying broken.
 */
let ready: Promise<FastifyInstance> | null = null;

async function init(): Promise<FastifyInstance> {
  const config = loadConfig();
  if (!config.DATABASE_URL && config.isProd) {
    throw new Error(
      'DATABASE_URL is required on Vercel. Connect a Postgres database (e.g. Neon) to this project.',
    );
  }
  const db = await openDb({
    url: config.DATABASE_URL,
    dataDir: config.PGLITE_DIR,
    migrate: config.autoMigrate, // false on Vercel: migrations run during the build
    maxConnections: 3,
  });
  const { app } = await buildApp({ config, db });
  for (const w of config.warnings) app.log.warn(w);
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    ready ??= init();
    const app = await ready;
    app.server.emit('request', req, res);
  } catch (err) {
    ready = null;
    process.stderr.write(`API failed to start: ${err instanceof Error ? err.stack : String(err)}\n`);
    res.statusCode = 503;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        error: { code: 'unavailable', message: 'Service is starting or misconfigured', retryable: true },
      }),
    );
  }
}
