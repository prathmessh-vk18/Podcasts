import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config.js';
import type { ConnectionService } from '../services/connections.js';
import type { DiscoverService } from '../services/discover.js';
import type { ExportService } from '../services/exports.js';
import type { LibraryService } from '../services/library.js';
import type { ProviderRegistry } from '../services/registry.js';
import { episodeDto } from '../services/dto.js';
import * as s from './schemas.js';

export interface RouteDeps {
  config: Config;
  library: LibraryService;
  connections: ConnectionService;
  exports: ExportService;
  discover: DiscoverService;
  registry: ProviderRegistry;
  ping: () => Promise<void>;
}

export function registerRoutes(app: FastifyInstance, d: RouteDeps): void {
  // ---------------------------------------------------------------- health
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  app.get('/readyz', { config: { rateLimit: false } }, async (_req, reply) => {
    try {
      await d.ping();
      return { ok: true };
    } catch {
      return reply.status(503).send({ ok: false });
    }
  });

  // ---------------------------------------------------------------- cron (Vercel Cron / scheduler)
  // Refreshes the catalog and resumes stalled exports. Vercel sends `Authorization: Bearer <CRON_SECRET>`.
  app.get('/internal/cron', { config: { rateLimit: false } }, async (req, reply) => {
    const secret = d.config.CRON_SECRET;
    const given = Buffer.from(req.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${secret ?? ''}`);
    if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply.status(404).send({ error: { code: 'not_found', message: 'Not found', retryable: false } });
    }
    const resumed = await d.exports.resumeInterrupted();
    const catalog = await d.discover.refresh(200_000);
    return { ok: true, resumed, catalog };
  });

  // ---------------------------------------------------------------- platforms
  app.get('/v1/providers', async () => ({
    providers: d.registry.capabilities(),
    youtubeQuotaRemaining: d.registry.youtubeBudget ? await d.registry.youtubeBudget.remaining() : null,
  }));

  // ---------------------------------------------------------------- discovery
  app.get('/v1/search', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const q = s.searchQuery.parse(req.query);
    return { query: q.q, results: await d.library.search(q.q, q.platforms, q.limit) };
  });

  app.get('/v1/discover/feed', async (req) => {
    const q = s.feedQuery.parse(req.query);
    return d.discover.feed(q.topic ?? null, q.cursor ?? null, q.limit);
  });

  app.get('/v1/discover/trending', async (req) =>
    d.discover.trending(s.trendingQuery.parse(req.query).limit),
  );

  app.get('/v1/topics', async () => d.discover.topics());

  app.post('/v1/episodes/resolve', async (req, reply) => {
    const ref = s.episodeRef.parse(req.body);
    return reply.status(200).send(
      episodeDto(
        await d.library.resolveEpisode(ref.platform, ref.sourceId, {
          showId: ref.showId,
          title: ref.title,
        }),
      ),
    );
  });

  app.get('/v1/episodes/:id', async (req) => d.library.getEpisode(s.idParam.parse(req.params).id));

  // ---------------------------------------------------------------- collections
  app.get('/v1/library/saved', async (req) => d.library.saved(req.userId));

  app.get('/v1/collections', async (req) => ({ collections: await d.library.listCollections(req.userId) }));

  app.post('/v1/collections', async (req, reply) =>
    reply.status(201).send(await d.library.createCollection(req.userId, s.createCollection.parse(req.body))),
  );

  app.get('/v1/collections/:id', async (req) =>
    d.library.getCollection(req.userId, s.idParam.parse(req.params).id),
  );

  app.patch('/v1/collections/:id', async (req) =>
    d.library.updateCollection(
      req.userId,
      s.idParam.parse(req.params).id,
      s.updateCollection.parse(req.body),
    ),
  );

  app.delete('/v1/collections/:id', async (req, reply) => {
    await d.library.deleteCollection(req.userId, s.idParam.parse(req.params).id);
    return reply.status(204).send();
  });

  app.post('/v1/collections/:id/restore', async (req) =>
    d.library.restoreCollection(req.userId, s.idParam.parse(req.params).id),
  );

  app.post('/v1/collections/:id/items', async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    const result = await d.library.addToCollection(req.userId, id, s.episodeRef.parse(req.body));
    return reply.status(result.added ? 201 : 200).send(result);
  });

  app.delete('/v1/collections/:id/items/:itemId', async (req, reply) => {
    const { id, itemId } = s.itemParams.parse(req.params);
    await d.library.removeFromCollection(req.userId, id, itemId);
    return reply.status(204).send();
  });

  app.put('/v1/collections/:id/order', async (req, reply) => {
    const { id } = s.idParam.parse(req.params);
    await d.library.reorder(req.userId, id, s.reorderBody.parse(req.body).itemIds);
    return reply.status(204).send();
  });

  app.get('/v1/collections/:id/links', async (req) =>
    d.library.linkList(req.userId, s.idParam.parse(req.params).id),
  );

  // ---------------------------------------------------------------- connections (OAuth)
  app.get('/v1/connections', async (req) => ({ connections: await d.connections.list(req.userId) }));

  app.get('/v1/connections/:platform/start', async (req, reply) => {
    const { platform } = s.platformParam.parse(req.params);
    const { returnTo } = s.connectStartQuery.parse(req.query);
    return reply.redirect(await d.connections.start(req.userId, platform, returnTo), 302);
  });

  app.get('/v1/connections/:platform/callback', async (req, reply) => {
    const { platform } = s.platformParam.parse(req.params);
    const { returnTo, outcome } = await d.connections.callback(
      req.userId,
      platform,
      s.callbackQuery.parse(req.query),
    );
    const target = new URL(returnTo, d.config.WEB_ORIGIN);
    target.searchParams.set('connect', outcome);
    target.searchParams.set('platform', platform);
    return reply.redirect(target.toString(), 302);
  });

  app.delete('/v1/connections/:platform', async (req, reply) => {
    await d.connections.disconnect(req.userId, s.platformParam.parse(req.params).platform);
    return reply.status(204).send();
  });

  // ---------------------------------------------------------------- exports
  app.post(
    '/v1/exports',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const { job, created } = await d.exports.create(req.userId, s.createExport.parse(req.body));
      return reply.status(created ? 202 : 200).send(job);
    },
  );

  app.get('/v1/exports/:id', async (req) => d.exports.get(req.userId, s.idParam.parse(req.params).id));

  app.post('/v1/exports/:id/decisions', async (req) =>
    d.exports.decide(req.userId, s.idParam.parse(req.params).id, s.decisionsBody.parse(req.body).decisions),
  );

  app.post('/v1/exports/:id/execute', async (req, reply) =>
    reply.status(202).send(await d.exports.execute(req.userId, s.idParam.parse(req.params).id)),
  );

  app.post('/v1/exports/:id/retry', async (req, reply) =>
    reply
      .status(202)
      .send(await d.exports.execute(req.userId, s.idParam.parse(req.params).id, { retry: true })),
  );

  app.post('/v1/exports/:id/cancel', async (req) =>
    d.exports.cancel(req.userId, s.idParam.parse(req.params).id),
  );
}
