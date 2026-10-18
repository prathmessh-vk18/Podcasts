import { ProviderError, type EpisodeCandidate } from '@tangent/core';
import { TOPICS, type Repos } from '@tangent/db';
import type { Logger } from '@tangent/providers';
import type { JobRunner } from '../jobs/runner.js';
import { artworkForTopic, episodeDto } from './dto.js';

export interface ShowSource {
  getShowEpisodes(showId: string, limit?: number): Promise<EpisodeCandidate[]>;
}

/** Re-pull a show's episodes after this long. New podcast episodes are rarely more frequent than daily. */
const STALE_MS = 6 * 3600_000;
const EPISODES_PER_SHOW = 25;
/** Budget for a refresh started by a visitor on an empty catalog (fits a serverless invocation). */
const WARMUP_BUDGET_MS = 200_000;
/** Visits trigger a background refresh of stale shows at most this often per instance. */
const KICK_INTERVAL_MS = 10 * 60_000;
/**
 * Apple allows ~20 requests/minute per IP, shared with visitors' searches. Background refresh
 * paces itself to at most ~10/minute so interactive requests never queue behind it.
 */
const DEFAULT_PACING_MS = 6_000;

export interface RefreshReport {
  refreshed: number;
  failed: number;
  remaining: boolean;
}

/**
 * Discover is fed by a curated show list (catalog-seed.ts). A refresh pulls each show's recent
 * episodes from Apple and tags them with the show's topic. It works within a time budget so it
 * fits a serverless invocation, always doing the stalest shows first.
 */
export class DiscoverService {
  private seeded = false;
  private lastKick = 0;

  constructor(
    private readonly repos: Repos,
    private readonly source: ShowSource | null,
    private readonly runner: JobRunner,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly pacingMs = DEFAULT_PACING_MS,
  ) {}

  async refresh(budgetMs: number, maxShows = 50): Promise<RefreshReport> {
    if (!this.source) return { refreshed: 0, failed: 0, remaining: false };
    const source = this.source;
    const deadline = Date.now() + budgetMs;
    if (!this.seeded) {
      await this.repos.discover.seedCatalog();
      this.seeded = true;
    }
    const due = await this.repos.discover.showsDue(this.now(), STALE_MS, maxShows);
    let refreshed = 0;
    let failed = 0;
    for (const [i, show] of due.entries()) {
      if (Date.now() > deadline) break;
      if (i > 0 && this.pacingMs > 0) await new Promise((r) => setTimeout(r, this.pacingMs));
      try {
        const eps = await source.getShowEpisodes(show.sourceShowId, EPISODES_PER_SHOW);
        for (const e of eps) await this.repos.discover.upsertTagged(e, [show.topic]);
        await this.repos.discover.markRefreshed(show.id, this.now(), eps[0]?.artworkUrl ?? null);
        refreshed++;
      } catch (err) {
        failed++;
        const message = err instanceof ProviderError ? `${err.kind}: ${err.message}` : (err as Error).message;
        this.logger.warn({ show: show.title, err: message }, 'catalog refresh failed for one show');
        await this.repos.discover.markFailed(show.id, this.now(), message);
        // Throttled: stop now rather than burn through every show with the same error.
        if (err instanceof ProviderError && err.kind === 'rate_limited') break;
      }
    }
    const remaining = (await this.repos.discover.showsDue(this.now(), STALE_MS, 1)).length > 0;
    this.logger.info({ refreshed, failed, remaining }, 'catalog refresh');
    return { refreshed, failed, remaining };
  }

  /**
   * Feed pages. On a brand-new database the first visitor triggers a background refresh and
   * gets `warming: true` so the UI can say "loading the catalog" and poll.
   */
  async feed(topic: string | null, cursor: string | null, limit: number) {
    const page = await this.repos.discover.feed({ topic, cursor, limit });
    const warming = !cursor && page.items.length === 0 && this.warmUp(true);
    if (!warming && !cursor) this.warmUp();
    return { items: page.items.map(episodeDto), nextCursor: page.nextCursor, warming };
  }

  /**
   * Stale-while-revalidate: refresh stale shows in the background so visitors never wait.
   * `force` skips the per-instance throttle (used when there's nothing to show at all).
   * Returns true if a refresh is (now) in flight.
   */
  warmUp(force = false): boolean {
    if (!this.source) return false;
    const now = Date.now();
    if (!force && now - this.lastKick < KICK_INTERVAL_MS) return false;
    this.lastKick = now;
    this.runner.enqueue('catalog:refresh', async () => {
      await this.refresh(WARMUP_BUDGET_MS);
    });
    return true;
  }

  async trending(limit: number) {
    this.warmUp();
    return { items: (await this.repos.discover.trending(limit)).map(episodeDto) };
  }

  async topics() {
    const summary = await this.repos.discover.topicSummary();
    const byId = new Map(summary.map((s) => [s.topic, s]));
    return {
      topics: TOPICS.map((t) => {
        const s = byId.get(t.id);
        return {
          id: t.id,
          name: t.name,
          blurb: t.blurb,
          episodeCount: s?.episodeCount ?? 0,
          shows: (s?.shows ?? []).map((show) => ({
            id: show.sourceShowId,
            platform: show.platform,
            title: show.title,
            artworkUrl: show.artworkUrl ?? artworkForTopic(),
          })),
        };
      }),
    };
  }

  /** True when Discover has nothing to show yet (fresh database). */
  async isEmpty(): Promise<boolean> {
    return (await this.repos.discover.feed({ topic: null, cursor: null, limit: 1 })).items.length === 0;
  }
}
