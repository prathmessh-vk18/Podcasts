import { formatClock } from './duration.js';
import { normalizeText, showSimilarity, titleSimilarity } from './text.js';
import type { EpisodeCandidate, EvidenceResult, MatchEvidence, MatchResult, Platform } from './types.js';

/**
 * Matching policy (PRD §8 "deterministic matching first"):
 * 1. Same platform → native.
 * 2. Shared identity (feed GUID within the same show, or identical enclosure audio) → exact.
 * 3. Otherwise a weighted score over show, title, duration and release date.
 *    - A high score with any conflicting signal goes to review, never auto-selected.
 *    - Two near-equal candidates go to review (ambiguous).
 *    - Missing data lowers confidence; it isn't treated as a match.
 */

export interface MatchThresholds {
  /** At or above: auto-selectable, if there's no conflict and no ambiguity. */
  strong: number;
  /** At or above: shown for review. Below: "not found". */
  review: number;
  /** If the runner-up is within this margin of the best, it's ambiguous. */
  ambiguityMargin: number;
}

export const DEFAULT_THRESHOLDS: MatchThresholds = { strong: 0.9, review: 0.6, ambiguityMargin: 0.05 };

const WEIGHTS = { show: 0.25, title: 0.4, duration: 0.2, published_at: 0.15 } as const;
/** Each missing signal costs a little confidence so sparse metadata can't reach "strong" alone. */
const MISSING_PENALTY = 0.96;

export interface ScoredCandidate {
  candidate: EpisodeCandidate;
  confidence: number;
  evidence: MatchEvidence[];
  deterministic: boolean;
  conflicting: boolean;
  /** True when duration or release date agrees, not just show and title. Required for "strong". */
  corroborated: boolean;
}

function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    // Podcast hosts append tracking redirects and query strings; the path identifies the file.
    return (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return url.trim().toLowerCase();
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function durationEvidence(
  a?: number | null,
  b?: number | null,
): { result: EvidenceResult; score: number; detail: string } {
  if (!a || !b) return { result: 'missing', score: 0, detail: 'Duration not available on both sides' };
  const delta = Math.abs(a - b);
  const longer = Math.max(a, b);
  const pair = `${formatClock(a)} vs ${formatClock(b)}`;
  if (delta <= Math.max(60, longer * 0.015))
    return { result: 'match', score: 1, detail: `Duration matches (${pair})` };
  const mins = Math.round(delta / 60);
  if (delta <= Math.max(180, longer * 0.05))
    return { result: 'partial', score: 0.6, detail: `Duration differs by ${mins} min (${pair})` };
  return {
    result: 'mismatch',
    score: 0,
    detail: `Duration differs by ${mins} min (${pair}). One may be a clip or an edited cut`,
  };
}

function dateEvidence(
  a?: Date | null,
  b?: Date | null,
): { result: EvidenceResult; score: number; detail: string } {
  if (!a || !b || Number.isNaN(a.getTime()) || Number.isNaN(b.getTime()))
    return { result: 'missing', score: 0, detail: 'Release date not available on both sides' };
  const days = Math.abs(a.getTime() - b.getTime()) / 86_400_000;
  if (days <= 1.5) return { result: 'match', score: 1, detail: 'Released the same day' };
  if (days <= 4) return { result: 'partial', score: 0.6, detail: `Released ${Math.round(days)} days apart` };
  return { result: 'mismatch', score: 0, detail: `Released ${Math.round(days)} days apart` };
}

function peopleOverlap(a?: string[], b?: string[]): MatchEvidence | null {
  if (!a?.length || !b?.length) return null;
  const nb = new Set(b.map(normalizeText));
  const shared = a.map(normalizeText).filter((p) => p && nb.has(p));
  return shared.length
    ? { field: 'people', result: 'match', detail: `Same people named (${shared.length})` }
    : null;
}

export function scoreCandidate(source: EpisodeCandidate, candidate: EpisodeCandidate): ScoredCandidate {
  const evidence: MatchEvidence[] = [];
  const showSim = showSimilarity(source.showTitle, candidate.showTitle);

  // --- Deterministic identity -------------------------------------------------------------
  if (source.ref.platform === candidate.ref.platform && source.ref.id === candidate.ref.id) {
    evidence.push({ field: 'provider_id', result: 'match', detail: 'Same item on the same platform' });
    return {
      candidate,
      confidence: 1,
      evidence,
      deterministic: true,
      conflicting: false,
      corroborated: true,
    };
  }
  // GUIDs are only unique within a feed ("1", "2"… are common), so require the same show.
  if (
    source.feedItemGuid &&
    candidate.feedItemGuid &&
    source.feedItemGuid === candidate.feedItemGuid &&
    showSim >= 0.7
  ) {
    evidence.push({ field: 'feed_guid', result: 'match', detail: 'Same RSS item GUID in the same show' });
    return {
      candidate,
      confidence: 1,
      evidence,
      deterministic: true,
      conflicting: false,
      corroborated: true,
    };
  }
  if (
    source.enclosureUrl &&
    candidate.enclosureUrl &&
    normalizeUrl(source.enclosureUrl) === normalizeUrl(candidate.enclosureUrl)
  ) {
    evidence.push({ field: 'enclosure', result: 'match', detail: 'Same audio file' });
    return {
      candidate,
      confidence: 1,
      evidence,
      deterministic: true,
      conflicting: false,
      corroborated: true,
    };
  }

  // --- Weighted evidence ------------------------------------------------------------------
  let weighted = 0;
  let available = 0;
  let missing = 0;

  const showResult: EvidenceResult = showSim >= 0.9 ? 'match' : showSim >= 0.7 ? 'partial' : 'mismatch';
  evidence.push({
    field: 'show',
    result: showResult,
    detail: showResult === 'match' ? 'Same show' : `Show names differ (${pct(showSim)} similar)`,
  });
  weighted += WEIGHTS.show * showSim;
  available += WEIGHTS.show;

  const titleSim = titleSimilarity(source.title, candidate.title);
  const titleResult: EvidenceResult = titleSim >= 0.92 ? 'match' : titleSim >= 0.7 ? 'partial' : 'mismatch';
  evidence.push({
    field: 'title',
    result: titleResult,
    detail: titleResult === 'match' ? 'Title matches' : `Titles differ (${pct(titleSim)} similar)`,
  });
  weighted += WEIGHTS.title * titleSim;
  available += WEIGHTS.title;

  const dur = durationEvidence(source.durationSec, candidate.durationSec);
  evidence.push({ field: 'duration', result: dur.result, detail: dur.detail });
  if (dur.result === 'missing') missing++;
  else {
    weighted += WEIGHTS.duration * dur.score;
    available += WEIGHTS.duration;
  }

  const date = dateEvidence(source.publishedAt, candidate.publishedAt);
  evidence.push({ field: 'published_at', result: date.result, detail: date.detail });
  if (date.result === 'missing') missing++;
  else {
    weighted += WEIGHTS.published_at * date.score;
    available += WEIGHTS.published_at;
  }

  const people = peopleOverlap(source.people, candidate.people);
  if (people) evidence.push(people);

  let confidence = (weighted / available) * Math.pow(MISSING_PENALTY, missing);
  if (people) confidence = Math.min(1, confidence + 0.02);

  // Hard gates: a different show or a clearly different title can't be rescued by other signals.
  if (showResult === 'mismatch') confidence = Math.min(confidence, 0.5);
  if (titleResult === 'mismatch') confidence = Math.min(confidence, 0.55);

  const conflicting = dur.result === 'mismatch' || date.result === 'mismatch';
  // Reruns and "best of" re-releases share titles, so title + show alone never auto-selects.
  const corroborated = dur.result === 'match' || date.result === 'match';

  return {
    candidate,
    confidence: Math.round(confidence * 1000) / 1000,
    evidence,
    deterministic: false,
    conflicting,
    corroborated,
  };
}

export function matchEpisode(
  source: EpisodeCandidate,
  destination: Platform,
  candidates: EpisodeCandidate[],
  thresholds: MatchThresholds = DEFAULT_THRESHOLDS,
): MatchResult {
  if (source.ref.platform === destination) {
    return {
      status: 'native',
      confidence: 1,
      candidate: source,
      evidence: [{ field: 'provider_id', result: 'match', detail: 'Already on this platform' }],
      alternatives: [],
    };
  }

  // Ignore candidates from the wrong platform and exact duplicates of the same ref.
  const seen = new Set<string>();
  const usable = candidates.filter((c) => {
    if (c.ref.platform !== destination) return false;
    if (seen.has(c.ref.id)) return false;
    seen.add(c.ref.id);
    return true;
  });

  const scored = usable.map((c) => scoreCandidate(source, c)).sort((a, b) => b.confidence - a.confidence);
  const [best, second] = scored;
  const alternatives = scored
    .slice(1, 4)
    .filter((s) => s.confidence >= 0.4)
    .map((s) => ({ candidate: s.candidate, confidence: s.confidence }));

  if (!best || best.confidence < thresholds.review) {
    return {
      status: 'none',
      confidence: 0,
      candidate: null,
      evidence: best?.evidence ?? [],
      alternatives: scored
        .slice(0, 3)
        .filter((s) => s.confidence >= 0.4)
        .map((s) => ({ candidate: s.candidate, confidence: s.confidence })),
    };
  }

  if (best.deterministic) {
    return {
      status: 'exact',
      confidence: 1,
      candidate: best.candidate,
      evidence: best.evidence,
      alternatives,
    };
  }

  const ambiguous =
    !!second &&
    second.confidence >= thresholds.review &&
    best.confidence - second.confidence < thresholds.ambiguityMargin;

  const base = {
    confidence: best.confidence,
    candidate: best.candidate,
    evidence: best.evidence,
    alternatives,
  };
  if (ambiguous) return { ...base, status: 'review', reviewReason: 'ambiguous' };
  if (best.conflicting) return { ...base, status: 'review', reviewReason: 'conflicting_evidence' };
  if (best.confidence >= thresholds.strong && best.corroborated) return { ...base, status: 'strong' };
  return { ...base, status: 'review', reviewReason: 'low_confidence' };
}

/** Build a precise search query for a destination: show + cleaned title, trimmed to a safe length. */
export function buildSearchQuery(source: EpisodeCandidate, maxLength = 120): string {
  const title = source.title.replace(/\s*[|–—]\s.*$/, '').trim() || source.title;
  const q = `${source.showTitle} ${title}`.replace(/\s+/g, ' ').trim();
  return q.length > maxLength ? q.slice(0, maxLength).replace(/\s+\S*$/, '') : q;
}
