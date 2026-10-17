import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { buildPlan, type EpisodeCandidate, type MatchResult } from '@tangent/core';
import { createRepos, DbQuotaStore, openDb, type DbHandle, type Repos } from '../src/index.js';

let h: DbHandle;
let repos: Repos;
let userId: string;

const cand = (id: string, extra: Partial<EpisodeCandidate> = {}): EpisodeCandidate => ({
  ref: { platform: 'apple', id, url: `https://podcasts.apple.com/x?i=${id}` },
  title: `Episode ${id}`,
  showTitle: 'Hidden Brain',
  publishedAt: new Date('2026-09-14T08:00:00Z'),
  durationSec: 3534,
  popularity: {
    available: true,
    kind: 'rating',
    value: 4.8,
    source: 'apple',
    retrievedAt: new Date('2026-10-01T00:00:00Z'),
  },
  ...extra,
});

beforeAll(async () => {
  h = await openDb({ dataDir: 'memory' });
  repos = createRepos(h.db);
  userId = await repos.users.create();
});
afterAll(async () => {
  await h.close();
});

describe('migrations and constraints', () => {
  it('applies migrations and answers ping', async () => {
    await expect(h.ping()).resolves.toBeUndefined();
  });
  it('rejects invalid enum values at the database level', async () => {
    await expect(
      h.db.execute(sql`insert into collections (user_id, name, privacy) values (${userId}, 'x', 'everyone')`),
    ).rejects.toThrow();
  });
  it('rejects empty collection names', async () => {
    await expect(
      h.db.execute(sql`insert into collections (user_id, name) values (${userId}, '')`),
    ).rejects.toThrow();
  });
});

describe('episodes', () => {
  it('upserts by source identity and refreshes metadata', async () => {
    const a = await repos.episodes.upsert(cand('1'));
    const b = await repos.episodes.upsert(cand('1', { title: 'Renamed by the provider' }));
    expect(b.id).toBe(a.id);
    expect(b.title).toBe('Renamed by the provider');
  });
  it('drops non-positive durations instead of violating the constraint', async () => {
    const row = await repos.episodes.upsert(cand('zero', { durationSec: 0 }));
    expect(row.durationSec).toBeNull();
  });
});

describe('collections', () => {
  it('adds items in order, ignores duplicates and reorders', async () => {
    const col = await repos.collections.create({ userId, name: 'Decisions' });
    const e1 = await repos.episodes.upsert(cand('c1'));
    const e2 = await repos.episodes.upsert(cand('c2'));
    const e3 = await repos.episodes.upsert(cand('c3'));
    const i1 = await repos.collections.addItem(col.id, e1.id);
    await repos.collections.addItem(col.id, e2.id);
    await repos.collections.addItem(col.id, e3.id);
    expect((await repos.collections.addItem(col.id, e1.id)).added).toBe(false);

    const items = await repos.collections.items(col.id);
    expect(items.map((r) => r.item.position)).toEqual([0, 1, 2]);

    const reversed = items.map((r) => r.item.id).reverse();
    await repos.collections.reorder(col.id, reversed);
    expect((await repos.collections.items(col.id)).map((r) => r.item.id)).toEqual(reversed);

    await expect(repos.collections.reorder(col.id, reversed.slice(1))).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(
      repos.collections.reorder(col.id, [reversed[0]!, reversed[0]!, reversed[1]!]),
    ).rejects.toMatchObject({ code: 'validation' });
    expect(i1.added).toBe(true);
  });

  it('gives concurrent adds distinct positions', async () => {
    const col = await repos.collections.create({ userId, name: 'Race' });
    const eps = await Promise.all(['r1', 'r2', 'r3', 'r4'].map((id) => repos.episodes.upsert(cand(id))));
    await Promise.all(eps.map((e) => repos.collections.addItem(col.id, e.id)));
    const positions = (await repos.collections.items(col.id)).map((r) => r.item.position).sort();
    expect(new Set(positions).size).toBe(4);
  });

  it("hides other users' and deleted collections, and restores", async () => {
    const other = await repos.users.create();
    const col = await repos.collections.create({ userId, name: 'Mine' });
    expect(await repos.collections.get(col.id, other)).toBeNull();
    expect(await repos.collections.softDelete(col.id, userId, new Date())).toBe(true);
    expect(await repos.collections.get(col.id, userId)).toBeNull();
    expect((await repos.collections.list(userId)).some((c) => c.id === col.id)).toBe(false);
    expect(await repos.collections.restore(col.id, userId)).not.toBeNull();
    expect(await repos.collections.get(col.id, userId)).not.toBeNull();
  });
});

describe('oauth states', () => {
  it('can be consumed once, only by its user, only before expiry', async () => {
    const now = new Date();
    await repos.oauthStates.create({
      state: 's1',
      userId,
      platform: 'spotify',
      codeVerifier: 'v',
      returnTo: null,
      expiresAt: new Date(now.getTime() + 60_000),
    });
    const other = await repos.users.create();
    expect(await repos.oauthStates.consume('s1', other, now)).toBeNull();
    expect(await repos.oauthStates.consume('s1', userId, now)).not.toBeNull();
    expect(await repos.oauthStates.consume('s1', userId, now)).toBeNull(); // replay

    await repos.oauthStates.create({
      state: 's2',
      userId,
      platform: 'spotify',
      codeVerifier: 'v',
      returnTo: null,
      expiresAt: new Date(now.getTime() - 1),
    });
    expect(await repos.oauthStates.consume('s2', userId, now)).toBeNull(); // expired
  });
});

describe('matches cache', () => {
  it('round-trips dates inside JSON and respects max age', async () => {
    const ep = await repos.episodes.upsert(cand('m1'));
    const result: MatchResult = {
      status: 'strong',
      confidence: 0.95,
      candidate: cand('m1-sp'),
      evidence: [],
      alternatives: [],
    };
    await repos.matches.put(ep.id, 'spotify', result);
    const got = await repos.matches.get(ep.id, 'spotify', new Date(), 7 * 86_400_000);
    expect(got?.candidate?.publishedAt).toBeInstanceOf(Date);
    expect(
      got?.candidate?.popularity &&
        'retrievedAt' in got.candidate.popularity &&
        got.candidate.popularity.retrievedAt,
    ).toBeInstanceOf(Date);
    expect(
      await repos.matches.get(ep.id, 'spotify', new Date(Date.now() + 8 * 86_400_000), 7 * 86_400_000),
    ).toBeNull();
  });
});

describe('exports', () => {
  it('is idempotent per user and key, and transitions with compare-and-set', async () => {
    const col = await repos.collections.create({ userId, name: 'Export me' });
    const ep = await repos.episodes.upsert(cand('x1'));
    const match: MatchResult = {
      status: 'exact',
      confidence: 1,
      candidate: null,
      evidence: [],
      alternatives: [],
    };
    const items = buildPlan([{ itemId: crypto.randomUUID(), episodeId: ep.id, position: 0, match }]);
    const input = {
      userId,
      collectionId: col.id,
      destination: 'spotify' as const,
      status: 'ready' as const,
      idempotencyKey: 'key-1',
      playlistTitle: 'P',
      items,
    };

    const [a, b] = await Promise.all([
      repos.exports.create(input),
      repos.exports.create({
        ...input,
        items: buildPlan([{ itemId: crypto.randomUUID(), episodeId: ep.id, position: 0, match }]),
      }),
    ]);
    expect(a.job.id).toBe(b.job.id);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await repos.exports.items(a.job.id)).toHaveLength(1);

    const [r1, r2] = await Promise.all([
      repos.exports.transition(a.job.id, ['ready'], 'running'),
      repos.exports.transition(a.job.id, ['ready'], 'running'),
    ]);
    expect([r1, r2].filter(Boolean)).toHaveLength(1); // only one runner wins
    expect((await repos.exports.listRunning()).map((j) => j.id)).toContain(a.job.id);
  });
});

describe('DbQuotaStore', () => {
  it('consumes atomically and never exceeds the limit under concurrency', async () => {
    const store = new DbQuotaStore(h.db);
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.tryConsume('yt', '2026-10-17', 30, 100)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await store.used('yt', '2026-10-17')).toBe(90);
    expect(await store.tryConsume('yt', '2026-10-17', 200, 100)).toBe(false);
  });
});
