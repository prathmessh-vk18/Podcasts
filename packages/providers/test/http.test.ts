import { describe, expect, it } from 'vitest';
import { ProviderError } from '@tangent/core';
import { baseErrorKind, HttpClient, parseRetryAfter, type RawErrorResponse } from '../src/http.js';
import { MemoryQuotaStore, QuotaBudget, TokenBucket, dayIn } from '../src/limits.js';
import { assertPublicHttpUrl } from '../src/safe-url.js';
import { createPkcePair, toTokenSet } from '../src/oauth.js';
import { fakeFetch } from './fake-fetch.js';

const mapError = (r: RawErrorResponse) =>
  new ProviderError({
    kind: baseErrorKind(r.status),
    platform: 'apple',
    status: r.status,
    message: `err ${r.status}`,
  });

function client(
  f: ReturnType<typeof fakeFetch>,
  sleeps: number[] = [],
  extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {},
) {
  return new HttpClient({
    platform: 'apple',
    mapError,
    fetch: f.fetch,
    random: () => 1,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...extra,
  });
}

describe('HttpClient', () => {
  it('retries GET on 5xx with exponential backoff, then succeeds', async () => {
    const f = fakeFetch().on('GET', '/x', { status: 503 }, { status: 502 }, { json: { ok: true } });
    const sleeps: number[] = [];
    const res = await client(f, sleeps).request<{ ok: boolean }>({ url: 'https://api.test/x' });
    expect(res.data.ok).toBe(true);
    expect(f.calls).toHaveLength(3);
    expect(sleeps).toEqual([300, 600]);
  });

  it('honours Retry-After on 429', async () => {
    const f = fakeFetch().on('GET', '/x', { status: 429, headers: { 'retry-after': '3' } }, { json: {} });
    const sleeps: number[] = [];
    await client(f, sleeps, {
      mapError: (r) =>
        new ProviderError({
          kind: 'rate_limited',
          platform: 'apple',
          status: r.status,
          retryAfterMs: parseRetryAfter(r.headers.get('retry-after')),
          message: 'slow',
        }),
    }).request({ url: 'https://api.test/x' });
    expect(sleeps).toEqual([3000]);
  });

  it('gives up immediately when Retry-After is longer than the cap', async () => {
    const f = fakeFetch().on('GET', '/x', { status: 429 });
    const c = client(f, [], {
      mapError: () =>
        new ProviderError({
          kind: 'rate_limited',
          platform: 'apple',
          retryAfterMs: 120_000,
          message: 'slow',
        }),
    });
    await expect(c.request({ url: 'https://api.test/x' })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(f.calls).toHaveLength(1);
  });

  it('does not retry POST by default (could duplicate a write)', async () => {
    const f = fakeFetch().on('POST', '/x', { status: 503 }, { json: {} });
    await expect(
      client(f).request({ method: 'POST', url: 'https://api.test/x', json: {} }),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
    expect(f.calls).toHaveLength(1);
  });

  it('does not retry non-transient errors', async () => {
    const f = fakeFetch().on('GET', '/x', { status: 404 });
    await expect(client(f).request({ url: 'https://api.test/x' })).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(f.calls).toHaveLength(1);
  });

  it('maps network failures and timeouts', async () => {
    const net = fakeFetch().on('GET', '/x', { throws: new TypeError('fetch failed') });
    await expect(
      client(net, [], { maxRetries: 0 }).request({ url: 'https://api.test/x' }),
    ).rejects.toMatchObject({ kind: 'network' });
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const slow = fakeFetch().on('GET', '/x', { throws: err });
    await expect(
      client(slow, [], { maxRetries: 0 }).request({ url: 'https://api.test/x' }),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('rejects bodies over the size limit', async () => {
    const f = fakeFetch().on('GET', '/x', { bytes: new Uint8Array(2048) });
    await expect(
      client(f, [], { maxRetries: 0 }).request({
        url: 'https://api.test/x',
        maxBodyBytes: 1024,
        responseType: 'bytes',
      }),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
  });

  it('reports invalid JSON as an upstream problem', async () => {
    const f = fakeFetch().on('GET', '/x', { text: '<html>oops</html>' });
    await expect(
      client(f, [], { maxRetries: 0 }).request({ url: 'https://api.test/x' }),
    ).rejects.toMatchObject({ kind: 'upstream_unavailable' });
  });

  it('serialises query params and skips null/undefined', async () => {
    const f = fakeFetch().on('GET', '/x', { json: {} });
    await client(f).request({
      url: 'https://api.test/x',
      query: { a: 'b c', n: 3, skip: undefined, nil: null },
    });
    expect(f.calls[0]!.url.search).toBe('?a=b+c&n=3');
  });
});

describe('parseRetryAfter', () => {
  it('parses seconds and HTTP dates', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(new Date(10_000 + 5_000).toUTCString(), 10_000)).toBe(5000);
    expect(parseRetryAfter('nonsense')).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('TokenBucket', () => {
  it('waits once the bucket is empty', async () => {
    let t = 0;
    const waits: number[] = [];
    const b = new TokenBucket(
      2,
      1,
      () => t,
      async (ms) => {
        waits.push(ms);
        t += ms;
      },
    );
    await b.acquire();
    await b.acquire();
    await b.acquire();
    expect(waits).toEqual([1000]);
  });
});

describe('QuotaBudget', () => {
  it('reserves units and refuses work that would exceed the daily limit', async () => {
    const budget = new QuotaBudget(
      new MemoryQuotaStore(),
      'yt',
      120,
      'America/Los_Angeles',
      () => new Date('2026-10-17T12:00:00Z'),
    );
    await budget.consume(100, 'search');
    expect(await budget.remaining()).toBe(20);
    await expect(budget.consume(50, 'insert')).rejects.toMatchObject({ kind: 'quota_exceeded' });
    expect(await budget.remaining()).toBe(20); // a refused reservation spends nothing
  });

  it('resets at midnight Pacific, not UTC', async () => {
    let now = new Date('2026-10-18T06:59:00Z'); // 23:59 PDT on the 17th
    const budget = new QuotaBudget(new MemoryQuotaStore(), 'yt', 100, 'America/Los_Angeles', () => now);
    await budget.consume(100, 'x');
    expect(await budget.remaining()).toBe(0);
    now = new Date('2026-10-18T07:01:00Z'); // 00:01 PDT on the 18th
    expect(await budget.remaining()).toBe(100);
    expect(dayIn('America/Los_Angeles', now)).toBe('2026-10-18');
  });
});

describe('assertPublicHttpUrl', () => {
  it.each([
    'http://localhost/feed',
    'http://127.0.0.1/x',
    'http://10.0.0.5/x',
    'http://192.168.1.1/x',
    'http://169.254.169.254/latest',
    'file:///etc/passwd',
    'http://[::1]/x',
    'https://user:pw@feeds.example.com/x',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(ProviderError);
  });
  it('accepts public https feeds', () => {
    expect(assertPublicHttpUrl('https://feeds.simplecast.com/kwWc0lhf').hostname).toBe(
      'feeds.simplecast.com',
    );
  });
});

describe('oauth helpers', () => {
  it('creates a valid PKCE pair', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('keeps the previous refresh token when a refresh response omits it', () => {
    const t = toTokenSet({ access_token: 'new', expires_in: 3600 }, new Date(0), 'old-refresh');
    expect(t).toMatchObject({ accessToken: 'new', refreshToken: 'old-refresh' });
    expect(t.expiresAt.getTime()).toBe(3_600_000);
  });
  it('rejects a token response without an access token', () => {
    expect(() => toTokenSet({}, new Date())).toThrow(/access_token/);
  });
});
