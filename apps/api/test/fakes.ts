import { ProviderError, type EpisodeCandidate, type Platform, type ProviderRef } from '@tangent/core';
import type {
  AccountInfo,
  AddItemResult,
  CatalogProvider,
  DestinationLimits,
  OAuthProvider,
  PlaylistDestination,
  PlaylistInput,
  TokenSet,
} from '@tangent/providers';

export function ep(platform: Platform, id: string, extra: Partial<EpisodeCandidate> = {}): EpisodeCandidate {
  return {
    ref: { platform, id, url: `https://${platform}.test/${id}` },
    title: `Episode ${id}`,
    showTitle: 'Hidden Brain',
    publishedAt: new Date('2026-09-14T08:00:00Z'),
    durationSec: 3534,
    ...extra,
  };
}

export class FakeCatalog implements CatalogProvider {
  episodes = new Map<string, EpisodeCandidate>();
  candidates = new Map<string, EpisodeCandidate[]>();
  failSearch: ProviderError | null = null;
  findCalls = 0;

  constructor(readonly platform: Platform) {}

  add(...eps: EpisodeCandidate[]): this {
    for (const e of eps) this.episodes.set(e.ref.id, e);
    return this;
  }

  async search(query: string): Promise<EpisodeCandidate[]> {
    if (this.failSearch) throw this.failSearch;
    return [...this.episodes.values()].filter((e) => e.title.toLowerCase().includes(query.toLowerCase()));
  }
  async getEpisode(id: string): Promise<EpisodeCandidate | null> {
    return this.episodes.get(id) ?? null;
  }
  async findCandidates(source: EpisodeCandidate): Promise<EpisodeCandidate[]> {
    this.findCalls++;
    return this.candidates.get(source.ref.id) ?? [];
  }
}

/** A destination with a real in-memory playlist, so tests can assert exactly what landed. */
export class FakeDestination implements PlaylistDestination, OAuthProvider {
  readonly limits: DestinationLimits = {
    maxItemsPerRequest: 100,
    maxTitleLength: 100,
    maxDescriptionLength: 300,
  };
  readonly scopes = ['playlist-modify-private'];
  playlists = new Map<string, string[]>();
  /** Per-item failures to inject once: id → error. */
  failOnce = new Map<string, ProviderError>();
  /** Accept the item, then report a timeout (the "succeeded but we never heard back" case). */
  timeoutAfterAccept = new Set<string>();
  throwOnAdd: ProviderError | null = null;
  refreshBehaviour: 'ok' | 'revoked' = 'ok';
  refreshCalls = 0;
  addCalls = 0;
  private seq = 0;

  constructor(readonly platform: Platform) {}

  // OAuth
  buildAuthorizeUrl(i: { state: string; codeChallenge: string; redirectUri: string }): string {
    return `https://auth.test/authorize?state=${i.state}&challenge=${i.codeChallenge}&redirect_uri=${encodeURIComponent(i.redirectUri)}`;
  }
  async exchangeCode(i: { code: string }): Promise<TokenSet> {
    if (i.code === 'bad')
      throw new ProviderError({ kind: 'invalid_request', platform: this.platform, message: 'bad code' });
    return {
      accessToken: `access-${i.code}`,
      refreshToken: `refresh-${i.code}`,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: this.scopes,
    };
  }
  async refresh(refreshToken: string): Promise<TokenSet> {
    this.refreshCalls++;
    if (this.refreshBehaviour === 'revoked')
      throw new ProviderError({ kind: 'auth_revoked', platform: this.platform, message: 'revoked' });
    return {
      accessToken: `access-refreshed-${this.refreshCalls}`,
      refreshToken,
      expiresAt: new Date(Date.now() + 3600_000),
      scopes: this.scopes,
    };
  }
  async revoke(): Promise<void> {}
  async getAccount(): Promise<AccountInfo> {
    return { externalId: 'user-123', displayName: 'Test User' };
  }

  // Destination
  async createPlaylist(_t: string, input: PlaylistInput): Promise<{ id: string; url: string }> {
    const id = `pl-${++this.seq}-${input.title.replace(/\W+/g, '')}`;
    this.playlists.set(id, []);
    return { id, url: `https://dest.test/${id}` };
  }
  async addItems(_t: string, playlistId: string, refs: ProviderRef[]): Promise<AddItemResult[]> {
    this.addCalls++;
    if (this.throwOnAdd) throw this.throwOnAdd;
    const list = this.playlists.get(playlistId);
    if (!list)
      throw new ProviderError({
        kind: 'not_found',
        platform: this.platform,
        reason: 'playlistNotFound',
        message: 'gone',
      });
    return refs.map((ref) => {
      const fail = this.failOnce.get(ref.id);
      if (fail) {
        this.failOnce.delete(ref.id);
        return { ref, ok: false as const, error: fail };
      }
      list.push(ref.id);
      if (this.timeoutAfterAccept.delete(ref.id)) {
        return {
          ref,
          ok: false as const,
          error: new ProviderError({ kind: 'timeout', platform: this.platform, message: 'timed out' }),
        };
      }
      return { ref, ok: true as const, destinationItemId: null };
    });
  }
  async listItemIds(_t: string, playlistId: string): Promise<Set<string>> {
    const list = this.playlists.get(playlistId);
    if (!list) throw new ProviderError({ kind: 'not_found', platform: this.platform, message: 'gone' });
    return new Set(list);
  }
}
