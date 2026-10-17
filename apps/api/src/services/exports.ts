import { randomUUID } from 'node:crypto';
import {
  assertExecutable,
  buildPlan,
  decide,
  DomainError,
  findDuplicateGroups,
  itemsToAdd,
  matchEpisode,
  postRunStatus,
  preRunStatus,
  ProviderError,
  summarize,
  type ExportItemError,
  type MatchResult,
  type PlanItem,
  type Platform,
  type ProviderRef,
  type ReviewDecision,
} from '@tangent/core';
import { episodeToCandidate, type EpisodeRow, type ExportJobRow, type Repos } from '@tangent/db';
import {
  YT_COST,
  type AddItemResult,
  type CatalogProvider,
  type Logger,
  type PlaylistDestination,
} from '@tangent/providers';
import type { Config } from '../config.js';
import type { JobQueue } from '../jobs/queue.js';
import type { ConnectionService } from './connections.js';
import { exportDto } from './dto.js';
import type { ProviderRegistry } from './registry.js';

const MATCH_CONCURRENCY = 3;
/** Persist progress after each batch so a crash loses at most one batch of state. */
const PERSIST_BATCH = 10;

function errorOf(err: unknown): ExportItemError {
  if (err instanceof ProviderError)
    return {
      kind: err.kind,
      message: err.message,
      retryable: err.retryable || err.kind === 'quota_exceeded',
    };
  if (err instanceof DomainError) return { kind: err.code, message: err.message, retryable: false };
  return { kind: 'internal', message: 'Unexpected error', retryable: true };
}

/** Errors that stop the whole run (no point trying further items). */
function isFatal(err: ProviderError): boolean {
  return (
    [
      'auth_expired',
      'auth_revoked',
      'not_allowlisted',
      'forbidden',
      'quota_exceeded',
      'not_configured',
      'unsupported',
    ].includes(err.kind) ||
    (err.kind === 'not_found' && err.reason === 'playlistNotFound')
  );
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try {
        out[i] = await fn(items[i]!);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (failure) throw failure;
  return out;
}

export class ExportService {
  constructor(
    private readonly config: Config,
    private readonly repos: Repos,
    private readonly registry: ProviderRegistry,
    private readonly connections: ConnectionService,
    private readonly queue: JobQueue,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
  ) {}

  // ======================================================================= API-facing

  async create(
    userId: string,
    input: { collectionId: string; destination: Platform; idempotencyKey: string; playlistTitle?: string },
  ) {
    const existing = await this.repos.exports.findByIdempotencyKey(userId, input.idempotencyKey);
    if (existing) return { job: await this.view(existing), created: false };

    this.registry.destination(input.destination); // throws for Apple / disabled platforms
    const collection = await this.repos.collections.get(input.collectionId, userId);
    if (!collection) throw new DomainError('not_found', 'Collection not found');
    const items = await this.repos.collections.items(collection.id);
    if (items.length === 0)
      throw new DomainError('validation', 'This collection is empty. Add episodes before exporting.');

    const { job, created } = await this.repos.exports.create({
      userId,
      collectionId: collection.id,
      destination: input.destination,
      status: 'planning',
      idempotencyKey: input.idempotencyKey,
      playlistTitle: (input.playlistTitle?.trim() || collection.name).slice(0, 150),
      items: [],
    });
    if (created) this.queue.enqueue(`plan:${job.id}`, () => this.plan(job.id));
    return { job: await this.view(job), created };
  }

  async get(userId: string, jobId: string) {
    return this.view(await this.owned(userId, jobId));
  }

  async decide(
    userId: string,
    jobId: string,
    decisions: Array<{ itemId: string; decision: ReviewDecision | null }>,
  ) {
    const job = await this.owned(userId, jobId);
    if (job.status !== 'needs_review' && job.status !== 'ready') {
      throw new DomainError('invalid_state', `Matches can't be changed while the export is ${job.status}`);
    }
    const items = await this.repos.exports.items(job.id);
    const byId = new Map(items.map((i) => [i.itemId, i]));
    for (const d of decisions) {
      const item = byId.get(d.itemId);
      if (!item) throw new DomainError('not_found', 'Item not found in this export', { itemId: d.itemId });
      if (d.decision === 'accept' && !item.match.candidate)
        throw new DomainError('validation', 'There is no candidate to accept for this item', {
          itemId: d.itemId,
        });
      const updated = decide(item, d.decision);
      byId.set(item.itemId, updated);
      await this.repos.exports.saveItem(job.id, updated);
    }
    const all = [...byId.values()];
    const next = preRunStatus(all);
    const moved = await this.repos.exports.transition(job.id, ['needs_review', 'ready'], next);
    if (!moved) throw new DomainError('conflict', 'The export changed while saving. Refresh and try again.');
    return this.view(moved);
  }

  /** Start (or resume) adding to the destination. Refuses up front if YouTube quota can't cover it. */
  async execute(userId: string, jobId: string, opts: { retry?: boolean } = {}) {
    const job = await this.owned(userId, jobId);
    const items = await this.repos.exports.items(job.id);
    const from = opts.retry ? (['partial', 'failed'] as const) : (['ready'] as const);
    if (!from.includes(job.status as never)) {
      throw new DomainError(
        'invalid_state',
        opts.retry
          ? 'Only partial or failed exports can be retried'
          : `This export is ${job.status} and can't be started`,
      );
    }
    // A failed plan has no items: retrying means planning again.
    if (opts.retry && job.status === 'failed' && items.length === 0) {
      const moved = await this.repos.exports.transition(job.id, ['failed'], 'planning', { error: null });
      if (!moved) throw new DomainError('conflict', 'The export changed. Refresh and try again.');
      this.queue.enqueue(`plan:${job.id}`, () => this.plan(job.id));
      return this.view(moved);
    }

    const retryItems = opts.retry
      ? items.map((i) => (i.state === 'failed' ? { ...i, state: 'pending' as const, lastError: null } : i))
      : items;
    assertExecutable(job.status, retryItems);
    await this.connections.getAccessToken(userId, job.destination); // fail fast if not connected
    await this.assertQuotaFor(job, retryItems);

    const moved = await this.repos.exports.transition(job.id, [...from], 'running', {
      startedAt: this.now(),
      finishedAt: null,
      error: null,
    });
    if (!moved) throw new DomainError('conflict', 'This export is already running');
    if (opts.retry) {
      for (const item of items)
        if (item.state === 'failed')
          await this.repos.exports.saveItem(job.id, { ...item, state: 'pending', lastError: null });
    }
    this.queue.enqueue(`run:${job.id}`, () => this.run(job.id));
    return this.view(moved);
  }

  async cancel(userId: string, jobId: string) {
    const job = await this.owned(userId, jobId);
    const moved = await this.repos.exports.transition(
      job.id,
      ['planning', 'needs_review', 'ready', 'partial', 'failed'],
      'cancelled',
      { finishedAt: this.now() },
    );
    if (!moved) throw new DomainError('invalid_state', `An export that is ${job.status} can't be cancelled`);
    return this.view(moved);
  }

  /** Re-enqueue work interrupted by a restart. Running exports reconcile before adding, so nothing is added twice. */
  async resumeInterrupted(): Promise<number> {
    const jobs = await this.repos.exports.listByStatus(['planning', 'running']);
    for (const j of jobs) {
      if (j.status === 'planning') this.queue.enqueue(`plan:${j.id}`, () => this.plan(j.id));
      else this.queue.enqueue(`run:${j.id}`, () => this.run(j.id));
    }
    return jobs.length;
  }

  // ======================================================================= internals

  private async owned(userId: string, jobId: string): Promise<ExportJobRow> {
    const job = await this.repos.exports.get(jobId, userId);
    if (!job) throw new DomainError('not_found', 'Export not found');
    return job;
  }

  private async view(job: ExportJobRow) {
    const items = await this.repos.exports.items(job.id);
    const episodes = await this.repos.episodes.getMany(items.map((i) => i.episodeId));
    return exportDto(job, items, episodes, summarize(items));
  }

  private async assertQuotaFor(job: ExportJobRow, items: PlanItem[]): Promise<void> {
    if (job.destination !== 'youtube' || !this.registry.youtubeBudget) return;
    const n = itemsToAdd(items).length;
    // +1 list call per page for reconciliation on retries, rounded up generously.
    const required =
      (job.playlistId ? 0 : YT_COST.playlistInsert) +
      n * YT_COST.itemInsert +
      (job.playlistId ? Math.ceil(n / 50) + 1 : 0);
    const remaining = await this.registry.youtubeBudget.remaining();
    if (remaining < required) {
      throw new DomainError(
        'quota_insufficient',
        `Adding ${n} videos needs ${required} YouTube quota units but only ${remaining} are left today. It resets at midnight Pacific time.`,
        {
          required,
          remaining,
        },
      );
    }
  }

  /** Match every collection item onto the destination, then build the plan. */
  async plan(jobId: string): Promise<void> {
    const job = await this.repos.exports.getById(jobId);
    if (!job || job.status !== 'planning') return;
    const log = this.logger.child?.({ jobId, destination: job.destination }) ?? this.logger;

    try {
      if (!job.collectionId) throw new DomainError('not_found', 'The collection was deleted');
      const rows = await this.repos.collections.items(job.collectionId);
      if (rows.length === 0) throw new DomainError('validation', 'The collection is empty');
      const catalog = this.registry.catalog(job.destination);
      const maxAge = this.config.MATCH_CACHE_DAYS * 86_400_000;

      // YouTube matching costs ~101 units per uncached episode; check before spending any.
      if (job.destination === 'youtube' && this.registry.youtubeBudget) {
        let uncached = 0;
        for (const { episode } of rows) {
          if (
            episode.sourcePlatform !== 'youtube' &&
            !(await this.repos.matches.get(episode.id, 'youtube', this.now(), maxAge))
          )
            uncached++;
        }
        const required = uncached * (YT_COST.search + YT_COST.videos);
        const remaining = await this.registry.youtubeBudget.remaining();
        if (required > remaining) {
          throw new ProviderError({
            kind: 'quota_exceeded',
            platform: 'youtube',
            reason: 'localBudget',
            message: `Finding ${uncached} episodes on YouTube needs ${required} quota units but only ${remaining} are left today. It resets at midnight Pacific time.`,
          });
        }
      }

      const matches = await mapLimit(rows, MATCH_CONCURRENCY, async ({ episode }) =>
        this.matchOne(episode, job.destination, catalog, maxAge),
      );
      const groups = findDuplicateGroups(
        rows.map(({ item, episode }) => ({ id: item.id, candidate: episodeToCandidate(episode) })),
      );
      const plan = buildPlan(
        rows.map(({ item, episode }, i) => ({
          itemId: randomUUID(),
          episodeId: episode.id,
          position: i,
          match: matches[i]!,
          duplicateGroup: groups.get(item.id) ?? null,
        })),
      );
      await this.repos.exports.replaceItems(job.id, plan);
      const moved = await this.repos.exports.transition(job.id, ['planning'], preRunStatus(plan));
      log.info({ status: moved?.status ?? 'cancelled', summary: summarize(plan) }, 'export planned');
    } catch (err) {
      log.warn({ err: (err as Error).message, kind: (err as ProviderError).kind }, 'export planning failed');
      await this.repos.exports.transition(job.id, ['planning'], 'failed', {
        error: errorOf(err),
        finishedAt: this.now(),
      });
    }
  }

  private async matchOne(
    episode: EpisodeRow,
    destination: Platform,
    catalog: CatalogProvider,
    maxAge: number,
  ): Promise<MatchResult> {
    const source = episodeToCandidate(episode);
    if (episode.sourcePlatform === destination) return matchEpisode(source, destination, []);
    const cached = await this.repos.matches.get(episode.id, destination, this.now(), maxAge);
    if (cached) return cached;
    const candidates = await catalog.findCandidates(source);
    const result = matchEpisode(source, destination, candidates);
    await this.repos.matches.put(episode.id, destination, result);
    return result;
  }

  /** Add approved items to the destination playlist. Never throws; all outcomes are persisted. */
  async run(jobId: string): Promise<void> {
    const job = await this.repos.exports.getById(jobId);
    if (!job || job.status !== 'running') return;
    const log = this.logger.child?.({ jobId, destination: job.destination }) ?? this.logger;
    let items = await this.repos.exports.items(job.id);
    const save = async (item: PlanItem) => {
      items = items.map((i) => (i.itemId === item.itemId ? item : i));
      await this.repos.exports.saveItem(job.id, item);
    };
    const failRemaining = async (err: unknown) => {
      const e = errorOf(err);
      for (const i of itemsToAdd(items))
        if (i.state !== 'added') await save({ ...i, state: 'failed', lastError: e });
      await this.repos.exports.setError(job.id, e);
    };

    try {
      const destination = this.registry.destination(job.destination);
      let token = await this.connections.getAccessToken(job.userId, job.destination);
      const withAuth = async <T>(fn: (t: string) => Promise<T>): Promise<T> => {
        try {
          return await fn(token);
        } catch (err) {
          if (err instanceof ProviderError && err.kind === 'auth_expired') {
            token = await this.connections.getAccessToken(job.userId, job.destination, {
              forceRefresh: true,
            });
            return fn(token);
          }
          throw err;
        }
      };

      let playlistId = job.playlistId;
      if (playlistId) {
        // Resuming or retrying: skip anything that already landed (a timeout may hide a success).
        const reconciled = await this.reconcile(destination, playlistId, items, withAuth);
        if (reconciled === 'playlist_missing') {
          log.warn({ playlistId }, 'playlist was deleted; creating a new one');
          playlistId = null;
          for (const i of items)
            if (i.state === 'added') await save({ ...i, state: 'pending', destinationItemId: null });
        } else {
          for (const i of reconciled) await save(i);
        }
      }
      if (!playlistId) {
        const collection = job.collectionId
          ? await this.repos.collections.get(job.collectionId, job.userId)
          : null;
        const created = await withAuth((t) =>
          destination.createPlaylist(t, {
            title: job.playlistTitle ?? collection?.name ?? 'Tangent collection',
            description: collection?.description
              ? `${collection.description} · Made with Tangent`
              : 'Made with Tangent',
            privacy: 'private',
          }),
        );
        playlistId = created.id;
        await this.repos.exports.setPlaylist(job.id, created.id, created.url); // save before adding anything
      }

      const queue = itemsToAdd(items);
      for (let start = 0; start < queue.length; start += PERSIST_BATCH) {
        const batch: Array<{ item: PlanItem; ref: ProviderRef }> = [];
        for (const item of queue.slice(start, start + PERSIST_BATCH)) {
          const ref = item.match.candidate?.ref;
          if (!ref || ref.platform !== job.destination) {
            await save({
              ...item,
              state: 'failed',
              attempts: item.attempts + 1,
              lastError: {
                kind: 'no_candidate',
                message: 'No matching item on the destination',
                retryable: false,
              },
            });
            continue;
          }
          batch.push({ item, ref });
        }
        if (batch.length === 0) continue;
        const results = await withAuth((t) =>
          destination.addItems(
            t,
            playlistId!,
            batch.map((b) => b.ref),
          ),
        );
        for (let k = 0; k < batch.length; k++) {
          const { item } = batch[k]!;
          const r = results[k];
          if (r?.ok)
            await save({
              ...item,
              state: 'added',
              attempts: item.attempts + 1,
              lastError: null,
              destinationItemId: r.destinationItemId,
            });
          else
            await save({
              ...item,
              state: 'failed',
              attempts: item.attempts + 1,
              lastError: r
                ? errorOf(r.error)
                : { kind: 'internal', message: 'No result returned', retryable: true },
            });
        }
        // Quota ran out mid-batch: stop here instead of failing every remaining call one by one.
        const quotaHit = results.find(
          (r): r is Extract<AddItemResult, { ok: false }> => !r.ok && r.error.kind === 'quota_exceeded',
        );
        if (quotaHit) {
          await failRemaining(quotaHit.error);
          break;
        }
      }
    } catch (err) {
      // Whole-run failures (auth, allowlist, quota, missing playlist, outages): every item not yet
      // added is marked failed with the reason, so the user sees exactly what happened and can retry.
      log.warn(
        {
          err: (err as Error).message,
          kind: (err as ProviderError).kind,
          fatal: err instanceof ProviderError && isFatal(err),
        },
        'export run stopped',
      );
      await failRemaining(err);
    }

    const status = postRunStatus(items);
    await this.repos.exports.transition(job.id, ['running'], status, { finishedAt: this.now() });
    log.info({ status, summary: summarize(items) }, 'export finished');
  }

  private async reconcile(
    destination: PlaylistDestination,
    playlistId: string,
    items: PlanItem[],
    withAuth: <T>(fn: (t: string) => Promise<T>) => Promise<T>,
  ): Promise<PlanItem[] | 'playlist_missing'> {
    if (!destination.listItemIds) return [];
    let present: Set<string>;
    try {
      present = await withAuth((t) => destination.listItemIds!(t, playlistId));
    } catch (err) {
      if (err instanceof ProviderError && err.kind === 'not_found') return 'playlist_missing';
      throw err;
    }
    return itemsToAdd(items)
      .filter((i) => i.match.candidate && present.has(i.match.candidate.ref.id))
      .map((i) => ({ ...i, state: 'added' as const, lastError: null }));
  }
}
