import { describe, expect, it } from 'vitest';
import type { EpisodeCandidate } from '@tangent/core';
import { SpotifyProvider } from '../src/spotify.js';
import { fakeFetch, noSleep } from './fake-fetch.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const tokenOk = { json: { access_token: 'app-token', token_type: 'Bearer', expires_in: 3600 } };
const show = {
  id: 'show1',
  name: 'Hidden Brain',
  publisher: 'Hidden Brain Media',
  external_urls: { spotify: 'https://open.spotify.com/show/show1' },
};
const episode = (id: string, name: string, date: string, ms = 3_534_000, extra: object = {}) => ({
  id,
  name,
  release_date: date,
  release_date_precision: 'day',
  duration_ms: ms,
  external_urls: { spotify: `https://open.spotify.com/episode/${id}` },
  is_playable: true,
  ...extra,
});

function provider(f: ReturnType<typeof fakeFetch>) {
  return new SpotifyProvider({
    clientId: 'cid',
    clientSecret: 'secret',
    fetch: f.fetch,
    now: () => NOW,
    sleep: noSleep,
  });
}

const source: EpisodeCandidate = {
  ref: { platform: 'apple', id: 'a1', url: 'https://podcasts.apple.com/x' },
  title: 'Why Conversations Go Wrong',
  showTitle: 'Hidden Brain',
  publishedAt: new Date('2026-09-14T08:00:00Z'),
  durationSec: 3534,
};

describe('SpotifyProvider catalog', () => {
  it('hydrates search results (which lack the show) and drops null items', async () => {
    const f = fakeFetch()
      .on('POST', 'accounts.spotify.com/api/token', tokenOk)
      .on('GET', '/v1/search', { json: { episodes: { items: [null, { id: 'ep1aaaaaaaaaa', name: 'x' }] } } })
      .on('GET', '/v1/episodes/ep1aaaaaaaaaa', {
        json: { ...episode('ep1aaaaaaaaaa', 'Why Conversations Go Wrong', '2026-09-14'), show },
      });
    const [hit, ...rest] = await provider(f).search('conversations');
    expect(rest).toHaveLength(0);
    expect(hit).toMatchObject({
      showTitle: 'Hidden Brain',
      durationSec: 3534,
      people: ['Hidden Brain Media'],
    });
    expect(f.calls.find((c) => c.url.pathname === '/v1/search')!.url.searchParams.get('market')).toBe('US');
  });

  it('caches the app token across requests', async () => {
    const f = fakeFetch()
      .on('POST', 'accounts.spotify.com/api/token', tokenOk)
      .on('GET', '/v1/episodes/', {
        status: 404,
        json: { error: { status: 404, message: 'Non existing id' } },
      });
    const sp = provider(f);
    await sp.getEpisode('aaaaaaaaaaaaaaaaaaaaaa');
    await sp.getEpisode('bbbbbbbbbbbbbbbbbbbbbb');
    expect(f.calls.filter((c) => c.url.href.includes('/api/token'))).toHaveLength(1);
  });

  it('refreshes an expired app token once and retries', async () => {
    const f = fakeFetch()
      .on('POST', 'accounts.spotify.com/api/token', tokenOk)
      .on(
        'GET',
        '/v1/episodes/',
        { status: 401, json: { error: { status: 401, message: 'The access token expired' } } },
        { json: { ...episode('cccccccccccccccccccccc', 'T', '2026-09-14'), show } },
      );
    expect(await provider(f).getEpisode('cccccccccccccccccccccc')).not.toBeNull();
    expect(f.calls.filter((c) => c.url.href.includes('/api/token'))).toHaveLength(2);
  });

  it('finds candidates show-first and stops paging once past the date window', async () => {
    const page1 = {
      items: [
        episode('e1', 'Newest', '2026-10-10'),
        episode('e2', 'Why Conversations Go Wrong', '2026-09-14'),
      ],
      next: 'https://api.spotify.com/v1/next',
    };
    const page2 = { items: [episode('e3', 'Old', '2026-07-01')], next: 'https://api.spotify.com/v1/next2' };
    const f = fakeFetch()
      .on('POST', 'accounts.spotify.com/api/token', tokenOk)
      .on('GET', (u) => u.pathname === '/v1/search' && u.searchParams.get('type') === 'show', {
        json: { shows: { items: [show, { id: 'x', name: 'Totally Different Show' }] } },
      })
      .on(
        'GET',
        '/v1/shows/show1/episodes',
        { json: page1 },
        { json: page2 },
        { json: { items: [episode('e4', 'Older', '2026-01-01')], next: null } },
      );
    const out = await provider(f).findCandidates(source);
    expect(out.map((e) => e.ref.id)).toEqual(['e1', 'e2', 'e3']);
    expect(f.calls.filter((c) => c.url.pathname.includes('/shows/'))).toHaveLength(2);
    expect(f.calls.some((c) => c.url.pathname.includes('/shows/x/'))).toBe(false);
  });

  it('treats month/year precision dates as unknown and skips unplayable episodes', async () => {
    const f = fakeFetch()
      .on('POST', 'accounts.spotify.com/api/token', tokenOk)
      .on('GET', (u) => u.searchParams.get('type') === 'show', { json: { shows: { items: [show] } } })
      .on('GET', '/v1/shows/show1/episodes', {
        json: {
          items: [
            episode('m1', 'Month only', '2026-09', 1000, { release_date_precision: 'month' }),
            episode('m2', 'Blocked', '2026-09-14', 1000, { is_playable: false }),
          ],
          next: null,
        },
      });
    const out = await provider(f).findCandidates(source);
    expect(out).toHaveLength(1);
    expect(out[0]!.publishedAt).toBeNull();
  });
});

describe('SpotifyProvider account + playlists', () => {
  const userCalls = (f: ReturnType<typeof fakeFetch>) =>
    f
      .on('GET', '/v1/me', { json: { id: 'user1', display_name: 'Prathmesh' } })
      .on('POST', '/v1/users/user1/playlists', {
        status: 201,
        json: { id: 'pl1', external_urls: { spotify: 'https://open.spotify.com/playlist/pl1' } },
      });

  it('creates a private playlist and sanitises the description', async () => {
    const f = userCalls(fakeFetch());
    const pl = await provider(f).createPlaylist('user-token', {
      title: 'My <list>',
      description: 'line1\nline2',
      privacy: 'private',
    });
    expect(pl.id).toBe('pl1');
    const body = JSON.parse(f.calls.find((c) => c.url.pathname.endsWith('/playlists'))!.body!);
    expect(body).toEqual({ name: 'My list', description: 'line1 line2', public: false });
  });

  it('splits batches of 100 and isolates a single bad URI by bisection', async () => {
    const refs = Array.from({ length: 4 }, (_, i) => ({
      platform: 'spotify' as const,
      id: `id${i}`,
      url: '',
    }));
    const f = fakeFetch()
      .on(
        'POST',
        (u, init) => u.pathname === '/v1/playlists/pl1/tracks' && !String(init.body).includes('id2'),
        { status: 201, json: { snapshot_id: 's' } },
      )
      .on('POST', '/v1/playlists/pl1/tracks', {
        status: 400,
        json: { error: { status: 400, message: 'Invalid base62 id' } },
      });
    const results = await provider(f).addItems('t', 'pl1', refs);
    expect(results.map((r) => r.ok)).toEqual([true, true, false, true]);
  });

  it('reports transient failures per item instead of throwing', async () => {
    const f = fakeFetch().on('POST', '/v1/playlists/pl1/tracks', { status: 502 });
    const results = await provider(f).addItems('t', 'pl1', [{ platform: 'spotify', id: 'a', url: '' }]);
    expect(results[0]).toMatchObject({ ok: false, error: { kind: 'upstream_unavailable' } });
  });

  it('throws for whole-operation failures like a user outside the dev-mode allowlist', async () => {
    const f = fakeFetch().on('POST', '/v1/playlists/pl1/tracks', {
      status: 403,
      json: { error: { status: 403, message: 'User not registered in the Developer Dashboard' } },
    });
    await expect(
      provider(f).addItems('t', 'pl1', [{ platform: 'spotify', id: 'a', url: '' }]),
    ).rejects.toMatchObject({ kind: 'not_allowlisted' });
  });

  it('retries 429 on writes after Retry-After', async () => {
    const f = fakeFetch().on(
      'POST',
      '/v1/playlists/pl1/tracks',
      {
        status: 429,
        headers: { 'retry-after': '1' },
        json: { error: { status: 429, message: 'API rate limit exceeded' } },
      },
      { status: 201, json: {} },
    );
    const results = await provider(f).addItems('t', 'pl1', [{ platform: 'spotify', id: 'a', url: '' }]);
    expect(results[0]!.ok).toBe(true);
  });

  it('maps a quota reason on 429 to quota_exceeded', async () => {
    const f = fakeFetch().on('POST', '/v1/playlists/pl1/tracks', {
      status: 429,
      json: { error: { status: 429, message: 'Quota exceeded', reason: 'QUOTA_EXCEEDED' } },
    });
    await expect(
      provider(f).addItems('t', 'pl1', [{ platform: 'spotify', id: 'a', url: '' }]),
    ).rejects.toMatchObject({ kind: 'quota_exceeded' });
  });

  it('maps invalid_grant on refresh to auth_revoked and keeps the old refresh token on success', async () => {
    const bad = fakeFetch().on('POST', '/api/token', {
      status: 400,
      json: { error: 'invalid_grant', error_description: 'Refresh token revoked' },
    });
    await expect(provider(bad).refresh('r1')).rejects.toMatchObject({ kind: 'auth_revoked' });
    const ok = fakeFetch().on('POST', '/api/token', { json: { access_token: 'a2', expires_in: 3600 } });
    expect((await provider(ok).refresh('r1')).refreshToken).toBe('r1');
  });

  it('builds a PKCE authorize URL with the right scopes', () => {
    const url = new URL(
      provider(fakeFetch()).buildAuthorizeUrl({
        state: 's',
        codeChallenge: 'c',
        redirectUri: 'https://app/cb',
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('playlist-modify-private playlist-modify-public');
  });

  it('lists playlist item ids across pages for idempotent retries', async () => {
    const f = fakeFetch().on(
      'GET',
      '/v1/playlists/pl1/tracks',
      {
        json: {
          items: [{ track: { id: 'a' } }, { track: null }],
          next: 'https://api.spotify.com/v1/playlists/pl1/tracks?offset=100',
        },
      },
      { json: { items: [{ track: { id: 'b' } }], next: null } },
    );
    expect([...(await provider(f).listItemIds('t', 'pl1'))]).toEqual(['a', 'b']);
  });
});
