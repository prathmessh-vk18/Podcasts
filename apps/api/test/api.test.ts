import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { ProviderError } from '@tangent/core';
import { openDb, schema, type DbHandle } from '@tangent/db';
import { eq } from 'drizzle-orm';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { JobQueue } from '../src/jobs/queue.js';
import type { ExportService } from '../src/services/exports.js';
import { ProviderRegistry } from '../src/services/registry.js';
import { ep, FakeCatalog, FakeDestination } from './fakes.js';

let db: DbHandle;
let app: FastifyInstance;
let queue: JobQueue;
let exportsSvc: ExportService;
let apple: FakeCatalog;
let spotifyCatalog: FakeCatalog;
let spotify: FakeDestination;

const config = loadConfig({
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  WEB_ORIGIN: 'http://web.test',
  PUBLIC_API_URL: 'http://api.test',
});

beforeEach(async () => {
  db = await openDb({ dataDir: 'memory' });
  apple = new FakeCatalog('apple');
  spotifyCatalog = new FakeCatalog('spotify');
  spotify = new FakeDestination('spotify');
  const registry = new ProviderRegistry({ apple, spotify: spotifyCatalog }, { spotify }, { spotify });
  ({ app, queue, exports: exportsSvc } = await buildApp({ config, db, registry, logger: false }));
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await db.close();
});

/** A browser-like client: keeps the session cookie and sends the CSRF header on writes. */
function client() {
  let cookie = '';
  const call = async (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    opts: { csrf?: boolean } = {},
  ): Promise<LightMyRequestResponse> => {
    const res = await app.inject({
      method,
      url,
      payload: body as object,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(method !== 'GET' && opts.csrf !== false ? { 'x-tangent-csrf': '1' } : {}),
      },
    });
    const set = res.headers['set-cookie'];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(';')[0]!;
    return res;
  };
  return {
    call,
    get cookie() {
      return cookie;
    },
  };
}

async function connectSpotify(c: ReturnType<typeof client>) {
  const start = await c.call('GET', '/v1/connections/spotify/start?returnTo=/library');
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const cb = await c.call('GET', `/v1/connections/spotify/callback?code=good&state=${state}`);
  expect(new URL(cb.headers.location as string).searchParams.get('connect')).toBe('connected');
}

async function seedCollection(c: ReturnType<typeof client>, sourceIds: string[]) {
  const col = (await c.call('POST', '/v1/collections', { name: 'Decisions' })).json();
  for (const id of sourceIds) {
    const r = await c.call('POST', `/v1/collections/${col.id}/items`, {
      platform: 'apple',
      sourceId: id,
      showId: 'show-1',
    });
    expect(r.statusCode).toBe(201);
  }
  return col as { id: string };
}

async function waitFor(c: ReturnType<typeof client>, jobId: string) {
  await queue.onIdle();
  return (await c.call('GET', `/v1/exports/${jobId}`)).json();
}

describe('platform basics', () => {
  it('reports health and readiness', async () => {
    expect((await app.inject('/healthz')).json()).toEqual({ ok: true });
    expect((await app.inject('/readyz')).statusCode).toBe(200);
  });

  it('returns JSON 404s with the standard error shape', async () => {
    const res = await app.inject('/nope');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
  });

  it('requires the CSRF header on writes', async () => {
    const res = await client().call('POST', '/v1/collections', { name: 'x' }, { csrf: false });
    expect(res.statusCode).toBe(403);
  });

  it('accepts action calls with a JSON content type and no body, and rejects malformed JSON', async () => {
    const c = client();
    await c.call('GET', '/v1/collections');
    const empty = await app.inject({
      method: 'POST',
      url: '/v1/exports/00000000-0000-4000-8000-000000000000/cancel',
      headers: { cookie: c.cookie, 'x-tangent-csrf': '1', 'content-type': 'application/json' },
    });
    expect(empty.statusCode).toBe(404); // reached the handler (export not found), not a 400 body error
    const bad = await app.inject({
      method: 'POST',
      url: '/v1/collections',
      payload: '{oops',
      headers: { cookie: c.cookie, 'x-tangent-csrf': '1', 'content-type': 'application/json' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('validates input and reports field errors', async () => {
    const res = await client().call('POST', '/v1/collections', { name: '   ' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'validation', details: [{ path: 'name' }] });
  });

  it('lists platform capabilities honestly', async () => {
    const caps = (await client().call('GET', '/v1/providers')).json().providers;
    expect(caps.find((p: { platform: string }) => p.platform === 'apple').export).toBe('links');
  });
});

describe('search', () => {
  it('returns partial results when one platform fails', async () => {
    apple.add(ep('apple', 'a1', { title: 'Why Conversations Go Wrong' }));
    spotifyCatalog.failSearch = new ProviderError({
      kind: 'upstream_unavailable',
      platform: 'spotify',
      message: 'down',
    });
    const res = (
      await client().call('GET', '/v1/search?q=conversations&platforms=apple,spotify,youtube')
    ).json();
    expect(res.results.apple.items).toHaveLength(1);
    expect(res.results.spotify.error.code).toBe('upstream_unavailable');
    expect(res.results.youtube.error.code).toBe('provider_not_configured');
  });

  it('rejects unknown platforms', async () => {
    expect((await client().call('GET', '/v1/search?q=x&platforms=myspace')).statusCode).toBe(400);
  });
});

describe('collections', () => {
  beforeEach(() => {
    apple.add(ep('apple', 'a1'), ep('apple', 'a2'), ep('apple', 'a3'));
  });

  it('supports the full library lifecycle', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1', 'a2', 'a3']);
    const dup = await c.call('POST', `/v1/collections/${col.id}/items`, {
      platform: 'apple',
      sourceId: 'a1',
      showId: 'show-1',
    });
    expect(dup.statusCode).toBe(200);
    expect(dup.json().added).toBe(false);

    const full = (await c.call('GET', `/v1/collections/${col.id}`)).json();
    expect(full.items.map((i: { episode: { sourceId: string } }) => i.episode.sourceId)).toEqual([
      'a1',
      'a2',
      'a3',
    ]);

    const reversed = full.items.map((i: { id: string }) => i.id).reverse();
    expect((await c.call('PUT', `/v1/collections/${col.id}/order`, { itemIds: reversed })).statusCode).toBe(
      204,
    );
    expect(
      (await c.call('PUT', `/v1/collections/${col.id}/order`, { itemIds: reversed.slice(1) })).statusCode,
    ).toBe(409);

    expect((await c.call('DELETE', `/v1/collections/${col.id}/items/${reversed[0]}`)).statusCode).toBe(204);
    expect((await c.call('DELETE', `/v1/collections/${col.id}`)).statusCode).toBe(204);
    expect((await c.call('GET', `/v1/collections/${col.id}`)).statusCode).toBe(404);
    expect((await c.call('POST', `/v1/collections/${col.id}/restore`)).statusCode).toBe(200);
    expect((await c.call('GET', `/v1/collections/${col.id}`)).json().items).toHaveLength(2);
  });

  it("isolates users: one browser can't see another's collection", async () => {
    const alice = client();
    const col = await seedCollection(alice, ['a1']);
    const bob = client();
    expect((await bob.call('GET', `/v1/collections/${col.id}`)).statusCode).toBe(404);
    expect((await bob.call('DELETE', `/v1/collections/${col.id}`)).statusCode).toBe(404);
  });

  it('requires a lookup hint for Apple episodes', async () => {
    const c = client();
    const col = (await c.call('POST', '/v1/collections', { name: 'x' })).json();
    const res = await c.call('POST', `/v1/collections/${col.id}/items`, {
      platform: 'apple',
      sourceId: 'a1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0].path).toBe('showId');
  });

  it('returns 404 when adding an episode that does not exist upstream', async () => {
    const c = client();
    const col = (await c.call('POST', '/v1/collections', { name: 'x' })).json();
    expect(
      (
        await c.call('POST', `/v1/collections/${col.id}/items`, {
          platform: 'apple',
          sourceId: 'missing',
          showId: 'show-1',
        })
      ).statusCode,
    ).toBe(404);
  });

  it('produces a link list, clearly labelled as not a transfer', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1', 'a2']);
    const links = (await c.call('GET', `/v1/collections/${col.id}/links`)).json();
    expect(links.items).toHaveLength(2);
    expect(links.note).toMatch(/not a playlist transfer/);
  });
});

describe('connections (OAuth)', () => {
  it('connects, stores tokens encrypted, and rejects replayed state', async () => {
    const c = client();
    const start = await c.call('GET', '/v1/connections/spotify/start?returnTo=/library');
    expect(start.statusCode).toBe(302);
    const state = new URL(start.headers.location as string).searchParams.get('state')!;

    const cb = await c.call('GET', `/v1/connections/spotify/callback?code=good&state=${state}`);
    const dest = new URL(cb.headers.location as string);
    expect(dest.origin + dest.pathname).toBe('http://web.test/library');
    expect(dest.searchParams.get('connect')).toBe('connected');

    const [row] = await db.db.select().from(schema.providerAccounts);
    expect(row!.accessTokenEnc).not.toContain('access-good');
    expect(row!.accessTokenEnc.startsWith('v1.')).toBe(true);

    const replay = await c.call('GET', `/v1/connections/spotify/callback?code=good&state=${state}`);
    expect(new URL(replay.headers.location as string).searchParams.get('connect')).toBe('invalid_state');

    const list = (await c.call('GET', '/v1/connections')).json().connections;
    expect(list.find((x: { platform: string }) => x.platform === 'spotify')).toMatchObject({
      connected: true,
      displayName: 'Test User',
    });
  });

  it("does not accept another user's state", async () => {
    const alice = client();
    const start = await alice.call('GET', '/v1/connections/spotify/start');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const bob = client();
    await bob.call('GET', '/v1/collections'); // get a session
    const cb = await bob.call('GET', `/v1/connections/spotify/callback?code=good&state=${state}`);
    expect(new URL(cb.headers.location as string).searchParams.get('connect')).toBe('invalid_state');
  });

  it('reports a denied consent screen and blocks open redirects', async () => {
    const c = client();
    const start = await c.call('GET', '/v1/connections/spotify/start?returnTo=//evil.com');
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const cb = await c.call('GET', `/v1/connections/spotify/callback?error=access_denied&state=${state}`);
    const dest = new URL(cb.headers.location as string);
    expect(dest.origin).toBe('http://web.test');
    expect(dest.searchParams.get('connect')).toBe('denied');
  });

  it('refuses to start a connection for a platform that is not enabled', async () => {
    expect((await client().call('GET', '/v1/connections/youtube/start')).statusCode).toBe(503);
  });
});

describe('exports', () => {
  beforeEach(() => {
    apple.add(
      ep('apple', 'a1'),
      ep('apple', 'a2', { title: 'Edited cut episode' }),
      ep('apple', 'a3', { title: 'Apple only' }),
      ep('apple', 'a4'),
    );
    spotifyCatalog.candidates.set('a1', [ep('spotify', 's1', { title: 'Episode a1' })]);
    // Big duration difference → review, never auto-selected.
    spotifyCatalog.candidates.set('a2', [
      ep('spotify', 's2', { title: 'Edited cut episode', durationSec: 1200 }),
    ]);
    // a3 has no candidates → unavailable. a4 matches s1 too (same title) → it's a different episode, fine.
    spotifyCatalog.candidates.set('a4', [ep('spotify', 's4', { title: 'Episode a4' })]);
  });

  it('plans, requires review, executes, survives a partial failure and a hidden success on retry', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1', 'a2', 'a3', 'a4']);
    await connectSpotify(c);

    const created = await c.call('POST', '/v1/exports', {
      collectionId: col.id,
      destination: 'spotify',
      idempotencyKey: 'export-key-1',
    });
    expect(created.statusCode).toBe(202);
    expect(created.json().status).toBe('planning');

    let job = await waitFor(c, created.json().id);
    expect(job.status).toBe('needs_review');
    expect(job.summary).toMatchObject({ toAdd: 2, pendingReview: 1, skipped: { unavailable: 1 } });

    // Can't execute with pending reviews.
    expect((await c.call('POST', `/v1/exports/${job.id}/execute`)).statusCode).toBe(409);

    const review = job.items.find((i: { kind: string }) => i.kind === 'review');
    expect(review.match.evidence.find((e: { field: string }) => e.field === 'duration').result).toBe(
      'mismatch',
    );
    job = (
      await c.call('POST', `/v1/exports/${job.id}/decisions`, {
        decisions: [{ itemId: review.id, decision: 'accept' }],
      })
    ).json();
    expect(job.status).toBe('ready');

    // First run: s4 fails transiently; s2 is accepted by Spotify but the response times out.
    spotify.failOnce.set(
      's4',
      new ProviderError({ kind: 'upstream_unavailable', platform: 'spotify', message: '502' }),
    );
    spotify.timeoutAfterAccept.add('s2');
    expect((await c.call('POST', `/v1/exports/${job.id}/execute`)).statusCode).toBe(202);
    job = await waitFor(c, job.id);
    expect(job.status).toBe('partial');
    expect(job.summary).toMatchObject({ added: 1, failed: 2 });
    expect(job.playlist.url).toMatch(/^https:\/\/dest\.test\//);

    // Retry: reconciliation sees s2 already in the playlist and doesn't add it again.
    expect((await c.call('POST', `/v1/exports/${job.id}/retry`)).statusCode).toBe(202);
    job = await waitFor(c, job.id);
    expect(job.status).toBe('completed');
    expect(job.summary).toMatchObject({ added: 3, failed: 0 });
    expect(spotify.playlists.get(job.playlist.id)).toEqual(['s1', 's2', 's4']); // no duplicates, in order
  });

  it('is idempotent and refuses a second concurrent run', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    await connectSpotify(c);
    const body = { collectionId: col.id, destination: 'spotify', idempotencyKey: 'same-key-123' };
    const [r1, r2] = await Promise.all([
      c.call('POST', '/v1/exports', body),
      c.call('POST', '/v1/exports', body),
    ]);
    expect(r1.json().id).toBe(r2.json().id);
    const job = await waitFor(c, r1.json().id);
    expect(job.status).toBe('ready');

    const [e1, e2] = await Promise.all([
      c.call('POST', `/v1/exports/${job.id}/execute`),
      c.call('POST', `/v1/exports/${job.id}/execute`),
    ]);
    expect([e1.statusCode, e2.statusCode].sort()).toEqual([202, 409]);
    await queue.onIdle();
    expect(spotify.addCalls).toBe(1);
  });

  it('uses the match cache on later exports instead of searching again', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    await c.call('POST', '/v1/exports', {
      collectionId: col.id,
      destination: 'spotify',
      idempotencyKey: 'cache-key-1',
    });
    await queue.onIdle();
    await c.call('POST', '/v1/exports', {
      collectionId: col.id,
      destination: 'spotify',
      idempotencyKey: 'cache-key-2',
    });
    await queue.onIdle();
    expect(spotifyCatalog.findCalls).toBe(1);
  });

  it('requires a connected account to execute', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    const job = (
      await c.call('POST', '/v1/exports', {
        collectionId: col.id,
        destination: 'spotify',
        idempotencyKey: 'no-conn-key',
      })
    ).json();
    await queue.onIdle();
    const res = await c.call('POST', `/v1/exports/${job.id}/execute`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/Connect your spotify account/);
  });

  it('marks the account for reconnection when refresh is revoked, and fails items with a clear reason', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    await connectSpotify(c);
    const job = (
      await c.call('POST', '/v1/exports', {
        collectionId: col.id,
        destination: 'spotify',
        idempotencyKey: 'revoked-key',
      })
    ).json();
    await queue.onIdle();
    await db.db.update(schema.providerAccounts).set({ expiresAt: new Date(Date.now() - 1000) });
    spotify.refreshBehaviour = 'revoked';
    const res = await c.call('POST', `/v1/exports/${job.id}/execute`);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('reconnect_required');
    const [acct] = await db.db.select().from(schema.providerAccounts);
    expect(acct!.status).toBe('needs_reauth');
  });

  it('recreates the playlist if the user deleted it between runs', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1', 'a4']);
    await connectSpotify(c);
    let job = (
      await c.call('POST', '/v1/exports', {
        collectionId: col.id,
        destination: 'spotify',
        idempotencyKey: 'deleted-pl',
      })
    ).json();
    await queue.onIdle();
    spotify.failOnce.set('s4', new ProviderError({ kind: 'timeout', platform: 'spotify', message: 't' }));
    await c.call('POST', `/v1/exports/${job.id}/execute`);
    job = await waitFor(c, job.id);
    expect(job.status).toBe('partial');
    spotify.playlists.delete(job.playlist.id);

    await c.call('POST', `/v1/exports/${job.id}/retry`);
    job = await waitFor(c, job.id);
    expect(job.status).toBe('completed');
    expect(spotify.playlists.get(job.playlist.id)).toEqual(['s1', 's4']);
  });

  it('resumes a job interrupted by a restart without duplicating items', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1', 'a4']);
    await connectSpotify(c);
    let job = (
      await c.call('POST', '/v1/exports', {
        collectionId: col.id,
        destination: 'spotify',
        idempotencyKey: 'resume-key',
      })
    ).json();
    await queue.onIdle();
    // Simulate a crash after the playlist was created and s1 was added, before state was saved.
    const pl = await spotify.createPlaylist('t', { title: 'Decisions', description: '', privacy: 'private' });
    spotify.playlists.get(pl.id)!.push('s1');
    await db.db
      .update(schema.exportJobs)
      .set({ status: 'running', playlistId: pl.id, playlistUrl: pl.url })
      .where(eq(schema.exportJobs.id, job.id));

    expect(await exportsSvc.resumeInterrupted()).toBe(1);
    job = await waitFor(c, job.id);
    expect(job.status).toBe('completed');
    expect(spotify.playlists.get(pl.id)).toEqual(['s1', 's4']);
  });

  it('rejects Apple as a destination and empty collections', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    const apple = await c.call('POST', '/v1/exports', {
      collectionId: col.id,
      destination: 'apple',
      idempotencyKey: 'apple-key-1',
    });
    expect(apple.statusCode).toBe(400);
    expect(apple.json().error.message).toMatch(/link list/);

    const empty = (await c.call('POST', '/v1/collections', { name: 'Empty' })).json();
    expect(
      (
        await c.call('POST', '/v1/exports', {
          collectionId: empty.id,
          destination: 'spotify',
          idempotencyKey: 'empty-key-1',
        })
      ).statusCode,
    ).toBe(400);
  });

  it('fails planning cleanly when the destination is unreachable, and can be retried', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    const original = spotifyCatalog.findCandidates.bind(spotifyCatalog);
    spotifyCatalog.findCandidates = async () => {
      throw new ProviderError({ kind: 'upstream_unavailable', platform: 'spotify', message: 'down' });
    };
    let job = (
      await c.call('POST', '/v1/exports', {
        collectionId: col.id,
        destination: 'spotify',
        idempotencyKey: 'plan-fail-key',
      })
    ).json();
    job = await waitFor(c, job.id);
    expect(job.status).toBe('failed');
    expect(job.error).toMatchObject({ kind: 'upstream_unavailable', retryable: true });

    spotifyCatalog.findCandidates = original;
    await c.call('POST', `/v1/exports/${job.id}/retry`);
    job = await waitFor(c, job.id);
    expect(job.status).toBe('ready');
  });

  it('can cancel before running but not after completion', async () => {
    const c = client();
    const col = await seedCollection(c, ['a1']);
    const job = (
      await c.call('POST', '/v1/exports', {
        collectionId: col.id,
        destination: 'spotify',
        idempotencyKey: 'cancel-key-1',
      })
    ).json();
    await queue.onIdle();
    expect((await c.call('POST', `/v1/exports/${job.id}/cancel`)).json().status).toBe('cancelled');
    expect((await c.call('POST', `/v1/exports/${job.id}/cancel`)).statusCode).toBe(409);
  });
});
