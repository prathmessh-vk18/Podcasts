import { DomainError, ProviderError, type EpisodeCandidate, type Platform } from '@tangent/core';
import type { EpisodeRow, Repos } from '@tangent/db';
import type { Logger } from '@tangent/providers';
import { candidateDto, collectionDto, episodeDto } from './dto.js';
import type { ProviderRegistry } from './registry.js';

const EPISODE_REFRESH_MS = 24 * 3600_000;
const SEARCH_TIMEOUT_MS = 8_000;

export type SearchOutcome =
  { items: ReturnType<typeof candidateDto>[] } | { items: []; error: { code: string; message: string } };

function withTimeout<T>(p: Promise<T>, ms: number, platform: Platform): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new ProviderError({ kind: 'timeout', platform, message: `${platform} search timed out` })),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class LibraryService {
  constructor(
    private readonly repos: Repos,
    private readonly registry: ProviderRegistry,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Search several platforms at once. One platform failing never fails the whole search;
   * its error is reported next to the others' results (PRD: partial failure is visible, not silent).
   */
  async search(query: string, platforms: Platform[], limit: number): Promise<Record<string, SearchOutcome>> {
    const entries = await Promise.all(
      platforms.map(async (platform): Promise<[Platform, SearchOutcome]> => {
        const provider = this.registry.catalogs[platform];
        if (!provider)
          return [
            platform,
            { items: [], error: { code: 'provider_not_configured', message: `${platform} is not enabled` } },
          ];
        try {
          const items = await withTimeout(provider.search(query, { limit }), SEARCH_TIMEOUT_MS, platform);
          return [platform, { items: items.slice(0, limit).map(candidateDto) }];
        } catch (err) {
          const kind = err instanceof ProviderError ? err.kind : 'internal';
          this.logger.warn({ platform, kind }, 'search failed for one platform');
          const message =
            kind === 'quota_exceeded'
              ? 'Daily search limit reached for this platform'
              : kind === 'timeout'
                ? 'This platform took too long to respond'
                : 'This platform is unavailable right now';
          return [platform, { items: [], error: { code: kind, message } }];
        }
      }),
    );
    return Object.fromEntries(entries);
  }

  /**
   * Turn a provider reference into a saved episode. The server fetches metadata itself;
   * it never trusts episode details sent by the client.
   */
  async resolveEpisode(
    platform: Platform,
    sourceId: string,
    hint: { showId?: string | null; title?: string | null } = {},
  ): Promise<EpisodeRow> {
    const cached = await this.repos.episodes.getBySource(platform, sourceId);
    if (cached && this.now().getTime() - cached.fetchedAt.getTime() < EPISODE_REFRESH_MS) return cached;
    let fresh: EpisodeCandidate | null;
    try {
      // A saved episode already knows its show, which is all Apple needs for a refresh.
      fresh = await this.registry.catalog(platform).getEpisode(sourceId, {
        showId: hint.showId ?? cached?.showSourceId ?? null,
        title: hint.title ?? cached?.title ?? null,
      });
    } catch (err) {
      // Provider down: an already-saved episode is still usable; a new one can't be verified.
      if (cached && err instanceof ProviderError && err.retryable) return cached;
      throw err;
    }
    if (!fresh) {
      if (cached) return cached; // removed upstream; keep what the user saved (PRD LIB-02)
      throw new DomainError('not_found', 'That episode could not be found on the platform', {
        platform,
        sourceId,
      });
    }
    return this.repos.episodes.upsert(fresh);
  }

  async getEpisode(id: string) {
    const row = await this.repos.episodes.get(id);
    if (!row) throw new DomainError('not_found', 'Episode not found');
    return episodeDto(row);
  }

  // ------------------------------------------------------------- collections
  /** Map of "platform:sourceId" → collection ids, so the UI can mark saved episodes anywhere. */
  async saved(userId: string) {
    const rows = await this.repos.collections.savedRefs(userId);
    const map: Record<string, string[]> = {};
    for (const r of rows) (map[`${r.platform}:${r.sourceId}`] ??= []).push(r.collectionId);
    return { saved: map };
  }

  async listCollections(userId: string) {
    const rows = await this.repos.collections.list(userId);
    const previews = await this.repos.collections.previews(rows.map((r) => r.id));
    return rows.map((r) => ({ ...collectionDto(r), preview: previews.get(r.id) ?? [] }));
  }

  private async owned(userId: string, id: string) {
    const c = await this.repos.collections.get(id, userId);
    if (!c) throw new DomainError('not_found', 'Collection not found');
    return c;
  }

  async getCollection(userId: string, id: string) {
    const c = await this.owned(userId, id);
    const items = await this.repos.collections.items(c.id);
    return {
      ...collectionDto({ ...c, itemCount: items.length }),
      items: items.map(({ item, episode }) => ({
        id: item.id,
        position: item.position,
        addedAt: item.addedAt.toISOString(),
        episode: episodeDto(episode),
      })),
    };
  }

  async createCollection(userId: string, input: { name: string; description?: string }) {
    return collectionDto({ ...(await this.repos.collections.create({ userId, ...input })), itemCount: 0 });
  }

  async updateCollection(
    userId: string,
    id: string,
    patch: { name?: string; description?: string; privacy?: 'private' | 'link' },
  ) {
    const row = await this.repos.collections.update(id, userId, patch);
    if (!row) throw new DomainError('not_found', 'Collection not found');
    return collectionDto(row);
  }

  async deleteCollection(userId: string, id: string): Promise<void> {
    if (!(await this.repos.collections.softDelete(id, userId, this.now())))
      throw new DomainError('not_found', 'Collection not found');
  }

  async restoreCollection(userId: string, id: string) {
    const row = await this.repos.collections.restore(id, userId);
    if (!row) throw new DomainError('not_found', 'Nothing to restore');
    return collectionDto(row);
  }

  async addToCollection(
    userId: string,
    collectionId: string,
    ref: { platform: Platform; sourceId: string; showId?: string; title?: string },
  ) {
    const c = await this.owned(userId, collectionId);
    const episode = await this.resolveEpisode(ref.platform, ref.sourceId, {
      showId: ref.showId,
      title: ref.title,
    });
    const { item, added } = await this.repos.collections.addItem(c.id, episode.id);
    return {
      added,
      item: {
        id: item.id,
        position: item.position,
        addedAt: item.addedAt.toISOString(),
        episode: episodeDto(episode),
      },
    };
  }

  async removeFromCollection(userId: string, collectionId: string, itemId: string): Promise<void> {
    const c = await this.owned(userId, collectionId);
    if (!(await this.repos.collections.removeItem(c.id, itemId)))
      throw new DomainError('not_found', 'Item not found in this collection');
  }

  async reorder(userId: string, collectionId: string, itemIds: string[]): Promise<void> {
    const c = await this.owned(userId, collectionId);
    await this.repos.collections.reorder(c.id, itemIds);
  }

  /** PRD fallback for platforms without a playlist API: an ordered list of source links. Never called a "transfer". */
  async linkList(userId: string, collectionId: string) {
    const c = await this.owned(userId, collectionId);
    const items = await this.repos.collections.items(c.id);
    return {
      collection: { id: c.id, name: c.name },
      kind: 'link_list' as const,
      note: 'These are links to each episode on its source platform. This is not a playlist transfer.',
      items: items.map(({ episode }, i) => ({
        position: i + 1,
        title: episode.title,
        show: episode.showTitle,
        platform: episode.sourcePlatform,
        url: episode.canonicalUrl,
      })),
    };
  }
}
