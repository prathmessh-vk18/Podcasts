/** Response shapes from the Tangent API (apps/api/src/services/dto.ts). */

export type Platform = 'youtube' | 'spotify' | 'apple';

export interface Popularity {
  available: boolean;
  kind?: 'views' | 'chart_rank' | 'rating';
  value?: number;
  context?: string;
  source: Platform;
  retrievedAt: string;
}

/** Anything that points at an episode on a platform: a saved episode or a search result. */
export interface EpisodeLike {
  id?: string;
  platform: Platform;
  sourceId: string;
  url: string;
  title: string;
  show: string;
  showId: string | null;
  description: string | null;
  publishedAt: string | null;
  durationSec: number | null;
  artworkUrl: string | null;
  popularity: Popularity | null;
}

export interface Episode extends EpisodeLike {
  id: string;
}

export interface FeedPage {
  items: Episode[];
  nextCursor: string | null;
  warming: boolean;
}

export interface Topic {
  id: string;
  name: string;
  blurb: string;
  episodeCount: number;
  shows: Array<{ id: string; platform: Platform; title: string; artworkUrl: string | null }>;
}

export type SearchOutcome = { items: EpisodeLike[]; error?: { code: string; message: string } };

export interface Collection {
  id: string;
  name: string;
  description: string;
  privacy: 'private' | 'link';
  itemCount?: number;
  /** First episodes' artwork, for the cover mosaic (list endpoint only). */
  preview?: Array<{ artworkUrl: string | null; show: string }>;
  createdAt: string;
  updatedAt: string;
}

export interface CollectionItem {
  id: string;
  position: number;
  addedAt: string;
  episode: Episode;
}

export interface CollectionDetail extends Collection {
  items: CollectionItem[];
}

export interface Capability {
  platform: Platform;
  catalog: boolean;
  connect: boolean;
  export: 'playlist' | 'links' | false;
  notes: string[];
}

export interface Connection {
  platform: Platform;
  connected: boolean;
  status: 'active' | 'needs_reauth' | 'not_connected';
  displayName: string | null;
  available: boolean;
}

export type MatchStatus = 'native' | 'exact' | 'strong' | 'review' | 'none';

export interface MatchEvidence {
  field: string;
  result: 'match' | 'partial' | 'mismatch' | 'missing';
  detail: string;
}

export interface Match {
  status: MatchStatus;
  confidence: number;
  reviewReason: 'low_confidence' | 'conflicting_evidence' | 'ambiguous' | null;
  candidate: EpisodeLike | null;
  evidence: MatchEvidence[];
  alternatives: Array<{ confidence: number; candidate: EpisodeLike }>;
}

export type ExportStatus =
  'planning' | 'needs_review' | 'ready' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface ExportItem {
  id: string;
  position: number;
  episode: Episode | null;
  kind: 'ready' | 'review' | 'unavailable' | 'duplicate';
  decision: 'accept' | 'reject' | null;
  state: 'pending' | 'added' | 'failed' | 'skipped';
  skipReason: 'unavailable' | 'rejected' | 'duplicate' | null;
  duplicateOf: string | null;
  attempts: number;
  lastError: { kind: string; message: string; retryable: boolean } | null;
  match: Match;
}

export interface ExportJob {
  id: string;
  status: ExportStatus;
  destination: Platform;
  collectionId: string | null;
  playlist: { title: string | null; id: string | null; url: string | null };
  error: { kind: string; message: string; retryable: boolean } | null;
  summary: {
    total: number;
    toAdd: number;
    added: number;
    failed: number;
    pendingReview: number;
    skipped: { unavailable: number; rejected: number; duplicate: number };
  };
  items: ExportItem[];
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface LinkList {
  collection: { id: string; name: string };
  kind: 'link_list';
  note: string;
  items: Array<{ position: number; title: string; show: string; platform: Platform; url: string }>;
}
