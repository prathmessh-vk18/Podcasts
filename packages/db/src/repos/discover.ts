import { and, asc, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { EpisodeCandidate } from '@tangent/core';
import type { Db } from '../client.js';
import { CURATED_SHOWS } from '../catalog-seed.js';
import { catalogShows, episodes } from '../schema.js';
import type { EpisodeRow } from './catalog.js';

export type CatalogShowRow = typeof catalogShows.$inferSelect;

/** Opaque cursor for keyset pagination: newest first, ties broken by id. */
export function encodeCursor(row: { publishedAt: Date | null; id: string }): string {
  return Buffer.from(`${row.publishedAt?.toISOString() ?? ''}|${row.id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { publishedAt: Date | null; id: string } | null {
  try {
    const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const publishedAt = date ? new Date(date) : null;
    if (publishedAt && Number.isNaN(publishedAt.getTime())) return null;
    return { publishedAt, id };
  } catch {
    return null;
  }
}

export function discoverRepo(db: Db) {
  return {
    /** Make sure every curated show exists. Safe to run repeatedly; doesn't touch refresh state. */
    async seedCatalog(): Promise<number> {
      if (CURATED_SHOWS.length === 0) return 0;
      const rows = await db
        .insert(catalogShows)
        .values(CURATED_SHOWS.map((s) => ({ platform: 'apple' as const, ...s })))
        .onConflictDoUpdate({
          target: [catalogShows.platform, catalogShows.sourceShowId],
          set: { topic: sql`excluded.topic`, title: sql`excluded.title`, updatedAt: sql`now()` },
        })
        .returning({ id: catalogShows.id });
      return rows.length;
    },

    /** Shows whose episodes are older than `staleMs`, least recently refreshed first. */
    async showsDue(now: Date, staleMs: number, limit: number): Promise<CatalogShowRow[]> {
      return db
        .select()
        .from(catalogShows)
        .where(
          and(
            eq(catalogShows.active, true),
            or(
              isNull(catalogShows.lastRefreshedAt),
              lt(catalogShows.lastRefreshedAt, new Date(now.getTime() - staleMs)),
            ),
          ),
        )
        .orderBy(sql`${catalogShows.lastRefreshedAt} asc nulls first`)
        .limit(limit);
    },

    async markRefreshed(id: string, now: Date, artworkUrl: string | null): Promise<void> {
      await db
        .update(catalogShows)
        .set({
          lastRefreshedAt: now,
          lastError: null,
          updatedAt: sql`now()`,
          ...(artworkUrl ? { artworkUrl } : {}),
        })
        .where(eq(catalogShows.id, id));
    },

    /** Record the failure but still move the show to the back of the queue so one bad show can't block the rest. */
    async markFailed(id: string, now: Date, error: string): Promise<void> {
      await db
        .update(catalogShows)
        .set({ lastRefreshedAt: now, lastError: error.slice(0, 500), updatedAt: sql`now()` })
        .where(eq(catalogShows.id, id));
    },

    /** Upsert an episode and add topic tags without removing tags it already has. */
    async upsertTagged(c: EpisodeCandidate, topics: string[]): Promise<void> {
      const values = {
        sourcePlatform: c.ref.platform,
        sourceEpisodeId: c.ref.id,
        canonicalUrl: c.ref.url,
        title: c.title.slice(0, 500),
        showTitle: c.showTitle.slice(0, 300),
        showSourceId: c.showRef?.id ?? null,
        description: c.description ?? null,
        publishedAt: c.publishedAt ?? null,
        durationSec: c.durationSec && c.durationSec > 0 ? c.durationSec : null,
        artworkUrl: c.artworkUrl ?? null,
        feedItemGuid: c.feedItemGuid ?? null,
        enclosureUrl: c.enclosureUrl ?? null,
        people: c.people ?? [],
        topicTags: topics,
        popularity: c.popularity ?? null,
      };
      await db
        .insert(episodes)
        .values(values)
        .onConflictDoUpdate({
          target: [episodes.sourcePlatform, episodes.sourceEpisodeId],
          set: {
            ...values,
            topicTags: sql`(select coalesce(array_agg(distinct t), '{}') from unnest(${episodes.topicTags} || excluded.topic_tags) as t)`,
            fetchedAt: sql`now()`,
            updatedAt: sql`now()`,
          },
        });
    },

    /** Topic (or all curated) episodes, newest first, keyset-paginated. */
    async feed(opts: {
      topic: string | null;
      cursor: string | null;
      limit: number;
    }): Promise<{ items: EpisodeRow[]; nextCursor: string | null }> {
      const after = opts.cursor ? decodeCursor(opts.cursor) : null;
      const conditions = [sql`cardinality(${episodes.topicTags}) > 0`];
      if (opts.topic) conditions.push(sql`${episodes.topicTags} @> array[${opts.topic}]::text[]`);
      if (after) {
        conditions.push(
          after.publishedAt
            ? sql`(${episodes.publishedAt} < ${after.publishedAt} or (${episodes.publishedAt} = ${after.publishedAt} and ${episodes.id} < ${after.id}) or ${episodes.publishedAt} is null)`
            : sql`(${episodes.publishedAt} is null and ${episodes.id} < ${after.id})`,
        );
      }
      const rows = await db
        .select()
        .from(episodes)
        .where(and(...conditions))
        .orderBy(sql`${episodes.publishedAt} desc nulls last`, desc(episodes.id))
        .limit(opts.limit + 1);
      const items = rows.slice(0, opts.limit);
      const last = items[items.length - 1];
      return { items, nextCursor: rows.length > opts.limit && last ? encodeCursor(last) : null };
    },

    /** The newest episode of each curated show: one per show keeps the rail varied. */
    async trending(limit: number): Promise<EpisodeRow[]> {
      const latest = await db
        .selectDistinctOn([episodes.showSourceId])
        .from(episodes)
        .where(sql`cardinality(${episodes.topicTags}) > 0 and ${episodes.showSourceId} is not null`)
        .orderBy(episodes.showSourceId, sql`${episodes.publishedAt} desc nulls last`);
      return latest
        .sort((a, b) => (b.publishedAt?.getTime() ?? 0) - (a.publishedAt?.getTime() ?? 0))
        .slice(0, limit);
    },

    /** Shows per topic with episode counts, for the topic index and chips. */
    async topicSummary(): Promise<Array<{ topic: string; shows: CatalogShowRow[]; episodeCount: number }>> {
      const shows = await db
        .select()
        .from(catalogShows)
        .where(eq(catalogShows.active, true))
        .orderBy(asc(catalogShows.title));
      const counts = await db
        .select({ topic: sql<string>`unnest(${episodes.topicTags})`, n: sql<number>`count(*)::int` })
        .from(episodes)
        .groupBy(sql`1`);
      const byTopic = new Map(counts.map((c) => [c.topic, Number(c.n)]));
      const grouped = new Map<string, CatalogShowRow[]>();
      for (const s of shows) grouped.set(s.topic, [...(grouped.get(s.topic) ?? []), s]);
      return [...grouped.entries()].map(([topic, list]) => ({
        topic,
        shows: list,
        episodeCount: byTopic.get(topic) ?? 0,
      }));
    },
  };
}
