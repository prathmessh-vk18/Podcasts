import { describe, expect, it } from 'vitest';
import type { EpisodeCandidate } from '@tangent/core';
import { MemoryQuotaStore, QuotaBudget } from '../src/limits.js';
import { mapYouTubeVideo, YouTubeProvider } from '../src/youtube.js';
import { fakeFetch, noSleep } from './fake-fetch.js';

const NOW = new Date('2026-10-17T12:00:00Z');
const video = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  snippet: {
    title: 'Why Conversations Go Wrong &#39;Live&#39;',
    channelTitle: 'Hidden Brain',
    channelId: 'UC1',
    publishedAt: '2026-09-14T10:00:00Z',
    liveBroadcastContent: 'none',
    thumbnails: { high: { url: 'https://i.ytimg.com/h.jpg' } },
  },
  contentDetails: { duration: 'PT58M54S' },
  statistics: { viewCount: '120345' },
  status: { privacyStatus: 'public' },
  ...extra,
});

function yt(f: ReturnType<typeof fakeFetch>, dailyQuota = 10_000) {
  const budget = new QuotaBudget(new MemoryQuotaStore(), 'yt', dailyQuota, 'America/Los_Angeles', () => NOW);
  return new YouTubeProvider({
    apiKey: 'key',
    clientId: 'cid',
    clientSecret: 'sec',
    fetch: f.fetch,
    budget,
    now: () => NOW,
    sleep: noSleep,
  });
}

const source: EpisodeCandidate = {
  ref: { platform: 'apple', id: 'a1', url: '' },
  title: 'Why Conversations Go Wrong',
  showTitle: 'Hidden Brain',
  publishedAt: new Date('2026-09-14T08:00:00Z'),
  durationSec: 3534,
};

describe('mapYouTubeVideo', () => {
  it('maps fields, decodes entities and records views as a source-specific metric', () => {
    expect(mapYouTubeVideo(video('abcdefghijk') as never, NOW)).toMatchObject({
      title: "Why Conversations Go Wrong 'Live'",
      showTitle: 'Hidden Brain',
      durationSec: 3534,
      popularity: { available: true, kind: 'views', value: 120345, source: 'youtube' },
    });
  });
  it('marks views unavailable (not zero) when hidden', () => {
    expect(mapYouTubeVideo(video('abcdefghijk', { statistics: {} }) as never, NOW)?.popularity).toMatchObject(
      { available: false },
    );
  });
  it.each([
    ['live streams', { snippet: { ...video('x').snippet, liveBroadcastContent: 'live' } }],
    [
      'region-blocked videos',
      { contentDetails: { duration: 'PT1M', regionRestriction: { blocked: ['US'] } } },
    ],
    [
      'videos allowed only elsewhere',
      { contentDetails: { duration: 'PT1M', regionRestriction: { allowed: ['GB'] } } },
    ],
  ])('drops %s', (_label, extra) => {
    expect(mapYouTubeVideo(video('abcdefghijk', extra) as never, NOW, 'US')).toBeNull();
  });
});

describe('YouTubeProvider catalog', () => {
  it('searches within a date window, hydrates via videos.list and spends 101 units', async () => {
    const f = fakeFetch()
      .on('GET', '/youtube/v3/search', {
        json: { items: [{ id: { videoId: 'abcdefghijk' } }, { id: { videoId: 'abcdefghijk' } }] },
      })
      .on('GET', '/youtube/v3/videos', { json: { items: [video('abcdefghijk')] } });
    const p = yt(f);
    const out = await p.findCandidates(source);
    expect(out).toHaveLength(1);
    const search = f.calls[0]!.url.searchParams;
    expect(search.get('publishedAfter')).toBe('2026-08-15T08:00:00.000Z');
    expect(f.calls[1]!.url.searchParams.get('id')).toBe('abcdefghijk');
    expect(await p.budget.remaining()).toBe(10_000 - 101);
  });

  it('retries without the date window when the windowed search finds nothing', async () => {
    const f = fakeFetch()
      .on('GET', (u) => u.pathname.endsWith('/search') && u.searchParams.has('publishedAfter'), {
        json: { items: [] },
      })
      .on('GET', '/youtube/v3/search', { json: { items: [{ id: { videoId: 'abcdefghijk' } }] } })
      .on('GET', '/youtube/v3/videos', { json: { items: [video('abcdefghijk')] } });
    expect(await yt(f).findCandidates(source)).toHaveLength(1);
  });

  it('refuses to call the API when the local budget cannot cover it', async () => {
    const f = fakeFetch();
    await expect(yt(f, 50).search('anything')).rejects.toMatchObject({ kind: 'quota_exceeded' });
    expect(f.calls).toHaveLength(0);
  });

  it('maps quotaExceeded from Google without retrying', async () => {
    const f = fakeFetch().on('GET', '/youtube/v3/search', {
      status: 403,
      json: { error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } },
    });
    await expect(yt(f).search('x')).rejects.toMatchObject({ kind: 'quota_exceeded' });
    expect(f.calls).toHaveLength(1);
  });

  it('rejects malformed video ids without a request', async () => {
    const f = fakeFetch();
    expect(await yt(f).getEpisode('bad id')).toBeNull();
    expect(f.calls).toHaveLength(0);
  });
});

describe('YouTubeProvider account + playlists', () => {
  it('explains that a Google account without a channel cannot create playlists', async () => {
    const f = fakeFetch().on('GET', '/youtube/v3/channels', { json: { items: [] } });
    await expect(yt(f).getAccount('t')).rejects.toMatchObject({ kind: 'forbidden', reason: 'noChannel' });
  });

  it('rejects tokens that were granted without the YouTube scope', async () => {
    const f = fakeFetch().on('POST', 'oauth2.googleapis.com/token', {
      json: { access_token: 'a', expires_in: 3600, scope: 'openid email' },
    });
    await expect(
      yt(f).exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'r' }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('strips angle brackets from playlist titles', async () => {
    const f = fakeFetch().on('POST', '/youtube/v3/playlists', { json: { id: 'PL1' } });
    await yt(f).createPlaylist('t', { title: 'A <b>bold</b> list', description: '', privacy: 'private' });
    expect(JSON.parse(f.calls[0]!.body!).snippet.title).toBe('A bbold/b list');
  });

  it('adds items one at a time and stops cleanly when quota runs out mid-export', async () => {
    const f = fakeFetch().on(
      'POST',
      '/youtube/v3/playlistItems',
      { json: { id: 'item1' } },
      { status: 403, json: { error: { code: 403, errors: [{ reason: 'quotaExceeded' }] } } },
    );
    const refs = ['v1', 'v2', 'v3'].map((id) => ({ platform: 'youtube' as const, id, url: '' }));
    const results = await yt(f).addItems('t', 'PL1', refs);
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(f.calls).toHaveLength(2); // didn't burn a call on v3
  });

  it('keeps going past a single missing video', async () => {
    const f = fakeFetch().on(
      'POST',
      '/youtube/v3/playlistItems',
      { status: 404, json: { error: { code: 404, errors: [{ reason: 'videoNotFound' }] } } },
      { json: { id: 'item2' } },
    );
    const refs = ['gone', 'v2'].map((id) => ({ platform: 'youtube' as const, id, url: '' }));
    expect((await yt(f).addItems('t', 'PL1', refs)).map((r) => r.ok)).toEqual([false, true]);
  });

  it('throws when the playlist itself is gone', async () => {
    const f = fakeFetch().on('POST', '/youtube/v3/playlistItems', {
      status: 404,
      json: { error: { code: 404, errors: [{ reason: 'playlistNotFound' }] } },
    });
    await expect(
      yt(f).addItems('t', 'PL1', [{ platform: 'youtube', id: 'v1', url: '' }]),
    ).rejects.toMatchObject({ kind: 'not_found', reason: 'playlistNotFound' });
  });

  it('retries the transient 409 that YouTube returns on rapid writes', async () => {
    const f = fakeFetch().on(
      'POST',
      '/youtube/v3/playlistItems',
      { status: 409, json: { error: { code: 409, errors: [{ reason: 'SERVICE_UNAVAILABLE' }] } } },
      { json: { id: 'ok' } },
    );
    expect((await yt(f).addItems('t', 'PL1', [{ platform: 'youtube', id: 'v1', url: '' }]))[0]!.ok).toBe(
      true,
    );
  });

  it('treats revoking an already-invalid token as success', async () => {
    const f = fakeFetch().on('POST', 'oauth2.googleapis.com/revoke', {
      status: 400,
      json: { error: 'invalid_token' },
    });
    await expect(yt(f).revoke('t')).resolves.toBeUndefined();
  });

  it('computes export cost', () => {
    expect(yt(fakeFetch()).exportCost(10)).toBe(550);
  });
});
