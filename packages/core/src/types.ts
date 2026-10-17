/**
 * Platform-neutral domain model. Mirrors PRD §8 "Episode record (minimum model)".
 * Nothing in here knows about HTTP, databases or a specific provider's response shape.
 */

export const PLATFORMS = ['youtube', 'spotify', 'apple'] as const;
export type Platform = (typeof PLATFORMS)[number];

export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}

/** A pointer to one item on one platform. `id` is the provider's own identifier. */
export interface ProviderRef {
  platform: Platform;
  id: string;
  url: string;
}

/**
 * An episode as one provider describes it. Every optional field may be missing because
 * providers expose different metadata; matching must treat "missing" differently from "different".
 */
export interface EpisodeCandidate {
  ref: ProviderRef;
  title: string;
  showTitle: string;
  showRef?: ProviderRef | null;
  description?: string | null;
  publishedAt?: Date | null;
  durationSec?: number | null;
  artworkUrl?: string | null;
  /** People named in the metadata (hosts, guests). Used as weak matching evidence. */
  people?: string[];
  /** RSS <guid> for the item, when the provider exposes it (Apple via feed, RSS). */
  feedItemGuid?: string | null;
  /** RSS enclosure URL. Two candidates with the same enclosure are the same audio. */
  enclosureUrl?: string | null;
  popularity?: PopularityMetric | null;
}

export type PopularityKind = 'views' | 'chart_rank' | 'rating';

/**
 * Popularity is always source-specific. Missing data is `available: false`, never zero (PRD DISC-03).
 */
export type PopularityMetric =
  | {
      available: true;
      kind: PopularityKind;
      value: number;
      /** e.g. chart name for chart_rank, rating count for rating */
      context?: string;
      source: Platform;
      retrievedAt: Date;
    }
  | { available: false; source: Platform; retrievedAt: Date };

export type MatchStatus =
  /** The item already lives on the destination platform. */
  | 'native'
  /** Deterministic identity (shared provider id, feed GUID or enclosure URL). */
  | 'exact'
  /** High-confidence score with no conflicting evidence; may be auto-selected. */
  | 'strong'
  /** Plausible but uncertain; a person must decide (no silent substitution, PRD XFER-02). */
  | 'review'
  /** No acceptable candidate found. */
  | 'none';

export type EvidenceField =
  'provider_id' | 'feed_guid' | 'enclosure' | 'show' | 'title' | 'duration' | 'published_at' | 'people';

export type EvidenceResult = 'match' | 'partial' | 'mismatch' | 'missing';

export interface MatchEvidence {
  field: EvidenceField;
  result: EvidenceResult;
  /** Human-readable explanation shown in the review UI. */
  detail: string;
}

export interface MatchResult {
  status: MatchStatus;
  /** 0..1. 1 for native/exact, 0 for none. */
  confidence: number;
  candidate: EpisodeCandidate | null;
  evidence: MatchEvidence[];
  /** Other plausible candidates, best first, for "pick another" in review. */
  alternatives: Array<{ candidate: EpisodeCandidate; confidence: number }>;
  /** Why the result needs review, when it does. */
  reviewReason?: 'low_confidence' | 'conflicting_evidence' | 'ambiguous';
}
