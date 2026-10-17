import { DomainError } from './errors.js';
import type { MatchResult, MatchStatus } from './types.js';

/**
 * Export planning as pure state transitions. The engine (in the API app) persists these
 * objects and performs the side effects; this module only decides what is allowed.
 *
 * Job lifecycle:
 *   planning ─(matching done)→ needs_review | ready   (or failed if providers were unreachable)
 *   needs_review ─(all reviews decided)→ ready ─(execute)→ running ─→ completed
 *                                                              ├─→ partial (some failed, retryable)
 *                                                              └─→ failed (nothing added)
 *   partial | failed ─(retry)→ running
 *   any non-running ─(cancel)→ cancelled
 */

export type ExportJobStatus =
  'planning' | 'needs_review' | 'ready' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';

export type ExportItemKind = 'ready' | 'review' | 'unavailable' | 'duplicate';
export type ReviewDecision = 'accept' | 'reject';
export type ExportItemState = 'pending' | 'added' | 'failed' | 'skipped';
export type SkipReason = 'unavailable' | 'rejected' | 'duplicate';

export interface ExportItemError {
  kind: string;
  message: string;
  retryable: boolean;
}

export interface PlanItem {
  itemId: string;
  episodeId: string;
  position: number;
  match: MatchResult;
  kind: ExportItemKind;
  decision: ReviewDecision | null;
  duplicateOf: string | null;
  state: ExportItemState;
  skipReason: SkipReason | null;
  attempts: number;
  lastError: ExportItemError | null;
  destinationItemId: string | null;
}

export interface PlanItemInput {
  itemId: string;
  episodeId: string;
  position: number;
  match: MatchResult;
  /** Items sharing a group key are the same episode saved from different sources. */
  duplicateGroup?: string | null;
}

const KIND_BY_STATUS: Record<MatchStatus, ExportItemKind> = {
  native: 'ready',
  exact: 'ready',
  strong: 'ready',
  review: 'review',
  none: 'unavailable',
};

export function buildPlan(inputs: PlanItemInput[]): PlanItem[] {
  const sorted = [...inputs].sort((a, b) => a.position - b.position);
  const firstInGroup = new Map<string, string>();
  return sorted.map((input) => {
    let duplicateOf: string | null = null;
    if (input.duplicateGroup) {
      const first = firstInGroup.get(input.duplicateGroup);
      if (first) duplicateOf = first;
      else firstInGroup.set(input.duplicateGroup, input.itemId);
    }
    const kind: ExportItemKind = duplicateOf ? 'duplicate' : KIND_BY_STATUS[input.match.status];
    const skipReason: SkipReason | null =
      kind === 'duplicate' ? 'duplicate' : kind === 'unavailable' ? 'unavailable' : null;
    return {
      itemId: input.itemId,
      episodeId: input.episodeId,
      position: input.position,
      match: input.match,
      kind,
      decision: null,
      duplicateOf,
      state: skipReason ? 'skipped' : 'pending',
      skipReason,
      attempts: 0,
      lastError: null,
      destinationItemId: null,
    };
  });
}

export function decide(item: PlanItem, decision: ReviewDecision | null): PlanItem {
  if (item.kind !== 'review') {
    throw new DomainError('invalid_state', 'Only items that need review can be decided', {
      itemId: item.itemId,
      kind: item.kind,
    });
  }
  if (item.state === 'added') {
    throw new DomainError('invalid_state', 'This item was already added to the playlist', {
      itemId: item.itemId,
    });
  }
  return {
    ...item,
    decision,
    state: decision === 'reject' ? 'skipped' : 'pending',
    skipReason: decision === 'reject' ? 'rejected' : null,
  };
}

export function pendingReviewCount(items: PlanItem[]): number {
  return items.filter((i) => i.kind === 'review' && i.decision === null).length;
}

/** Items that should be sent to the destination now: approved, not yet added. */
export function itemsToAdd(items: PlanItem[]): PlanItem[] {
  return items
    .filter(
      (i) => (i.kind === 'ready' || (i.kind === 'review' && i.decision === 'accept')) && i.state !== 'added',
    )
    .sort((a, b) => a.position - b.position);
}

export interface PlanSummary {
  total: number;
  toAdd: number;
  added: number;
  failed: number;
  pendingReview: number;
  skipped: { unavailable: number; rejected: number; duplicate: number };
}

export function summarize(items: PlanItem[]): PlanSummary {
  const s: PlanSummary = {
    total: items.length,
    toAdd: itemsToAdd(items).length,
    added: 0,
    failed: 0,
    pendingReview: pendingReviewCount(items),
    skipped: { unavailable: 0, rejected: 0, duplicate: 0 },
  };
  for (const i of items) {
    if (i.state === 'added') s.added++;
    if (i.state === 'failed') s.failed++;
    if (i.state === 'skipped' && i.skipReason) s.skipped[i.skipReason]++;
  }
  return s;
}

/** The status a job should have after planning or decisions (before it runs). */
export function preRunStatus(items: PlanItem[]): Extract<ExportJobStatus, 'needs_review' | 'ready'> {
  return pendingReviewCount(items) > 0 ? 'needs_review' : 'ready';
}

/** The status a job should have after a run finishes. */
export function postRunStatus(
  items: PlanItem[],
): Extract<ExportJobStatus, 'completed' | 'partial' | 'failed'> {
  const relevant = items.filter(
    (i) => i.kind === 'ready' || (i.kind === 'review' && i.decision === 'accept'),
  );
  const added = relevant.filter((i) => i.state === 'added').length;
  const failed = relevant.filter((i) => i.state === 'failed').length;
  if (failed === 0) return 'completed';
  return added > 0 ? 'partial' : 'failed';
}

const TRANSITIONS: Record<ExportJobStatus, readonly ExportJobStatus[]> = {
  planning: ['needs_review', 'ready', 'failed', 'cancelled'],
  needs_review: ['needs_review', 'ready', 'cancelled'],
  ready: ['needs_review', 'ready', 'running', 'cancelled'],
  running: ['completed', 'partial', 'failed'],
  completed: [],
  partial: ['running', 'cancelled'],
  failed: ['running', 'planning', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: ExportJobStatus, to: ExportJobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExportJobStatus, to: ExportJobStatus): void {
  if (!canTransition(from, to)) {
    throw new DomainError('invalid_state', `Export can't go from "${from}" to "${to}"`, { from, to });
  }
}

/** Execution is allowed only when every review is decided and at least one item can be added. */
export function assertExecutable(status: ExportJobStatus, items: PlanItem[]): void {
  const pending = pendingReviewCount(items);
  if (pending > 0)
    throw new DomainError('invalid_state', `${pending} match(es) still need review`, {
      pendingReview: pending,
    });
  if (itemsToAdd(items).length === 0)
    throw new DomainError('invalid_state', 'Nothing to add: every item is skipped or already added');
  assertTransition(status, 'running');
}
