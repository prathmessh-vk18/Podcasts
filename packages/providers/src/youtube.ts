import {
  buildSearchQuery,
  decodeEntities,
  parseIsoDuration,
  ProviderError,
  stripHtml,
  type EpisodeCandidate,
  type ProviderRef,
} from '@tangent/core';
import { baseErrorKind, HttpClient, parseRetryAfter, type RawErrorResponse } from './http.js';
import { MemoryQuotaStore, QuotaBudget } from './limits.js';
import type { Logger } from './logger.js';
import { toTokenSet, type TokenSet } from './oauth.js';
import type {
  AccountInfo,
  AddItemResult,
  CatalogProvider,
  DestinationLimits,
  OAuthProvider,
  PlaylistDestination,
  PlaylistInput,
} from './types.js';

/**
 * YouTube Data API v3 + Google OAuth.
 * Quota (default 10,000 units/day, resets midnight Pacific). Costs used here:
 *   search.list 100 · videos.list 1 · channels.list 1 · playlists.insert 50 · playlistItems.insert 50 · playlistItems.list 1
 * Every call reserves its cost first (QuotaBudget) so an export never starts work it can't finish.
 * Docs: https://developers.google.com/youtube/v3/determine_quota_cost
 */
export const YT = {
  api: 'https://www.googleapis.com/youtube/v3',
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  scope: 'https://www.googleapis.com/auth/youtube',
} as const;

export const YT_COST = {
  search: 100,
  videos: 1,
  channels: 1,
  playlistInsert: 50,
  itemInsert: 50,
  itemList: 1,
} as const;

interface YtThumb {
  url: string;
}
interface YtVideo {
  id: string;
  snippet?: {
    title?: string;
    description?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    liveBroadcastContent?: 'none' | 'live' | 'upcoming';
    thumbnails?: { maxres?: YtThumb; high?: YtThumb; medium?: YtThumb; default?: YtThumb };
  };
  contentDetails?: { duration?: string; regionRestriction?: { allowed?: string[]; blocked?: string[] } };
  statistics?: { viewCount?: string };
  status?: { privacyStatus?: string; embeddable?: boolean };
}

export interface YouTubeOptions {
  apiKey: string;
  clientId?: string;
  clientSecret?: string;
  regionCode?: string;
  /** Shared budget. Pass a database-backed QuotaBudget when running more than one instance. */
  budget?: QuotaBudget;
  dailyQuota?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export function mapYouTubeError(res: RawErrorResponse): ProviderError {
  const body = res.body as {
    error?: { message?: string; errors?: Array<{ reason?: string; message?: string }> } | string;
    error_description?: string;
  } | null;
  const obj = typeof body?.error === 'object' ? body.error : undefined;
  const reason = obj?.errors?.[0]?.reason ?? (typeof body?.error === 'string' ? body.error : undefined);
  const message = obj?.message ?? body?.error_description ?? reason ?? `YouTube API error ${res.status}`;
  let kind = baseErrorKind(res.status);

  switch (reason) {
    case 'quotaExceeded':
    case 'dailyLimitExceeded':
      kind = 'quota_exceeded';
      break;
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      kind = 'rate_limited';
      break;
    case 'invalid_grant':
      kind = 'auth_revoked';
      break;
    case 'invalid_client':
    case 'keyInvalid':
      kind = 'not_configured';
      break;
    case 'videoNotFound':
    case 'playlistNotFound':
    case 'channelNotFound':
      kind = 'not_found';
      break;
    case 'youtubeSignupRequired':
    case 'insufficientPermissions':
      kind = 'forbidden';
      break;
  }
  // 409 "SERVICE_UNAVAILABLE"/conflict happens on rapid sequential writes; it's transient.
  if (res.status === 409) kind = 'upstream_unavailable';

  return new ProviderError({
    kind,
    platform: 'youtube',
    status: res.status,
    reason,
    retryAfterMs:
      kind === 'rate_limited' ? (parseRetryAfter(res.headers.get('retry-after')) ?? 2_000) : undefined,
    message: `YouTube: ${decodeEntities(String(message)).replace(/<[^>]+>/g, '')}`,
  });
}

function bestThumb(t?: NonNullable<YtVideo['snippet']>['thumbnails']): string | null {
  return t?.maxres?.url ?? t?.high?.url ?? t?.medium?.url ?? t?.default?.url ?? null;
}

export function isPlayableIn(v: YtVideo, region: string): boolean {
  const r = v.contentDetails?.regionRestriction;
  if (r?.blocked?.includes(region)) return false;
  if (r?.allowed && !r.allowed.includes(region)) return false;
  if (v.snippet?.liveBroadcastContent && v.snippet.liveBroadcastContent !== 'none') return false;
  if (v.status?.privacyStatus && v.status.privacyStatus === 'private') return false;
  return true;
}

export function mapYouTubeVideo(v: YtVideo, now: Date, region = 'US'): EpisodeCandidate | null {
  if (!v.id || !v.snippet?.title || !v.snippet.channelTitle) return null;
  if (!isPlayableIn(v, region)) return null;
  const views = v.statistics?.viewCount !== undefined ? Number(v.statistics.viewCount) : NaN;
  const published = v.snippet.publishedAt ? new Date(v.snippet.publishedAt) : null;
  return {
    ref: { platform: 'youtube', id: v.id, url: `https://www.youtube.com/watch?v=${v.id}` },
    title: decodeEntities(v.snippet.title),
    showTitle: decodeEntities(v.snippet.channelTitle),
    showRef: v.snippet.channelId
      ? {
          platform: 'youtube',
          id: v.snippet.channelId,
          url: `https://www.youtube.com/channel/${v.snippet.channelId}`,
        }
      : null,
    description: v.snippet.description ? stripHtml(v.snippet.description).slice(0, 2000) : null,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
    durationSec: parseIsoDuration(v.contentDetails?.duration),
    artworkUrl: bestThumb(v.snippet.thumbnails),
    popularity: Number.isFinite(views)
      ? { available: true, kind: 'views', value: views, source: 'youtube', retrievedAt: now }
      : { available: false, source: 'youtube', retrievedAt: now },
  };
}

export class YouTubeProvider implements CatalogProvider, OAuthProvider, PlaylistDestination {
  readonly platform = 'youtube' as const;
  readonly scopes = [YT.scope] as const;
  readonly limits: DestinationLimits = {
    maxItemsPerRequest: 1,
    maxTitleLength: 150,
    maxDescriptionLength: 5000,
    quota: { createPlaylist: YT_COST.playlistInsert, addItem: YT_COST.itemInsert },
  };

  readonly budget: QuotaBudget;
  private readonly http: HttpClient;
  private readonly region: string;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: YouTubeOptions) {
    this.http = new HttpClient({
      platform: 'youtube',
      mapError: mapYouTubeError,
      fetch: opts.fetch,
      logger: opts.logger,
      sleep: opts.sleep,
    });
    this.region = (opts.regionCode ?? 'US').toUpperCase();
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.budget =
      opts.budget ??
      new QuotaBudget(
        new MemoryQuotaStore(),
        'youtube',
        opts.dailyQuota ?? 10_000,
        'America/Los_Angeles',
        this.now,
      );
  }

  private async keyGet<T>(
    path: string,
    query: Record<string, string | number | undefined>,
    cost: number,
    op: string,
  ): Promise<T> {
    await this.budget.consume(cost, op);
    const res = await this.http.request<T>({
      url: `${YT.api}${path}`,
      query: { ...query, key: this.opts.apiKey },
      op,
    });
    return res.data;
  }

  // ---------------------------------------------------------------- catalog
  private async videos(ids: string[]): Promise<EpisodeCandidate[]> {
    if (ids.length === 0) return [];
    const data = await this.keyGet<{ items?: YtVideo[] }>(
      '/videos',
      { part: 'snippet,contentDetails,statistics,status', id: ids.slice(0, 50).join(','), maxResults: 50 },
      YT_COST.videos,
      'youtube.videos',
    );
    const byId = new Map((data.items ?? []).map((v) => [v.id, v]));
    // Keep search ranking order.
    return ids.flatMap((id) => {
      const v = byId.get(id);
      const c = v ? mapYouTubeVideo(v, this.now(), this.region) : null;
      return c ? [c] : [];
    });
  }

  private async searchIds(
    q: string,
    limit: number,
    window?: { after?: Date; before?: Date },
  ): Promise<string[]> {
    const data = await this.keyGet<{ items?: Array<{ id?: { videoId?: string } }> }>(
      '/search',
      {
        part: 'id',
        type: 'video',
        q: q.slice(0, 200),
        maxResults: Math.min(Math.max(limit, 1), 25),
        regionCode: this.region,
        publishedAfter: window?.after?.toISOString(),
        publishedBefore: window?.before?.toISOString(),
        safeSearch: 'none',
      },
      YT_COST.search,
      'youtube.search',
    );
    return [...new Set((data.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => !!id))];
  }

  async search(query: string, opts: { limit?: number } = {}): Promise<EpisodeCandidate[]> {
    const q = query.trim();
    if (!q) return [];
    return this.videos(await this.searchIds(q, opts.limit ?? 10));
  }

  async getEpisode(id: string): Promise<EpisodeCandidate | null> {
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
    return (await this.videos([id]))[0] ?? null;
  }

  async findCandidates(source: EpisodeCandidate, opts: { limit?: number } = {}): Promise<EpisodeCandidate[]> {
    const q = buildSearchQuery(source);
    const day = 86_400_000;
    // Uploads often land a little before or after the audio; a ±30 day window cuts noise a lot.
    const window = source.publishedAt
      ? {
          after: new Date(source.publishedAt.getTime() - 30 * day),
          before: new Date(source.publishedAt.getTime() + 30 * day),
        }
      : undefined;
    let ids = await this.searchIds(q, opts.limit ?? 10, window);
    if (ids.length === 0 && window) ids = await this.searchIds(q, opts.limit ?? 10); // the date might be wrong
    return this.videos(ids);
  }

  // ---------------------------------------------------------------- OAuth
  private requireOAuth(): { clientId: string; clientSecret: string } {
    if (!this.opts.clientId || !this.opts.clientSecret) {
      throw new ProviderError({
        kind: 'not_configured',
        platform: 'youtube',
        message: 'Google OAuth client is not configured',
      });
    }
    return { clientId: this.opts.clientId, clientSecret: this.opts.clientSecret };
  }

  buildAuthorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const { clientId } = this.requireOAuth();
    const u = new URL(YT.authorize);
    u.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: this.scopes.join(' '),
      access_type: 'offline', // needed for a refresh token
      prompt: 'consent', // otherwise Google omits the refresh token on re-consent
      include_granted_scopes: 'true',
      state: input.state,
      code_challenge: input.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return u.toString();
  }

  private async tokenRequest(
    form: Record<string, string>,
    op: string,
    previousRefresh: string | null = null,
  ): Promise<TokenSet> {
    const { clientId, clientSecret } = this.requireOAuth();
    const res = await this.http.request<Record<string, unknown>>({
      method: 'POST',
      url: YT.token,
      form: { ...form, client_id: clientId, client_secret: clientSecret },
      retry: true,
      op,
    });
    const tokens = toTokenSet(res.data ?? {}, this.now(), previousRefresh);
    // Granular consent lets users untick scopes; without this one we can't create playlists.
    if (tokens.scopes.length && !tokens.scopes.includes(YT.scope)) {
      throw new ProviderError({
        kind: 'forbidden',
        platform: 'youtube',
        message: 'YouTube access was not granted. Please allow "Manage your YouTube account".',
      });
    }
    return tokens;
  }

  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet> {
    return this.tokenRequest(
      {
        grant_type: 'authorization_code',
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
      },
      'youtube.token.exchange',
    );
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.tokenRequest(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'youtube.token.refresh',
      refreshToken,
    );
  }

  async revoke(token: string): Promise<void> {
    await this.http
      .request({ method: 'POST', url: YT.revoke, form: { token }, retry: true, op: 'youtube.revoke' })
      .catch((err) => {
        // Already revoked or expired tokens return 400; that's the outcome we wanted.
        if (err instanceof ProviderError && (err.status === 400 || err.kind === 'auth_revoked')) return;
        throw err;
      });
  }

  private async userGet<T>(
    token: string,
    path: string,
    query: Record<string, string | number>,
    cost: number,
    op: string,
  ): Promise<T> {
    await this.budget.consume(cost, op);
    const res = await this.http.request<T>({
      url: `${YT.api}${path}`,
      query,
      headers: { authorization: `Bearer ${token}` },
      op,
    });
    return res.data;
  }

  async getAccount(accessToken: string): Promise<AccountInfo> {
    const data = await this.userGet<{ items?: Array<{ id: string; snippet?: { title?: string } }> }>(
      accessToken,
      '/channels',
      { part: 'snippet', mine: 'true' },
      YT_COST.channels,
      'youtube.channels',
    );
    const ch = data.items?.[0];
    if (!ch) {
      throw new ProviderError({
        kind: 'forbidden',
        platform: 'youtube',
        reason: 'noChannel',
        message: 'This Google account has no YouTube channel. Create one at youtube.com, then connect again.',
      });
    }
    return { externalId: ch.id, displayName: ch.snippet?.title ?? null };
  }

  // ---------------------------------------------------------------- playlists
  /** Write with retry only for 429 and the transient 409; never for timeouts (could duplicate). */
  private async userWrite<T>(
    token: string,
    path: string,
    query: Record<string, string>,
    json: unknown,
    cost: number,
    op: string,
  ): Promise<T> {
    await this.budget.consume(cost, op);
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.http.request<T>({
          method: 'POST',
          url: `${YT.api}${path}`,
          query,
          json,
          headers: { authorization: `Bearer ${token}` },
          retry: false,
          op,
        });
        return res.data;
      } catch (err) {
        const retryable =
          err instanceof ProviderError &&
          (err.kind === 'rate_limited' || (err.status === 409 && attempt < 2));
        if (retryable && attempt < 3) {
          await this.sleep((err as ProviderError).retryAfterMs ?? 1_000 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  }

  async createPlaylist(accessToken: string, input: PlaylistInput): Promise<{ id: string; url: string }> {
    // YouTube rejects "<" and ">" in titles and descriptions.
    const clean = (s: string, n: number) => s.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
    const data = await this.userWrite<{ id?: string }>(
      accessToken,
      '/playlists',
      { part: 'snippet,status' },
      {
        snippet: {
          title: clean(input.title, this.limits.maxTitleLength) || 'Tangent collection',
          description: clean(input.description, this.limits.maxDescriptionLength),
        },
        status: { privacyStatus: input.privacy === 'public' ? 'public' : 'private' },
      },
      YT_COST.playlistInsert,
      'youtube.createPlaylist',
    );
    if (!data?.id)
      throw new ProviderError({
        kind: 'upstream_unavailable',
        platform: 'youtube',
        message: 'YouTube did not return a playlist id',
      });
    return { id: data.id, url: `https://www.youtube.com/playlist?list=${data.id}` };
  }

  async addItems(accessToken: string, playlistId: string, refs: ProviderRef[]): Promise<AddItemResult[]> {
    const results: AddItemResult[] = [];
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i]!;
      try {
        const data = await this.userWrite<{ id?: string }>(
          accessToken,
          '/playlistItems',
          { part: 'snippet' },
          { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: ref.id } } },
          YT_COST.itemInsert,
          'youtube.addItem',
        );
        results.push({ ref, ok: true, destinationItemId: data?.id ?? null });
      } catch (err) {
        if (!(err instanceof ProviderError)) throw err;
        if (err.kind === 'not_found' && err.reason === 'playlistNotFound') throw err;
        if (err.kind === 'auth_expired' || err.kind === 'auth_revoked' || err.kind === 'not_configured')
          throw err;
        if (err.kind === 'quota_exceeded') {
          // Nothing else will succeed today: fail this and the rest without spending more calls.
          for (const rest of refs.slice(i)) results.push({ ref: rest, ok: false, error: err });
          break;
        }
        results.push({ ref, ok: false, error: err });
      }
    }
    return results;
  }

  async listItemIds(accessToken: string, playlistId: string, maxPages = 20): Promise<Set<string>> {
    const ids = new Set<string>();
    let pageToken: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const data: {
        items?: Array<{ snippet?: { resourceId?: { videoId?: string } } }>;
        nextPageToken?: string;
      } = await this.userGet(
        accessToken,
        '/playlistItems',
        { part: 'snippet', playlistId, maxResults: 50, ...(pageToken ? { pageToken } : {}) },
        YT_COST.itemList,
        'youtube.listItems',
      );
      for (const it of data.items ?? [])
        if (it.snippet?.resourceId?.videoId) ids.add(it.snippet.resourceId.videoId);
      if (!data.nextPageToken) break;
      pageToken = data.nextPageToken;
    }
    return ids;
  }

  /** Units an export of `n` items will cost (create playlist + one insert per item). */
  exportCost(n: number, createPlaylist = true): number {
    return (createPlaylist ? YT_COST.playlistInsert : 0) + n * YT_COST.itemInsert;
  }
}
