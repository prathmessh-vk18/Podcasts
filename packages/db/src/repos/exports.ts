import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import type { ExportItemError, ExportJobStatus, PlanItem, Platform } from '@tangent/core';
import type { Db } from '../client.js';
import { exportItems, exportJobs, quotaUsage } from '../schema.js';
import { reviveMatch } from '../serialize.js';

export type ExportJobRow = typeof exportJobs.$inferSelect;
export type ExportItemRow = typeof exportItems.$inferSelect;

export function itemRowToPlanItem(r: ExportItemRow): PlanItem {
  return {
    itemId: r.id,
    episodeId: r.episodeId,
    position: r.position,
    match: reviveMatch(r.match),
    kind: r.kind,
    decision: r.decision,
    duplicateOf: r.duplicateOf,
    state: r.state,
    skipReason: r.skipReason,
    attempts: r.attempts,
    lastError: r.lastError,
    destinationItemId: r.destinationItemId,
  };
}

export function exportsRepo(db: Db) {
  return {
    async findByIdempotencyKey(userId: string, key: string): Promise<ExportJobRow | null> {
      const [row] = await db
        .select()
        .from(exportJobs)
        .where(and(eq(exportJobs.userId, userId), eq(exportJobs.idempotencyKey, key)))
        .limit(1);
      return row ?? null;
    },

    /**
     * Create a job and its items in one transaction. If another request with the same
     * idempotency key won the race, return that job instead (unique index decides).
     */
    async create(input: {
      userId: string;
      collectionId: string;
      destination: Platform;
      status: ExportJobStatus;
      idempotencyKey: string;
      playlistTitle: string;
      // Items use client-generated ids so duplicateOf can reference siblings.
      items: Array<Omit<PlanItem, 'match'> & { match: PlanItem['match'] }>;
    }): Promise<{ job: ExportJobRow; created: boolean }> {
      return db.transaction(async (tx) => {
        const inserted = await tx
          .insert(exportJobs)
          .values({
            userId: input.userId,
            collectionId: input.collectionId,
            destination: input.destination,
            status: input.status,
            idempotencyKey: input.idempotencyKey,
            playlistTitle: input.playlistTitle,
          })
          .onConflictDoNothing({ target: [exportJobs.userId, exportJobs.idempotencyKey] })
          .returning();
        const job = inserted[0];
        if (!job) {
          const [existing] = await tx
            .select()
            .from(exportJobs)
            .where(
              and(eq(exportJobs.userId, input.userId), eq(exportJobs.idempotencyKey, input.idempotencyKey)),
            )
            .limit(1);
          return { job: existing!, created: false };
        }
        if (input.items.length) {
          await tx.insert(exportItems).values(
            input.items.map((i) => ({
              id: i.itemId,
              jobId: job.id,
              episodeId: i.episodeId,
              position: i.position,
              kind: i.kind,
              decision: i.decision,
              duplicateOf: i.duplicateOf,
              state: i.state,
              skipReason: i.skipReason,
              match: i.match,
              attempts: i.attempts,
              lastError: i.lastError,
              destinationItemId: i.destinationItemId,
            })),
          );
        }
        return { job, created: true };
      });
    },

    async get(id: string, userId: string): Promise<ExportJobRow | null> {
      const [row] = await db
        .select()
        .from(exportJobs)
        .where(and(eq(exportJobs.id, id), eq(exportJobs.userId, userId)))
        .limit(1);
      return row ?? null;
    },

    async getById(id: string): Promise<ExportJobRow | null> {
      const [row] = await db.select().from(exportJobs).where(eq(exportJobs.id, id)).limit(1);
      return row ?? null;
    },

    async items(jobId: string): Promise<PlanItem[]> {
      const rows = await db
        .select()
        .from(exportItems)
        .where(eq(exportItems.jobId, jobId))
        .orderBy(asc(exportItems.position));
      return rows.map(itemRowToPlanItem);
    },

    /** Replace all items of a job (planning writes them once matching completes). */
    async replaceItems(jobId: string, items: PlanItem[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.delete(exportItems).where(eq(exportItems.jobId, jobId));
        if (items.length === 0) return;
        await tx.insert(exportItems).values(
          items.map((i) => ({
            id: i.itemId,
            jobId,
            episodeId: i.episodeId,
            position: i.position,
            kind: i.kind,
            decision: i.decision,
            duplicateOf: i.duplicateOf,
            state: i.state,
            skipReason: i.skipReason,
            match: i.match,
            attempts: i.attempts,
            lastError: i.lastError,
            destinationItemId: i.destinationItemId,
          })),
        );
      });
    },

    async saveItem(jobId: string, item: PlanItem): Promise<void> {
      await db
        .update(exportItems)
        .set({
          decision: item.decision,
          state: item.state,
          skipReason: item.skipReason,
          attempts: item.attempts,
          lastError: item.lastError,
          destinationItemId: item.destinationItemId,
          updatedAt: sql`now()`,
        })
        .where(and(eq(exportItems.id, item.itemId), eq(exportItems.jobId, jobId)));
    },

    /**
     * Compare-and-set status change. Only succeeds if the job is currently in one of `from`.
     * This is what stops two concurrent "execute" calls from running the same export twice.
     */
    async transition(
      id: string,
      from: ExportJobStatus[],
      to: ExportJobStatus,
      patch: Partial<
        Pick<
          ExportJobRow,
          'playlistId' | 'playlistUrl' | 'playlistTitle' | 'error' | 'startedAt' | 'finishedAt'
        >
      > = {},
    ): Promise<ExportJobRow | null> {
      const [row] = await db
        .update(exportJobs)
        .set({ ...patch, status: to, version: sql`${exportJobs.version} + 1`, updatedAt: sql`now()` })
        .where(and(eq(exportJobs.id, id), inArray(exportJobs.status, from)))
        .returning();
      return row ?? null;
    },

    async setPlaylist(id: string, playlistId: string, playlistUrl: string): Promise<void> {
      await db
        .update(exportJobs)
        .set({ playlistId, playlistUrl, updatedAt: sql`now()` })
        .where(eq(exportJobs.id, id));
    },

    async setError(id: string, error: ExportItemError | null): Promise<void> {
      await db
        .update(exportJobs)
        .set({ error, updatedAt: sql`now()` })
        .where(eq(exportJobs.id, id));
    },

    /** Jobs left "running" by a crash or deploy; resumed on boot. */
    async listRunning(): Promise<ExportJobRow[]> {
      return db.select().from(exportJobs).where(eq(exportJobs.status, 'running'));
    },

    /**
     * Take the worker lease if nobody holds a live one. Returns false if another worker owns
     * the job right now, in which case the caller must not touch it.
     */
    async claim(id: string, now: Date, leaseMs: number): Promise<boolean> {
      const rows = await db
        .update(exportJobs)
        .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
        .where(and(eq(exportJobs.id, id), or(isNull(exportJobs.leaseUntil), lt(exportJobs.leaseUntil, now))))
        .returning({ id: exportJobs.id });
      return rows.length > 0;
    },

    /** Extend a lease we hold, while a long job keeps making progress. */
    async extendLease(id: string, now: Date, leaseMs: number): Promise<void> {
      await db
        .update(exportJobs)
        .set({ leaseUntil: new Date(now.getTime() + leaseMs) })
        .where(eq(exportJobs.id, id));
    },

    async releaseLease(id: string): Promise<void> {
      await db.update(exportJobs).set({ leaseUntil: null }).where(eq(exportJobs.id, id));
    },

    /** Work left behind by a worker that stopped (expired or missing lease). */
    async listResumable(now: Date, limit = 20): Promise<ExportJobRow[]> {
      return db
        .select()
        .from(exportJobs)
        .where(
          and(
            inArray(exportJobs.status, ['planning', 'running']),
            or(isNull(exportJobs.leaseUntil), lt(exportJobs.leaseUntil, now)),
          ),
        )
        .limit(limit);
    },

    async listByStatus(statuses: ExportJobStatus[]): Promise<ExportJobRow[]> {
      return db.select().from(exportJobs).where(inArray(exportJobs.status, statuses));
    },
  };
}

/** Database-backed daily quota, shared by every API instance. Matches the providers' QuotaStore. */
export class DbQuotaStore {
  constructor(private readonly db: Db) {}

  async tryConsume(key: string, day: string, units: number, limit: number): Promise<boolean> {
    if (units > limit) return false;
    // Single atomic statement: the row only changes if the new total stays within the limit.
    const rows = await this.db
      .insert(quotaUsage)
      .values({ key, day, used: units })
      .onConflictDoUpdate({
        target: [quotaUsage.key, quotaUsage.day],
        set: { used: sql`${quotaUsage.used} + ${units}` },
        setWhere: sql`${quotaUsage.used} + ${units} <= ${limit}`,
      })
      .returning({ used: quotaUsage.used });
    return rows.length > 0;
  }

  async used(key: string, day: string): Promise<number> {
    const [row] = await this.db
      .select({ used: quotaUsage.used })
      .from(quotaUsage)
      .where(and(eq(quotaUsage.key, key), eq(quotaUsage.day, day)))
      .limit(1);
    return row?.used ?? 0;
  }
}
