import { describe, expect, it } from 'vitest';
import { AppleProvider } from '../src/apple.js';
import { decodeFeed, parseFeed, RssClient } from '../src/rss.js';
import { TokenBucket } from '../src/limits.js';
import { fakeFetch, noSleep } from './fake-fetch.js';

const bucket = () => new TokenBucket(1000, 1000);

const itunesEpisode = {
  wrapperType: 'podcastEpisode',
  kind: 'podcast-episode',
  trackId: 1000784066252,
  trackName: 'Make Better Decisions &amp; Fix Yourself First',
  collectionId: 990149481,
  collectionName: 'The Knowledge Project',
  trackViewUrl: 'https://podcasts.apple.com/us/podcast/x/id990149481?i=1000784066252&uo=4',
  releaseDate: '2026-08-18T09:00:00Z',
  trackTimeMillis: 2793000,
  artworkUrl600: 'https://is1-ssl.mzstatic.com/a/600x600bb.jpg',
  description: '<p>David Baszucki on <b>decisions</b></p>',
  episodeGuid: 'abc-123',
  episodeUrl: 'https://traffic.example.com/ep.mp3',
};

describe('AppleProvider', () => {
  it('maps episodes and drops non-episode rows', async () => {
    const f = fakeFetch().on('GET', 'itunes.apple.com/search', {
      json: {
        resultCount: 2,
        results: [itunesEpisode, { wrapperType: 'track', kind: 'podcast', collectionId: 1 }],
      },
    });
    const apple = new AppleProvider({ fetch: f.fetch, bucket: bucket() });
    const [ep, ...rest] = await apple.search('decisions');
    expect(rest).toHaveLength(0);
    expect(ep).toMatchObject({
      ref: {
        platform: 'apple',
        id: '1000784066252',
        url: 'https://podcasts.apple.com/us/podcast/x/id990149481?i=1000784066252',
      },
      title: 'Make Better Decisions & Fix Yourself First',
      showTitle: 'The Knowledge Project',
      description: 'David Baszucki on decisions',
      durationSec: 2793,
      feedItemGuid: 'abc-123',
      enclosureUrl: 'https://traffic.example.com/ep.mp3',
    });
    expect(f.calls[0]!.url.searchParams.get('entity')).toBe('podcastEpisode');
  });

  it('returns [] for blank queries without calling the API', async () => {
    const f = fakeFetch();
    expect(await new AppleProvider({ fetch: f.fetch, bucket: bucket() }).search('   ')).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });

  it('treats 403 as throttling and retries', async () => {
    const f = fakeFetch().on(
      'GET',
      'itunes.apple.com/search',
      { status: 403 },
      { json: { results: [itunesEpisode] } },
    );
    const apple = new AppleProvider({ fetch: f.fetch, bucket: bucket(), sleep: noSleep });
    expect(await apple.search('x')).toHaveLength(1);
    expect(f.calls).toHaveLength(2);
  });

  it('getEpisode finds an episode through its show, then falls back to title search', async () => {
    const other = { ...itunesEpisode, trackId: 555 };
    const f = fakeFetch()
      .on('GET', (u) => u.pathname === '/lookup' && u.searchParams.get('id') === '990149481', {
        json: { results: [other] },
      })
      .on('GET', '/search', { json: { results: [other, itunesEpisode] } });
    const apple = new AppleProvider({ fetch: f.fetch, bucket: bucket() });
    expect((await apple.getEpisode('555', { showId: '990149481' }))?.ref.id).toBe('555');
    expect(f.calls).toHaveLength(1);
    // Older episode: not in the show's recent list, found via title search.
    expect(
      (await apple.getEpisode('1000784066252', { showId: '990149481', title: 'Make Better Decisions' }))?.ref
        .id,
    ).toBe('1000784066252');
    expect(f.calls.at(-1)!.url.searchParams.get('term')).toBe('Make Better Decisions');
  });

  it('getEpisode ignores malformed ids and missing results', async () => {
    const f = fakeFetch().on('GET', 'itunes.apple.com/lookup', { json: { results: [] } });
    const apple = new AppleProvider({ fetch: f.fetch, bucket: bucket() });
    expect(await apple.getEpisode('../etc')).toBeNull();
    expect(await apple.getEpisode('123')).toBeNull(); // no hint: nothing to look up with
    expect(await apple.getEpisode('123', { showId: '1' })).toBeNull();
    expect(f.calls).toHaveLength(1);
  });

  it('tolerates a response with no results array', async () => {
    const f = fakeFetch().on('GET', 'itunes.apple.com/search', { json: { resultCount: 0 } });
    expect(await new AppleProvider({ fetch: f.fetch, bucket: bucket() }).search('x')).toEqual([]);
  });
});

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title><![CDATA[Hidden Brain]]></title>
  <podcast:guid>917393e3-1b1e-5cef-ace4-edaa54e1f810</podcast:guid>
  <itunes:image href="https://img.example.com/show.jpg"/>
  <item>
    <title><![CDATA[Why Conversations Go Wrong]]></title>
    <guid isPermaLink="false">hb-0914</guid>
    <pubDate>Mon, 14 Sep 2026 08:00:00 PDT</pubDate>
    <itunes:duration>58:54</itunes:duration>
    <enclosure url="https://traffic.example.com/hb-0914.mp3" length="1" type="audio/mpeg"/>
    <description><![CDATA[<p>Talking &amp; listening</p>]]></description>
  </item>
  <item>
    <title>No date &amp; odd duration</title>
    <pubDate>sometime last week</pubDate>
    <itunes:duration>1:75</itunes:duration>
  </item>
  <item><description>no title, skipped</description></item>
</channel>
</rss>`;

describe('parseFeed', () => {
  it('parses channel and items, tolerating bad fields', () => {
    const feed = parseFeed(FEED);
    expect(feed).toMatchObject({
      title: 'Hidden Brain',
      podcastGuid: '917393e3-1b1e-5cef-ace4-edaa54e1f810',
      imageUrl: 'https://img.example.com/show.jpg',
    });
    expect(feed.items).toHaveLength(2);
    expect(feed.items[0]).toMatchObject({
      guid: 'hb-0914',
      durationSec: 3534,
      enclosureUrl: 'https://traffic.example.com/hb-0914.mp3',
      description: 'Talking & listening',
    });
    expect(feed.items[0]!.publishedAt?.toISOString()).toBe('2026-09-14T15:00:00.000Z');
    expect(feed.items[1]).toMatchObject({
      title: 'No date & odd duration',
      publishedAt: null,
      durationSec: null,
      guid: null,
    });
  });

  it('handles a feed with a single item', () => {
    const one = FEED.replace(
      /<item>\s*<title>No date[\s\S]*?<\/item>\s*<item><description>no title, skipped<\/description><\/item>/,
      '',
    );
    expect(parseFeed(one).items).toHaveLength(1);
  });

  it('rejects documents that are not RSS', () => {
    expect(() => parseFeed('<html><body>hi</body></html>')).toThrow(/no RSS channel/);
  });

  it('refuses documents that declare external entities (XXE)', () => {
    const xxe = `<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss><channel><title>&x;</title></channel></rss>`;
    expect(() => parseFeed(xxe)).toThrow(/not valid XML/);
  });

  it('decodes ISO-8859-1 feeds', () => {
    const latin1 = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="ISO-8859-1"?><rss><channel><title>Caf'),
      0xe9,
      ...new TextEncoder().encode('</title></channel></rss>'),
    ]);
    expect(parseFeed(decodeFeed(latin1)).title).toBe('Café');
  });
});

describe('RssClient', () => {
  it('refuses private URLs before making a request', async () => {
    const f = fakeFetch();
    await expect(
      new RssClient({ fetch: f.fetch }).fetchFeed('http://169.254.169.254/latest/meta-data'),
    ).rejects.toMatchObject({ kind: 'invalid_request' });
    expect(f.calls).toHaveLength(0);
  });
  it('fetches and parses a public feed', async () => {
    const f = fakeFetch().on('GET', 'feeds.example.com', { bytes: new TextEncoder().encode(FEED) });
    expect(
      (await new RssClient({ fetch: f.fetch }).fetchFeed('https://feeds.example.com/hb')).items,
    ).toHaveLength(2);
  });
});
