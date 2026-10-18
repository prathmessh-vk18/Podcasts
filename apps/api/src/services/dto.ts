import type { EpisodeCandidate, MatchResult, PlanItem, PlanSummary, PopularityMetric } from '@tangent/core';
import type { CollectionRow, EpisodeRow, ExportJobRow } from '@tangent/db';

/** API response shapes. Dates are ISO strings; internal ids and secrets never leak. */

export interface PopularityDto {
  available: boolean;
  kind?: string;
  value?: number;
  context?: string;
  source: string;
  retrievedAt: string;
}

export function popularityDto(m: PopularityMetric | null | undefined): PopularityDto | null {
  if (!m) return null;
  return m.available
    ? {
        available: true,
        kind: m.kind,
        value: m.value,
        context: m.context,
        source: m.source,
        retrievedAt: m.retrievedAt.toISOString(),
      }
    : { available: false, source: m.source, retrievedAt: m.retrievedAt.toISOString() };
}

export function candidateDto(c: EpisodeCandidate) {
  return {
    platform: c.ref.platform,
    sourceId: c.ref.id,
    url: c.ref.url,
    title: c.title,
    show: c.showTitle,
    showId: c.showRef?.id ?? null,
    description: c.description ?? null,
    publishedAt: c.publishedAt?.toISOString() ?? null,
    durationSec: c.durationSec ?? null,
    artworkUrl: c.artworkUrl ?? null,
    popularity: popularityDto(c.popularity),
  };
}

export function episodeDto(e: EpisodeRow) {
  return {
    id: e.id,
    platform: e.sourcePlatform,
    sourceId: e.sourceEpisodeId,
    url: e.canonicalUrl,
    title: e.title,
    show: e.showTitle,
    showId: e.showSourceId,
    description: e.description,
    publishedAt: e.publishedAt?.toISOString() ?? null,
    durationSec: e.durationSec,
    artworkUrl: e.artworkUrl,
    popularity: popularityDto(e.popularity),
  };
}

export function collectionDto(c: CollectionRow & { itemCount?: number }) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    privacy: c.privacy,
    itemCount: c.itemCount,
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export function matchDto(m: MatchResult) {
  return {
    status: m.status,
    confidence: m.confidence,
    reviewReason: m.reviewReason ?? null,
    candidate: m.candidate ? candidateDto(m.candidate) : null,
    evidence: m.evidence,
    alternatives: m.alternatives.map((a) => ({
      confidence: a.confidence,
      candidate: candidateDto(a.candidate),
    })),
  };
}

export function exportDto(
  job: ExportJobRow,
  items: PlanItem[],
  episodes: Map<string, EpisodeRow>,
  summary: PlanSummary,
) {
  return {
    id: job.id,
    status: job.status,
    destination: job.destination,
    collectionId: job.collectionId,
    playlist: { title: job.playlistTitle, id: job.playlistId, url: job.playlistUrl },
    error: job.error,
    summary,
    items: items.map((i) => {
      const ep = episodes.get(i.episodeId);
      return {
        id: i.itemId,
        position: i.position,
        episode: ep ? episodeDto(ep) : null,
        kind: i.kind,
        decision: i.decision,
        state: i.state,
        skipReason: i.skipReason,
        duplicateOf: i.duplicateOf,
        attempts: i.attempts,
        lastError: i.lastError,
        match: matchDto(i.match),
      };
    }),
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
  };
}

/** Placeholder artwork until a show's first refresh has fetched its cover. */
export function artworkForTopic(): string | null {
  return null;
}
