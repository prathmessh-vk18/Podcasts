import type { EpisodeCandidate, Platform, ProviderError, ProviderRef } from '@tangent/core';
import type { TokenSet } from './oauth.js';

/**
 * Narrows a lookup. Apple can't fetch an episode by its own id (only via its show), so callers
 * pass what they know from search results. Providers still verify everything against their own data.
 */
export interface EpisodeHint {
  showId?: string | null;
  title?: string | null;
}

/** Read side: find episodes. Implemented by Apple, Spotify and YouTube. */
export interface CatalogProvider {
  readonly platform: Platform;
  /** Free-text search for the discovery UI. */
  search(query: string, opts?: { limit?: number }): Promise<EpisodeCandidate[]>;
  /** Fetch one episode by the provider's id. Returns null when it doesn't exist or isn't available. */
  getEpisode(id: string, hint?: EpisodeHint): Promise<EpisodeCandidate | null>;
  /** Candidates for matching `source` onto this platform. Never throws for "nothing found": returns []. */
  findCandidates(source: EpisodeCandidate, opts?: { limit?: number }): Promise<EpisodeCandidate[]>;
}

export interface AccountInfo {
  externalId: string;
  displayName: string | null;
}

/** Account connection via OAuth 2.0 Authorization Code + PKCE. */
export interface OAuthProvider {
  readonly platform: Platform;
  readonly scopes: readonly string[];
  buildAuthorizeUrl(input: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(input: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  /** Best effort. Some providers (Spotify) have no revoke endpoint; then this is a no-op. */
  revoke(token: string): Promise<void>;
  getAccount(accessToken: string): Promise<AccountInfo>;
}

export interface PlaylistInput {
  title: string;
  description: string;
  privacy: 'private' | 'public';
}

export type AddItemResult =
  | { ref: ProviderRef; ok: true; destinationItemId: string | null }
  | { ref: ProviderRef; ok: false; error: ProviderError };

export interface DestinationLimits {
  maxItemsPerRequest: number;
  maxTitleLength: number;
  maxDescriptionLength: number;
  /** Units charged per operation, for providers with a daily budget. */
  quota?: { createPlaylist: number; addItem: number };
}

/**
 * Write side: create playlists and add episodes.
 * - Whole-operation failures (auth, quota at the start, missing playlist) throw.
 * - Per-item failures are returned in the result array, one entry per input, in order.
 */
export interface PlaylistDestination {
  readonly platform: Platform;
  readonly limits: DestinationLimits;
  createPlaylist(accessToken: string, input: PlaylistInput): Promise<{ id: string; url: string }>;
  addItems(accessToken: string, playlistId: string, refs: ProviderRef[]): Promise<AddItemResult[]>;
  /**
   * Ids already in the playlist. Used before a retry: if a previous attempt timed out after the
   * provider accepted it, we skip that item instead of adding it twice.
   */
  listItemIds?(accessToken: string, playlistId: string): Promise<Set<string>>;
}
