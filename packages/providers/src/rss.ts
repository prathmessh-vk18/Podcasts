import { XMLParser } from 'fast-xml-parser';
import { parseClockDuration, ProviderError, stripHtml } from '@tangent/core';
import { baseErrorKind, HttpClient, parseRetryAfter, type RawErrorResponse } from './http.js';
import type { Logger } from './logger.js';
import { assertPublicHttpUrl } from './safe-url.js';

/**
 * RSS is the closest thing podcasts have to a canonical source: item GUIDs and enclosure URLs
 * identify an episode across apps. We use it to enrich catalog results, not as a platform.
 */

export interface FeedItem {
  guid: string | null;
  title: string;
  publishedAt: Date | null;
  durationSec: number | null;
  enclosureUrl: string | null;
  link: string | null;
  description: string | null;
}

export interface Feed {
  title: string;
  /** <podcast:guid>: a show identifier that stays stable when the feed moves. */
  podcastGuid: string | null;
  link: string | null;
  imageUrl: string | null;
  items: FeedItem[];
}

const MAX_FEED_BYTES = 15 * 1024 * 1024;
const MAX_ITEMS = 2000;

function mapError(res: RawErrorResponse): ProviderError {
  return new ProviderError({
    kind: res.status === 410 ? 'not_found' : baseErrorKind(res.status),
    platform: 'rss',
    status: res.status,
    retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    message: `Feed request failed with ${res.status}`,
  });
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  cdataPropName: false,
  // Only the five XML entities; no DTD or external entity expansion (XXE-safe).
  processEntities: true,
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => name === 'item',
});

function text(node: unknown): string | null {
  if (node === undefined || node === null) return null;
  if (typeof node === 'string') return node.trim() || null;
  if (typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  if (typeof node === 'object') {
    const t = (node as Record<string, unknown>)['#text'];
    return t === undefined ? null : text(t);
  }
  return null;
}

function attr(node: unknown, name: string): string | null {
  if (!node || typeof node !== 'object') return null;
  const n = Array.isArray(node) ? node[0] : node;
  const v = (n as Record<string, unknown>)?.[`@_${name}`];
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function parseDate(s: string | null): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Feeds declare their encoding in the XML prolog; most are UTF-8 but ISO-8859-1 still appears. */
export function decodeFeed(bytes: Uint8Array): string {
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 200));
  const label = /encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function parseFeed(xml: string): Feed {
  let doc: Record<string, unknown>;
  try {
    doc = parser.parse(xml) as Record<string, unknown>;
  } catch (cause) {
    throw new ProviderError({
      kind: 'upstream_unavailable',
      platform: 'rss',
      message: 'Feed is not valid XML',
      cause,
    });
  }
  const rss = doc.rss as Record<string, unknown> | undefined;
  const channel = (rss?.channel ?? (doc.feed as unknown)) as Record<string, unknown> | undefined;
  if (!channel || typeof channel !== 'object') {
    throw new ProviderError({
      kind: 'upstream_unavailable',
      platform: 'rss',
      message: 'Feed has no RSS channel',
    });
  }

  const rawItems = Array.isArray(channel.item) ? (channel.item as Record<string, unknown>[]) : [];
  const items: FeedItem[] = rawItems.slice(0, MAX_ITEMS).flatMap((it) => {
    const title = text(it.title);
    if (!title) return [];
    const description = text(it['itunes:summary']) ?? text(it.description) ?? text(it['content:encoded']);
    return [
      {
        guid: text(it.guid),
        title: stripHtml(title),
        publishedAt: parseDate(text(it.pubDate)),
        durationSec: parseClockDuration(text(it['itunes:duration'])),
        enclosureUrl: attr(it.enclosure, 'url'),
        link: text(it.link),
        description: description ? stripHtml(description).slice(0, 2000) : null,
      },
    ];
  });

  return {
    title: stripHtml(text(channel.title) ?? ''),
    podcastGuid: text(channel['podcast:guid']),
    link: text(channel.link),
    imageUrl:
      attr(channel['itunes:image'], 'href') ??
      text((channel.image as Record<string, unknown> | undefined)?.url),
    items,
  };
}

export class RssClient {
  private readonly http: HttpClient;

  constructor(opts: { fetch?: typeof fetch; logger?: Logger } = {}) {
    this.http = new HttpClient({
      platform: 'rss',
      mapError,
      fetch: opts.fetch,
      logger: opts.logger,
      defaultTimeoutMs: 15_000,
      maxRetries: 2,
    });
  }

  async fetchFeed(url: string): Promise<Feed> {
    const safe = assertPublicHttpUrl(url);
    const res = await this.http.request<Uint8Array>({
      url: safe.toString(),
      responseType: 'bytes',
      maxBodyBytes: MAX_FEED_BYTES,
      headers: { accept: 'application/rss+xml, application/xml;q=0.9, text/xml;q=0.8, */*;q=0.5' },
      op: 'rss.fetch',
    });
    return parseFeed(decodeFeed(res.data));
  }
}
