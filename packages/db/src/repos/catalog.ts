import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import type { EpisodeCandidate, MatchResult, Platform } from '@tangent/core';
import type { Db } from '../client.js';
import { destinationMatches, episodes } from '../schema.js';
import { reviveMatch, reviveMetric } from '../serialize.js';

export type EpisodeRow = typeof episodes.$inferSelect;

export function episodeToCandidate(row: EpisodeRow): EpisodeCandidate {
  return {
    ref: { platform: row.sourcePlatform, id: row.sourceEpisodeId, url: row.canonicalUrl },
    title: row.title,
    showTitle: row.showTitle,
    showRef: row.showSourceId ? { platform: row.sourcePlatform, id: row.showSourceId, url: '' } : null,
    description: row.description,
    publishedAt: row.publishedAt,
    durationSec: row.durationSec,
    artworkUrl: row.artworkUrl,
    people: row.people,
    feedItemGuid: row.feedItemGuid,
    enclosureUrl: row.enclosureUrl,
    popularity: row.popularity ? reviveMetric(row.popularity) : null,
  };
}

export function episodesRepo(db: Db) {
  return {
    /**
     * Insert or refresh an episode from provider data. Saved items keep their identity
     * even when the provider later changes the title (PRD LIB-02).
     */
    async upsert(c: EpisodeCandidate): Promise<EpisodeRow> {
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
        popularity: c.popularity ?? null,
      };
      const [row] = await db
        .insert(episodes)
        .values(values)
        .onConflictDoUpdate({
          target: [episodes.sourcePlatform, episodes.sourceEpisodeId],
          set: { ...values, fetchedAt: sql`now()`, updatedAt: sql`now()` },
        })
        .returning();
      return row!;
    },

    async get(id: string): Promise<EpisodeRow | null> {
      const [row] = await db.select().from(episodes).where(eq(episodes.id, id)).limit(1);
      return row ?? null;
    },

    async getBySource(platform: Platform, sourceId: string): Promise<EpisodeRow | null> {
      const [row] = await db
        .select()
        .from(episodes)
        .where(and(eq(episodes.sourcePlatform, platform), eq(episodes.sourceEpisodeId, sourceId)))
        .limit(1);
      return row ?? null;
    },

    async getMany(ids: string[]): Promise<Map<string, EpisodeRow>> {
      if (ids.length === 0) return new Map();
      const rows = await db.select().from(episodes).where(inArray(episodes.id, ids));
      return new Map(rows.map((r) => [r.id, r]));
    },
  };
}

export function matchesRepo(db: Db) {
  return {
    /** Cached match if it's newer than `maxAgeMs`. "none" results expire sooner: the episode may appear later. */
    async get(
      episodeId: string,
      platform: Platform,
      now: Date,
      maxAgeMs: number,
    ): Promise<MatchResult | null> {
      const [row] = await db
        .select()
        .from(destinationMatches)
        .where(
          and(
            eq(destinationMatches.episodeId, episodeId),
            eq(destinationMatches.platform, platform),
            gt(destinationMatches.matchedAt, new Date(now.getTime() - maxAgeMs)),
          ),
        )
        .limit(1);
      if (!row) return null;
      if (row.status === 'none' && row.matchedAt.getTime() < now.getTime() - Math.min(maxAgeMs, 86_400_000))
        return null;
      return reviveMatch(row.result);
    },

    async put(episodeId: string, platform: Platform, result: MatchResult): Promise<void> {
      const values = {
        episodeId,
        platform,
        status: result.status,
        confidence: Math.max(0, Math.min(1, result.confidence)),
        result,
      };
      await db
        .insert(destinationMatches)
        .values(values)
        .onConflictDoUpdate({
          target: [destinationMatches.episodeId, destinationMatches.platform],
          set: { status: values.status, confidence: values.confidence, result, matchedAt: sql`now()` },
        });
    },
  };
}
