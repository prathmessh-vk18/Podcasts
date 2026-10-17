import type { EpisodeCandidate, MatchResult, PopularityMetric } from '@tangent/core';

/** JSONB turns Dates into strings. Revive the ones our types promise are Dates. */
function toDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function reviveCandidate(c: EpisodeCandidate | null | undefined): EpisodeCandidate | null {
  if (!c) return null;
  return {
    ...c,
    publishedAt: toDate(c.publishedAt),
    popularity: c.popularity ? reviveMetric(c.popularity) : null,
  };
}

export function reviveMetric(m: PopularityMetric): PopularityMetric {
  return { ...m, retrievedAt: toDate(m.retrievedAt) ?? new Date(0) } as PopularityMetric;
}

export function reviveMatch(m: MatchResult): MatchResult {
  return {
    ...m,
    candidate: reviveCandidate(m.candidate),
    alternatives: (m.alternatives ?? []).map((a) => ({ ...a, candidate: reviveCandidate(a.candidate)! })),
  };
}
