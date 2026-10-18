import { ProviderError, type Platform } from '@tangent/core';
import { DbQuotaStore, type Db } from '@tangent/db';
import {
  AppleProvider,
  QuotaBudget,
  SpotifyProvider,
  YouTubeProvider,
  type CatalogProvider,
  type Logger,
  type OAuthProvider,
  type PlaylistDestination,
} from '@tangent/providers';
import type { Config } from '../config.js';

export interface PlatformCapabilities {
  platform: Platform;
  /** Search and episode lookup. */
  catalog: boolean;
  /** Account connection (OAuth). */
  connect: boolean;
  /** "playlist" = real export; "links" = link-list fallback only; false = disabled. */
  export: 'playlist' | 'links' | false;
  notes: string[];
}

/**
 * Which providers are enabled on this server, built from config. Missing credentials disable a
 * platform cleanly instead of failing at request time with a confusing error.
 */
export class ProviderRegistry {
  constructor(
    readonly catalogs: Partial<Record<Platform, CatalogProvider>>,
    readonly oauth: Partial<Record<Platform, OAuthProvider>>,
    readonly destinations: Partial<Record<Platform, PlaylistDestination>>,
    /** YouTube's daily budget, exposed for pre-flight checks. */
    readonly youtubeBudget: QuotaBudget | null = null,
  ) {}

  static fromConfig(config: Config, db: Db, logger: Logger, fetchImpl?: typeof fetch): ProviderRegistry {
    const catalogs: Partial<Record<Platform, CatalogProvider>> = {
      apple: new AppleProvider({ country: config.APPLE_COUNTRY, logger, fetch: fetchImpl }),
    };
    const oauth: Partial<Record<Platform, OAuthProvider>> = {};
    const destinations: Partial<Record<Platform, PlaylistDestination>> = {};
    let youtubeBudget: QuotaBudget | null = null;

    if (config.SPOTIFY_CLIENT_ID && config.SPOTIFY_CLIENT_SECRET) {
      const spotify = new SpotifyProvider({
        clientId: config.SPOTIFY_CLIENT_ID,
        clientSecret: config.SPOTIFY_CLIENT_SECRET,
        market: config.SPOTIFY_MARKET,
        logger,
        fetch: fetchImpl,
      });
      catalogs.spotify = spotify;
      oauth.spotify = spotify;
      destinations.spotify = spotify;
    }

    if (config.YOUTUBE_API_KEY) {
      youtubeBudget = new QuotaBudget(new DbQuotaStore(db), 'youtube', config.YOUTUBE_DAILY_QUOTA);
      const youtube = new YouTubeProvider({
        apiKey: config.YOUTUBE_API_KEY,
        clientId: config.GOOGLE_CLIENT_ID,
        clientSecret: config.GOOGLE_CLIENT_SECRET,
        regionCode: config.YOUTUBE_REGION,
        budget: youtubeBudget,
        logger,
        fetch: fetchImpl,
      });
      catalogs.youtube = youtube;
      if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
        oauth.youtube = youtube;
        destinations.youtube = youtube;
      }
    }

    return new ProviderRegistry(catalogs, oauth, destinations, youtubeBudget);
  }

  private missing(platform: Platform, what: string): ProviderError {
    return new ProviderError({
      kind: 'not_configured',
      platform,
      message: `${platform} ${what} is not enabled on this server`,
    });
  }

  /** Where Discover pulls curated shows' episodes from (Apple). */
  showSource(): {
    getShowEpisodes(showId: string, limit?: number): ReturnType<AppleProvider['getShowEpisodes']>;
  } | null {
    const apple = this.catalogs.apple as Partial<AppleProvider> | undefined;
    return apple && typeof apple.getShowEpisodes === 'function' ? (apple as AppleProvider) : null;
  }

  catalog(platform: Platform): CatalogProvider {
    const p = this.catalogs[platform];
    if (!p) throw this.missing(platform, 'search');
    return p;
  }

  oauthFor(platform: Platform): OAuthProvider {
    const p = this.oauth[platform];
    if (!p) throw this.missing(platform, 'account connection');
    return p;
  }

  destination(platform: Platform): PlaylistDestination {
    if (platform === 'apple') {
      throw new ProviderError({
        kind: 'unsupported',
        platform,
        message: 'Apple Podcasts does not let apps create playlists. Use the link list instead.',
      });
    }
    const p = this.destinations[platform];
    if (!p) throw this.missing(platform, 'export');
    return p;
  }

  capabilities(): PlatformCapabilities[] {
    return [
      {
        platform: 'apple',
        catalog: !!this.catalogs.apple,
        connect: false,
        export: 'links',
        notes: ['Apple has no playlist API; exports are a list of links.'],
      },
      {
        platform: 'spotify',
        catalog: !!this.catalogs.spotify,
        connect: !!this.oauth.spotify,
        export: this.destinations.spotify ? 'playlist' : false,
        notes: ['Spotify Development Mode allows up to 5 allowlisted users.'],
      },
      {
        platform: 'youtube',
        catalog: !!this.catalogs.youtube,
        connect: !!this.oauth.youtube,
        export: this.destinations.youtube ? 'playlist' : false,
        notes: ['YouTube has a shared daily quota; large exports may need to wait for the reset.'],
      },
    ];
  }
}
