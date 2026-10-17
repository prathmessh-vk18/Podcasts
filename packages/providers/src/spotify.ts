import {
  buildSearchQuery,
  ProviderError,
  showSimilarity,
  stripHtml,
  type EpisodeCandidate,
  type ProviderRef,
} from '@tangent/core';
import { baseErrorKind, HttpClient, parseRetryAfter, type RawErrorResponse } from './http.js';
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
 * Spotify Web API.
 * Platform constraints (verified Oct 2026; re-check https://developer.spotify.com/documentation/web-api):
 * - Development Mode: max 5 users, app owner needs Premium (Feb 2026). Extended quota requires a
 *   registered business and 250k MAU. Users outside the allowlist get 403; mapped to `not_allowlisted`.
 * - Episodes require a `market`. Adding to playlists accepts `spotify:episode:` URIs, max 100 per request.
 * Endpoint paths live in ENDPOINTS so a platform change is a one-line fix.
 */
export const ENDPOINTS = {
  api: 'https://api.spotify.com/v1',
  accounts: 'https://accounts.spotify.com',
  me: '/me',
  search: '/search',
  episode: (id: string) => `/episodes/${encodeURIComponent(id)}`,
  showEpisodes: (id: string) => `/shows/${encodeURIComponent(id)}/episodes`,
  createPlaylist: (userId: string) => `/users/${encodeURIComponent(userId)}/playlists`,
  playlistItems: (id: string) => `/playlists/${encodeURIComponent(id)}/tracks`,
} as const;

export const SPOTIFY_SCOPES = ['playlist-modify-private', 'playlist-modify-public'] as const;

interface SpotifyImage {
  url: string;
  width?: number | null;
}
interface SpotifyShow {
  id: string;
  name: string;
  publisher?: string;
  external_urls?: { spotify?: string };
}
interface SpotifyEpisode {
  id: string;
  name: string;
  description?: string;
  release_date?: string;
  release_date_precision?: 'year' | 'month' | 'day';
  duration_ms?: number;
  external_urls?: { spotify?: string };
  images?: SpotifyImage[];
  is_playable?: boolean;
  restrictions?: { reason?: string };
  show?: SpotifyShow;
  type?: string;
}
interface Paging<T> {
  items?: Array<T | null>;
  next?: string | null;
  total?: number;
}

export interface SpotifyOptions {
  clientId: string;
  clientSecret: string;
  market?: string;
  /** Spotify has tightened search limits before; keep it configurable. */
  searchLimit?: number;
  fetch?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export function mapSpotifyError(res: RawErrorResponse): ProviderError {
  const err =
    (res.body as {
      error?: { message?: string; reason?: string; status?: number } | string;
      error_description?: string;
    } | null) ?? null;
  const obj = typeof err?.error === 'object' ? err.error : undefined;
  const message =
    obj?.message ?? err?.error_description ?? (typeof err?.error === 'string' ? err.error : '') ?? '';
  const reason = obj?.reason ?? (typeof err?.error === 'string' ? err.error : undefined);
  let kind = baseErrorKind(res.status);

  if (reason === 'invalid_grant') kind = 'auth_revoked';
  else if (reason === 'invalid_client') kind = 'not_configured';
  else if (res.status === 403 && /not registered|developer dashboard|allowlist/i.test(message))
    kind = 'not_allowlisted';
  else if (res.status === 429 && /quota/i.test(`${reason ?? ''} ${message}`)) kind = 'quota_exceeded';
  else if (res.status === 404 && /market|not available/i.test(message)) kind = 'unavailable_in_market';

  return new ProviderError({
    kind,
    platform: 'spotify',
    status: res.status,
    reason,
    retryAfterMs:
      kind === 'rate_limited' ? (parseRetryAfter(res.headers.get('retry-after')) ?? 2_000) : undefined,
    message: message ? `Spotify: ${message}` : `Spotify API error ${res.status}`,
  });
}

function releaseDate(e: SpotifyEpisode): Date | null {
  // "2026" or "2026-09" can't be used for day-level matching; treat as unknown.
  if (!e.release_date || (e.release_date_precision && e.release_date_precision !== 'day')) return null;
  const d = new Date(`${e.release_date}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function mapSpotifyEpisode(
  e: SpotifyEpisode | null | undefined,
  show?: SpotifyShow | null,
): EpisodeCandidate | null {
  if (!e?.id || !e.name) return null;
  if (e.is_playable === false || e.restrictions?.reason === 'market') return null;
  const s = e.show ?? show ?? null;
  if (!s?.name) return null; // without the show we can't match safely
  return {
    ref: {
      platform: 'spotify',
      id: e.id,
      url: e.external_urls?.spotify ?? `https://open.spotify.com/episode/${e.id}`,
    },
    title: stripHtml(e.name),
    showTitle: stripHtml(s.name),
    showRef: {
      platform: 'spotify',
      id: s.id,
      url: s.external_urls?.spotify ?? `https://open.spotify.com/show/${s.id}`,
    },
    description: e.description ? stripHtml(e.description).slice(0, 2000) : null,
    publishedAt: releaseDate(e),
    durationSec: e.duration_ms && e.duration_ms > 0 ? Math.round(e.duration_ms / 1000) : null,
    artworkUrl: e.images?.[0]?.url ?? null,
    people: s.publisher ? [s.publisher] : [],
    popularity: null, // Spotify doesn't expose play counts; charts are a separate, non-API source
  };
}

/** Client-credentials token for catalog reads, cached and refreshed once (no stampede). */
class AppTokenCache {
  private token: { value: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  constructor(
    private readonly fetchToken: () => Promise<TokenSet>,
    private readonly now: () => Date,
  ) {}

  async get(): Promise<string> {
    if (this.token && this.token.expiresAt - 60_000 > this.now().getTime()) return this.token.value;
    this.inflight ??= this.fetchToken()
      .then((t) => {
        this.token = { value: t.accessToken, expiresAt: t.expiresAt.getTime() };
        return t.accessToken;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  invalidate(): void {
    this.token = null;
  }
}

export class SpotifyProvider implements CatalogProvider, OAuthProvider, PlaylistDestination {
  readonly platform = 'spotify' as const;
  readonly scopes = SPOTIFY_SCOPES;
  readonly limits: DestinationLimits = {
    maxItemsPerRequest: 100,
    maxTitleLength: 100,
    maxDescriptionLength: 300,
  };

  private readonly http: HttpClient;
  private readonly market: string;
  private readonly searchLimit: number;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly appToken: AppTokenCache;

  constructor(private readonly opts: SpotifyOptions) {
    this.http = new HttpClient({
      platform: 'spotify',
      mapError: mapSpotifyError,
      fetch: opts.fetch,
      logger: opts.logger,
      sleep: opts.sleep,
    });
    this.market = (opts.market ?? 'US').toUpperCase();
    this.searchLimit = opts.searchLimit ?? 10;
    this.now = opts.now ?? (() => new Date());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.appToken = new AppTokenCache(() => this.clientCredentials(), this.now);
  }

  private basicAuth(): string {
    return 'Basic ' + Buffer.from(`${this.opts.clientId}:${this.opts.clientSecret}`).toString('base64');
  }

  private async token(
    form: Record<string, string>,
    op: string,
    previousRefresh: string | null = null,
  ): Promise<TokenSet> {
    const res = await this.http.request<Record<string, unknown>>({
      method: 'POST',
      url: `${ENDPOINTS.accounts}/api/token`,
      headers: { authorization: this.basicAuth() },
      form,
      retry: true, // token requests are safe to repeat
      op,
    });
    return toTokenSet(res.data ?? {}, this.now(), previousRefresh);
  }

  private clientCredentials(): Promise<TokenSet> {
    return this.token({ grant_type: 'client_credentials' }, 'spotify.token.app');
  }

  /** Catalog GET with the app token; on 401 refresh the token once and retry. */
  private async catalogGet<T>(path: string, query: Record<string, string | number>, op: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.appToken.get();
      try {
        const res = await this.http.request<T>({
          url: `${ENDPOINTS.api}${path}`,
          query,
          headers: { authorization: `Bearer ${token}` },
          op,
        });
        return res.data;
      } catch (err) {
        if (err instanceof ProviderError && err.kind === 'auth_expired' && attempt === 0) {
          this.appToken.invalidate();
          continue;
        }
        throw err;
      }
    }
  }

  // ---------------------------------------------------------------- catalog
  async search(query: string, opts: { limit?: number } = {}): Promise<EpisodeCandidate[]> {
    const q = query.trim();
    if (!q) return [];
    const data = await this.catalogGet<{ episodes?: Paging<SpotifyEpisode> }>(
      ENDPOINTS.search,
      {
        q,
        type: 'episode',
        market: this.market,
        limit: Math.min(opts.limit ?? this.searchLimit, this.searchLimit),
      },
      'spotify.search',
    );
    // Simplified episodes in search results omit the show, so hydrate each one.
    const ids = (data.episodes?.items ?? []).filter((e): e is SpotifyEpisode => !!e?.id).map((e) => e.id);
    return this.hydrate(ids);
  }

  private async hydrate(ids: string[], concurrency = 3): Promise<EpisodeCandidate[]> {
    const out: Array<EpisodeCandidate | null> = new Array(ids.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const i = next++;
        out[i] = await this.getEpisode(ids[i]!).catch((err) => {
          if (
            err instanceof ProviderError &&
            (err.kind === 'not_found' || err.kind === 'unavailable_in_market')
          )
            return null;
          throw err;
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    return out.filter((e): e is EpisodeCandidate => e !== null);
  }

  async getEpisode(id: string): Promise<EpisodeCandidate | null> {
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return null;
    try {
      const e = await this.catalogGet<SpotifyEpisode>(
        ENDPOINTS.episode(id),
        { market: this.market },
        'spotify.episode',
      );
      return mapSpotifyEpisode(e);
    } catch (err) {
      if (err instanceof ProviderError && (err.kind === 'not_found' || err.kind === 'invalid_request'))
        return null;
      throw err;
    }
  }

  private async searchShows(name: string): Promise<SpotifyShow[]> {
    const data = await this.catalogGet<{ shows?: Paging<SpotifyShow> }>(
      ENDPOINTS.search,
      { q: name.slice(0, 100), type: 'show', market: this.market, limit: Math.min(5, this.searchLimit) },
      'spotify.searchShows',
    );
    return (data.shows?.items ?? []).filter((s): s is SpotifyShow => !!s?.id && !!s.name);
  }

  /** Walk a show's episodes (newest first) until we pass the target date window. */
  private async showEpisodes(
    show: SpotifyShow,
    notBefore: Date | null,
    maxPages = 6,
  ): Promise<EpisodeCandidate[]> {
    const out: EpisodeCandidate[] = [];
    for (let page = 0; page < maxPages; page++) {
      const data = await this.catalogGet<Paging<SpotifyEpisode>>(
        ENDPOINTS.showEpisodes(show.id),
        { market: this.market, limit: 50, offset: page * 50 },
        'spotify.showEpisodes',
      );
      const items = (data.items ?? []).filter((e): e is SpotifyEpisode => !!e);
      for (const e of items) {
        const c = mapSpotifyEpisode(e, show);
        if (c) out.push(c);
      }
      const oldest = items.length ? releaseDate(items[items.length - 1]!) : null;
      if (!data.next || items.length === 0) break;
      if (notBefore && oldest && oldest < notBefore) break;
    }
    return out;
  }

  async findCandidates(source: EpisodeCandidate, opts: { limit?: number } = {}): Promise<EpisodeCandidate[]> {
    const shows = (await this.searchShows(source.showTitle))
      .map((s) => ({ s, sim: showSimilarity(source.showTitle, s.name) }))
      .filter((x) => x.sim >= 0.7)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, 2);

    if (shows.length) {
      const notBefore = source.publishedAt ? new Date(source.publishedAt.getTime() - 30 * 86_400_000) : null;
      const lists = await Promise.all(shows.map(({ s }) => this.showEpisodes(s, notBefore)));
      const all = lists.flat();
      if (all.length) return all;
    }
    // Fallback: the show name differs too much (or isn't on Spotify); try an episode search.
    return this.search(buildSearchQuery(source), { limit: opts.limit ?? this.searchLimit });
  }

  // ---------------------------------------------------------------- OAuth
  buildAuthorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string {
    const u = new URL(`${ENDPOINTS.accounts}/authorize`);
    u.search = new URLSearchParams({
      response_type: 'code',
      client_id: this.opts.clientId,
      scope: this.scopes.join(' '),
      redirect_uri: input.redirectUri,
      state: input.state,
      code_challenge_method: 'S256',
      code_challenge: input.codeChallenge,
    }).toString();
    return u.toString();
  }

  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet> {
    return this.token(
      {
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
        client_id: this.opts.clientId,
      },
      'spotify.token.exchange',
    );
  }

  refresh(refreshToken: string): Promise<TokenSet> {
    return this.token(
      { grant_type: 'refresh_token', refresh_token: refreshToken },
      'spotify.token.refresh',
      refreshToken,
    );
  }

  /** Spotify has no token revocation endpoint. Users remove access at spotify.com/account/apps. */
  async revoke(_token: string): Promise<void> {}

  async getAccount(accessToken: string): Promise<AccountInfo> {
    const res = await this.http.request<{ id?: string; display_name?: string | null }>({
      url: `${ENDPOINTS.api}${ENDPOINTS.me}`,
      headers: { authorization: `Bearer ${accessToken}` },
      op: 'spotify.me',
    });
    if (!res.data?.id)
      throw new ProviderError({
        kind: 'upstream_unavailable',
        platform: 'spotify',
        message: 'Spotify returned no user id',
      });
    return { externalId: res.data.id, displayName: res.data.display_name ?? null };
  }

  // ---------------------------------------------------------------- playlists
  /** POST that only retries on 429 (safe: the request wasn't processed). Timeouts are not retried. */
  private async write<T>(accessToken: string, path: string, json: unknown, op: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.http.request<T>({
          method: 'POST',
          url: `${ENDPOINTS.api}${path}`,
          headers: { authorization: `Bearer ${accessToken}` },
          json,
          retry: false,
          op,
        });
        return res.data;
      } catch (err) {
        if (
          err instanceof ProviderError &&
          err.kind === 'rate_limited' &&
          attempt < 3 &&
          (err.retryAfterMs ?? 0) <= 30_000
        ) {
          await this.sleep(err.retryAfterMs ?? 2_000);
          continue;
        }
        throw err;
      }
    }
  }

  async createPlaylist(accessToken: string, input: PlaylistInput): Promise<{ id: string; url: string }> {
    const me = await this.getAccount(accessToken);
    const clean = (s: string, n: number) =>
      s
        .replace(/[\r\n<>]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, n);
    const data = await this.write<{ id?: string; external_urls?: { spotify?: string } }>(
      accessToken,
      ENDPOINTS.createPlaylist(me.externalId),
      {
        name: clean(input.title, this.limits.maxTitleLength) || 'Tangent collection',
        description: clean(input.description, this.limits.maxDescriptionLength),
        public: input.privacy === 'public',
      },
      'spotify.createPlaylist',
    );
    if (!data?.id)
      throw new ProviderError({
        kind: 'upstream_unavailable',
        platform: 'spotify',
        message: 'Spotify did not return a playlist id',
      });
    return {
      id: data.id,
      url: data.external_urls?.spotify ?? `https://open.spotify.com/playlist/${data.id}`,
    };
  }

  async addItems(accessToken: string, playlistId: string, refs: ProviderRef[]): Promise<AddItemResult[]> {
    const results: AddItemResult[] = [];
    for (let i = 0; i < refs.length; i += this.limits.maxItemsPerRequest) {
      results.push(
        ...(await this.addChunk(accessToken, playlistId, refs.slice(i, i + this.limits.maxItemsPerRequest))),
      );
    }
    return results;
  }

  private async addChunk(
    accessToken: string,
    playlistId: string,
    chunk: ProviderRef[],
  ): Promise<AddItemResult[]> {
    if (chunk.length === 0) return [];
    try {
      await this.write(
        accessToken,
        ENDPOINTS.playlistItems(playlistId),
        { uris: chunk.map((r) => `spotify:episode:${r.id}`) },
        'spotify.addItems',
      );
      return chunk.map((ref) => ({ ref, ok: true as const, destinationItemId: null }));
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      // One bad URI fails the whole request; split to find it instead of failing 99 good items.
      if (err.kind === 'invalid_request' && chunk.length > 1) {
        const mid = Math.ceil(chunk.length / 2);
        return [
          ...(await this.addChunk(accessToken, playlistId, chunk.slice(0, mid))),
          ...(await this.addChunk(accessToken, playlistId, chunk.slice(mid))),
        ];
      }
      if (err.kind === 'invalid_request' || err.kind === 'unavailable_in_market') {
        return chunk.map((ref) => ({ ref, ok: false as const, error: err }));
      }
      // Ambiguous transient failures: report per item so the engine can reconcile before retrying.
      if (
        err.kind === 'timeout' ||
        err.kind === 'network' ||
        err.kind === 'upstream_unavailable' ||
        err.kind === 'rate_limited'
      ) {
        return chunk.map((ref) => ({ ref, ok: false as const, error: err }));
      }
      throw err; // auth, allowlist, quota, missing playlist: whole operation fails
    }
  }

  /** Episode ids already in the playlist, used to make retries idempotent. */
  async listItemIds(accessToken: string, playlistId: string, maxPages = 20): Promise<Set<string>> {
    const ids = new Set<string>();
    let url: string | null =
      `${ENDPOINTS.api}${ENDPOINTS.playlistItems(playlistId)}?limit=100&market=${this.market}`;
    for (let page = 0; url && page < maxPages; page++) {
      const res: { data: Paging<{ track?: { id?: string; type?: string } | null }> } =
        await this.http.request({
          url,
          headers: { authorization: `Bearer ${accessToken}` },
          op: 'spotify.listItems',
        });
      for (const it of res.data?.items ?? []) if (it?.track?.id) ids.add(it.track.id);
      url = res.data?.next ?? null;
    }
    return ids;
  }
}
