import { buildSearchQuery, ProviderError, stripHtml, type EpisodeCandidate } from '@tangent/core';
import { baseErrorKind, HttpClient, parseRetryAfter, type RawErrorResponse } from './http.js';
import { TokenBucket } from './limits.js';
import type { Logger } from './logger.js';
import type { CatalogProvider, EpisodeHint } from './types.js';

/**
 * Apple Podcasts via the public iTunes Search API. Read-only: Apple has no playlist API,
 * so exporting to Apple is a link-list fallback handled by the app (PRD §8).
 * Docs: https://performance-partners.apple.com/search-api
 */

interface ITunesEpisode {
  wrapperType?: string;
  kind?: string;
  trackId?: number;
  trackName?: string;
  collectionId?: number;
  collectionName?: string;
  collectionViewUrl?: string;
  trackViewUrl?: string;
  releaseDate?: string;
  trackTimeMillis?: number;
  artworkUrl600?: string;
  artworkUrl160?: string;
  description?: string;
  shortDescription?: string;
  episodeGuid?: string;
  episodeUrl?: string;
  artistIds?: number[];
  feedUrl?: string;
}

interface ITunesResponse {
  resultCount?: number;
  results?: ITunesEpisode[];
}

export interface AppleOptions {
  country?: string;
  fetch?: typeof fetch;
  logger?: Logger;
  /** Override for tests. */
  bucket?: TokenBucket;
  sleep?: (ms: number) => Promise<void>;
}

const BASE = 'https://itunes.apple.com';

function mapError(res: RawErrorResponse): ProviderError {
  // Apple throttles with 403 or 429 and rarely sends Retry-After.
  const throttled = res.status === 403 || res.status === 429;
  return new ProviderError({
    kind: throttled ? 'rate_limited' : baseErrorKind(res.status),
    platform: 'apple',
    status: res.status,
    retryAfterMs: throttled ? (parseRetryAfter(res.headers.get('retry-after')) ?? 20_000) : undefined,
    message: `iTunes API error ${res.status}`,
  });
}

function validDate(s?: string): Date | null {
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mapITunesEpisode(r: ITunesEpisode): EpisodeCandidate | null {
  if (r.wrapperType !== 'podcastEpisode' || !r.trackId || !r.trackName || !r.collectionName) return null;
  const description = r.description ?? r.shortDescription;
  return {
    ref: {
      platform: 'apple',
      id: String(r.trackId),
      url: (
        r.trackViewUrl ?? `https://podcasts.apple.com/podcast/id${r.collectionId}?i=${r.trackId}`
      ).replace(/[?&]uo=\d+$/, ''),
    },
    title: stripHtml(r.trackName),
    showTitle: stripHtml(r.collectionName),
    showRef: r.collectionId
      ? {
          platform: 'apple',
          id: String(r.collectionId),
          url: r.collectionViewUrl ?? `https://podcasts.apple.com/podcast/id${r.collectionId}`,
        }
      : null,
    description: description ? stripHtml(description).slice(0, 2000) : null,
    publishedAt: validDate(r.releaseDate),
    durationSec: r.trackTimeMillis && r.trackTimeMillis > 0 ? Math.round(r.trackTimeMillis / 1000) : null,
    artworkUrl: r.artworkUrl600 ?? r.artworkUrl160 ?? null,
    feedItemGuid: r.episodeGuid ?? null,
    enclosureUrl: r.episodeUrl ?? null,
    popularity: null,
  };
}

export class AppleProvider implements CatalogProvider {
  readonly platform = 'apple' as const;
  private readonly http: HttpClient;
  private readonly country: string;
  private readonly bucket: TokenBucket;

  constructor(opts: AppleOptions = {}) {
    this.country = (opts.country ?? 'us').toLowerCase();
    this.http = new HttpClient({
      platform: 'apple',
      mapError,
      fetch: opts.fetch,
      logger: opts.logger,
      sleep: opts.sleep,
    });
    this.bucket = opts.bucket ?? new TokenBucket(20, 20 / 60);
  }

  private async get(
    path: string,
    query: Record<string, string | number>,
    op: string,
  ): Promise<ITunesEpisode[]> {
    await this.bucket.acquire();
    const res = await this.http.request<ITunesResponse>({
      url: `${BASE}${path}`,
      query: { country: this.country, ...query },
      op,
    });
    return Array.isArray(res.data?.results) ? res.data.results : [];
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<EpisodeCandidate[]> {
    const term = query.trim();
    if (!term) return [];
    const results = await this.get(
      '/search',
      {
        term,
        media: 'podcast',
        entity: 'podcastEpisode',
        limit: Math.min(Math.max(opts.limit ?? 20, 1), 200),
      },
      'apple.search',
    );
    return results.map(mapITunesEpisode).filter((e): e is EpisodeCandidate => e !== null);
  }

  /**
   * The iTunes lookup endpoint returns nothing for an episode id on its own (verified Oct 2026).
   * It only lists a show's latest ~200 episodes. So:
   *   1. with a show id → scan that show's recent episodes;
   *   2. otherwise, or for older episodes → search by title and pick the exact track id.
   */
  async getEpisode(id: string, hint: EpisodeHint = {}): Promise<EpisodeCandidate | null> {
    if (!/^\d+$/.test(id)) return null;
    if (hint.showId && /^\d+$/.test(hint.showId)) {
      const recent = await this.get(
        '/lookup',
        { id: hint.showId, entity: 'podcastEpisode', limit: 200 },
        'apple.lookup',
      );
      const hit = recent.find((r) => String(r.trackId) === id);
      if (hit) return mapITunesEpisode(hit);
    }
    if (hint.title?.trim()) {
      const found = await this.get(
        '/search',
        { term: hint.title.trim().slice(0, 200), media: 'podcast', entity: 'podcastEpisode', limit: 50 },
        'apple.lookupBySearch',
      );
      const hit = found.find((r) => String(r.trackId) === id);
      if (hit) return mapITunesEpisode(hit);
    }
    return null;
  }

  /** Recent episodes of a show (Apple returns at most ~200), newest first. */
  async getShowEpisodes(showId: string, limit = 50): Promise<EpisodeCandidate[]> {
    if (!/^\d+$/.test(showId)) return [];
    const results = await this.get(
      '/lookup',
      { id: showId, entity: 'podcastEpisode', limit: Math.min(limit, 200) },
      'apple.show',
    );
    return results.map(mapITunesEpisode).filter((e): e is EpisodeCandidate => e !== null);
  }

  /** The show's RSS feed URL, needed to enrich episodes with GUIDs and enclosures. */
  async getFeedUrl(showId: string): Promise<string | null> {
    if (!/^\d+$/.test(showId)) return null;
    const results = await this.get('/lookup', { id: showId, entity: 'podcast' }, 'apple.feed');
    return results.find((r) => r.feedUrl)?.feedUrl ?? null;
  }

  async findCandidates(source: EpisodeCandidate, opts: { limit?: number } = {}): Promise<EpisodeCandidate[]> {
    try {
      return await this.search(buildSearchQuery(source), { limit: opts.limit ?? 15 });
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return [];
      throw err;
    }
  }
}
