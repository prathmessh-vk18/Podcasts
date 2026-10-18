import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { createRepos, type DbHandle } from '@tangent/db';
import type { Logger } from '@tangent/providers';
import type { Config } from './config.js';
import { createRunner, type JobRunner } from './jobs/runner.js';
import { TokenCipher } from './lib/crypto.js';
import { errorHandler } from './lib/errors.js';
import { registerSession } from './lib/session.js';
import { registerRoutes } from './routes/index.js';
import { ConnectionService } from './services/connections.js';
import { DiscoverService, type ShowSource } from './services/discover.js';
import { ExportService } from './services/exports.js';
import { LibraryService } from './services/library.js';
import { ProviderRegistry } from './services/registry.js';

export interface AppDeps {
  config: Config;
  db: DbHandle;
  /** Override providers (tests inject fakes). Defaults to config-driven real providers. */
  registry?: ProviderRegistry;
  /** Source of curated show episodes for Discover. Defaults to the Apple provider. */
  showSource?: ShowSource;
  /** Override where background jobs run (tests). Defaults from config.runtime. */
  runner?: JobRunner;
  /** Delay between shows during catalog refresh (0 in tests). */
  catalogPacingMs?: number;
  now?: () => Date;
  logger?: boolean | object;
}

/** OAuth callbacks carry `code` and `state` in the query string; never log them. */
function redactUrl(url: string): string {
  return url.replace(/([?&](?:code|state|token)=)[^&]*/gi, '$1[redacted]');
}

export async function buildApp(
  deps: AppDeps,
): Promise<{ app: FastifyInstance; exports: ExportService; discover: DiscoverService; queue: JobRunner }> {
  const { config, db } = deps;
  const app = Fastify({
    logger: deps.logger ?? {
      level: config.LOG_LEVEL,
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        censor: '[redacted]',
      },
      serializers: {
        req: (req: { method: string; url: string; id: string }) => ({
          id: req.id,
          method: req.method,
          url: redactUrl(req.url),
        }),
      },
      ...(config.isProd || config.runtime === 'serverless'
        ? {}
        : { transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss' } } }),
    },
    trustProxy: config.isProd,
    bodyLimit: 100 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
  });

  const log = app.log as unknown as Logger;
  const now = deps.now ?? (() => new Date());
  const repos = createRepos(db.db);
  const registry = deps.registry ?? ProviderRegistry.fromConfig(config, db.db, log);
  const cipher = new TokenCipher(config.encryptionKeys.current, config.encryptionKeys.old);
  const queue = deps.runner ?? (await createRunner(config.runtime, config.JOB_CONCURRENCY, log));
  const connections = new ConnectionService(config, repos, registry, cipher, log, now);
  const library = new LibraryService(repos, registry, log, now);
  const exports = new ExportService(config, repos, registry, connections, queue, log, now);
  const showSource = deps.showSource ?? registry.showSource();
  const discover = new DiscoverService(repos, showSource, queue, log, now, deps.catalogPacingMs);

  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await app.register(cors, {
    origin: [config.WEB_ORIGIN],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['content-type', 'x-tangent-csrf', 'x-request-id'],
    maxAge: 600,
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

  // Action endpoints (execute, retry, cancel) take no body, but clients often still send the JSON
  // content type. Treat an empty JSON body as {} instead of rejecting the request.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString('utf8');
    if (text.trim() === '') return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      const err = Object.assign(new Error('Request body is not valid JSON'), { statusCode: 400 });
      done(err, undefined);
    }
  });

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send({
      error: {
        code: 'not_found',
        message: `No route for ${req.method} ${redactUrl(req.url)}`,
        retryable: false,
      },
    }),
  );

  registerSession(app, repos, { secure: config.isProd });
  registerRoutes(app, { config, library, connections, exports, discover, registry, ping: db.ping });

  app.addHook('onClose', async () => {
    await queue.close();
  });

  return { app, exports, discover, queue };
}
