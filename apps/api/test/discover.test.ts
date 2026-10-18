import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { openDb, schema, type DbHandle } from '@tangent/db';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { JobRunner } from '../src/jobs/runner.js';
import type { ExportService } from '../src/services/exports.js';
import { ProviderRegistry } from '../src/services/registry.js';
import { ep, FakeCatalog, FakeDestination } from './fakes.js';

const CRON_SECRET = 'test-cron-secret-123456';
const config = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', CRON_SECRET, RUNTIME: 'server' });

let db: DbHandle;
let app: FastifyInstance;
let queue: JobRunner;
let exportsSvc: ExportService;
let apple: FakeCatalog;

// Real curated show ids from catalog-seed.ts: The Knowledge Project (decisions), Huberman Lab (health).
const KP = '990149481';
const HUB = '1545953110';

beforeEach(async () => {
  db = await openDb({ dataDir: 'memory' });
  apple = new FakeCatalog('apple');
  for (let i = 0; i < 5; i++) {
    apple.add(
      ep('apple', `kp${i}`, {
        showRef: { platform: 'apple', id: KP, url: '' },
        showTitle: 'The Knowledge Project',
        publishedAt: new Date(Date.UTC(2026, 9, 10 - i)),
      }),
    );
  }
  apple.add(
    ep('apple', 'hub0', {
      showRef: { platform: 'apple', id: HUB, url: '' },
      showTitle: 'Huberman Lab',
      publishedAt: new Date(Date.UTC(2026, 9, 12)),
    }),
  );
  const spotify = new FakeDestination('spotify');
  const registry = new ProviderRegistry(
    { apple, spotify: new FakeCatalog('spotify') },
    { spotify },
    { spotify },
  );
  ({
    app,
    queue,
    exports: exportsSvc,
  } = await buildApp({ config, db, registry, logger: false, catalogPacingMs: 0 }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

const get = async (url: string) => (await app.inject({ method: 'GET', url })).json();

describe('discover', () => {
  it('warms an empty catalog on first visit, then serves the feed', async () => {
    const first = await get('/v1/discover/feed');
    expect(first).toMatchObject({ items: [], warming: true });
    await queue.onIdle();
    const feed = await get('/v1/discover/feed?limit=50');
    expect(feed.warming).toBe(false);
    expect(feed.items).toHaveLength(6);
    expect(feed.items[0].sourceId).toBe('hub0'); // newest first
  });

  it('filters by topic and pages with a cursor without overlap', async () => {
    await get('/v1/discover/feed');
    await queue.onIdle();
    const p1 = await get('/v1/discover/feed?topic=decisions&limit=2');
    expect(p1.items.map((i: { sourceId: string }) => i.sourceId)).toEqual(['kp0', 'kp1']);
    const p2 = await get(`/v1/discover/feed?topic=decisions&limit=2&cursor=${p1.nextCursor}`);
    expect(p2.items.map((i: { sourceId: string }) => i.sourceId)).toEqual(['kp2', 'kp3']);
    const p3 = await get(`/v1/discover/feed?topic=decisions&limit=2&cursor=${p2.nextCursor}`);
    expect(p3.items.map((i: { sourceId: string }) => i.sourceId)).toEqual(['kp4']);
    expect(p3.nextCursor).toBeNull();
    expect((await get('/v1/discover/feed?topic=health')).items).toHaveLength(1);
  });

  it('ignores a tampered cursor instead of failing', async () => {
    await get('/v1/discover/feed');
    await queue.onIdle();
    const res = await app.inject('/v1/discover/feed?cursor=not-a-real-cursor');
    expect(res.statusCode).toBe(200);
  });

  it('rejects unknown topic formats', async () => {
    expect((await app.inject('/v1/discover/feed?topic=DROP%20TABLE')).statusCode).toBe(400);
  });

  it('shows one episode per show in trending and summarises topics', async () => {
    await get('/v1/discover/feed');
    await queue.onIdle();
    const trending = await get('/v1/discover/trending');
    expect(trending.items.map((i: { sourceId: string }) => i.sourceId)).toEqual(['hub0', 'kp0']);
    const { topics } = await get('/v1/topics');
    expect(topics.find((t: { id: string }) => t.id === 'decisions')).toMatchObject({ episodeCount: 5 });
    expect(topics.find((t: { id: string }) => t.id === 'decisions').shows.length).toBeGreaterThan(0);
  });

  it('keeps existing topic tags when a show is refreshed again', async () => {
    await get('/v1/discover/feed');
    await queue.onIdle();
    await db.db.update(schema.catalogShows).set({ lastRefreshedAt: new Date(0) });
    await app.inject({
      method: 'GET',
      url: '/internal/cron',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    const [row] = await db.db
      .select()
      .from(schema.episodes)
      .where(eq(schema.episodes.sourceEpisodeId, 'kp0'));
    expect(row!.topicTags).toEqual(['decisions']);
  });
});

describe('cron', () => {
  it('hides itself without the right secret', async () => {
    expect((await app.inject('/internal/cron')).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'GET', url: '/internal/cron', headers: { authorization: 'Bearer wrong' } }))
        .statusCode,
    ).toBe(404);
  });

  it('refreshes the catalog with the right secret', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/internal/cron',
      headers: { authorization: `Bearer ${CRON_SECRET}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().catalog.refreshed).toBeGreaterThan(0);
  });
});

describe('job leases (serverless recovery)', () => {
  async function stalledPlanningJob() {
    const userId = (await db.db.insert(schema.users).values({}).returning())[0]!.id;
    const col = (await db.db.insert(schema.collections).values({ userId, name: 'C' }).returning())[0]!;
    const e = (
      await db.db
        .insert(schema.episodes)
        .values({
          sourcePlatform: 'apple',
          sourceEpisodeId: 'x1',
          canonicalUrl: 'u',
          title: 'Episode x1',
          showTitle: 'Hidden Brain',
        })
        .returning()
    )[0]!;
    await db.db.insert(schema.collectionItems).values({ collectionId: col.id, episodeId: e.id, position: 0 });
    const job = (
      await db.db
        .insert(schema.exportJobs)
        .values({
          userId,
          collectionId: col.id,
          destination: 'spotify',
          status: 'planning',
          idempotencyKey: 'k-lease-1',
        })
        .returning()
    )[0]!;
    return job;
  }

  it('does not run a job whose lease is held by another live worker', async () => {
    const job = await stalledPlanningJob();
    await db.db
      .update(schema.exportJobs)
      .set({ leaseUntil: new Date(Date.now() + 60_000) })
      .where(eq(schema.exportJobs.id, job.id));
    await exportsSvc.plan(job.id);
    const [after] = await db.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id));
    expect(after!.status).toBe('planning'); // untouched
  });

  it('resumes a job whose worker died (expired lease) and releases the lease afterwards', async () => {
    const job = await stalledPlanningJob();
    await db.db
      .update(schema.exportJobs)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.exportJobs.id, job.id));
    expect(await exportsSvc.resumeInterrupted()).toBe(1);
    await queue.onIdle();
    const [after] = await db.db.select().from(schema.exportJobs).where(eq(schema.exportJobs.id, job.id));
    expect(after!.status).toBe('ready');
    expect(after!.leaseUntil).toBeNull();
  });
});
