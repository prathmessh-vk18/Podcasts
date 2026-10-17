import { describe, expect, it } from 'vitest';
import {
  assertExecutable,
  assertTransition,
  buildPlan,
  decide,
  itemsToAdd,
  postRunStatus,
  preRunStatus,
  summarize,
  type PlanItemInput,
} from '../src/export-plan.js';
import { DomainError } from '../src/errors.js';
import type { MatchResult, MatchStatus } from '../src/types.js';

const match = (status: MatchStatus): MatchResult => ({
  status,
  confidence: status === 'none' ? 0 : 0.95,
  candidate: null,
  evidence: [],
  alternatives: [],
});

const input = (
  itemId: string,
  status: MatchStatus,
  position: number,
  duplicateGroup: string | null = null,
): PlanItemInput => ({
  itemId,
  episodeId: `ep-${itemId}`,
  position,
  match: match(status),
  duplicateGroup,
});

describe('buildPlan', () => {
  const plan = buildPlan([
    input('d', 'none', 3),
    input('a', 'exact', 0, 'g1'),
    input('b', 'review', 1),
    input('c', 'strong', 2, 'g1'),
  ]);

  it('orders by position and classifies items', () => {
    expect(plan.map((i) => [i.itemId, i.kind])).toEqual([
      ['a', 'ready'],
      ['b', 'review'],
      ['c', 'duplicate'],
      ['d', 'unavailable'],
    ]);
  });

  it('keeps the first of a duplicate group and skips the rest', () => {
    expect(plan[2]).toMatchObject({ duplicateOf: 'a', state: 'skipped', skipReason: 'duplicate' });
  });

  it('needs review until every review is decided', () => {
    expect(preRunStatus(plan)).toBe('needs_review');
    expect(() => assertExecutable('needs_review', plan)).toThrow(DomainError);
  });

  it('summarises counts', () => {
    expect(summarize(plan)).toEqual({
      total: 4,
      toAdd: 1,
      added: 0,
      failed: 0,
      pendingReview: 1,
      skipped: { unavailable: 1, rejected: 0, duplicate: 1 },
    });
  });
});

describe('decide', () => {
  const [, review] = buildPlan([input('a', 'exact', 0), input('b', 'review', 1)]);

  it('accepting makes the item addable; rejecting skips it', () => {
    expect(decide(review!, 'accept')).toMatchObject({ decision: 'accept', state: 'pending' });
    expect(decide(review!, 'reject')).toMatchObject({
      decision: 'reject',
      state: 'skipped',
      skipReason: 'rejected',
    });
  });

  it('can be undone (decision back to null)', () => {
    expect(decide(decide(review!, 'reject'), null)).toMatchObject({
      decision: null,
      state: 'pending',
      skipReason: null,
    });
  });

  it('refuses to decide non-review items', () => {
    const [ready] = buildPlan([input('a', 'exact', 0)]);
    expect(() => decide(ready!, 'accept')).toThrow(/Only items that need review/);
  });

  it('refuses to change an item that was already added', () => {
    expect(() => decide({ ...review!, state: 'added' }, 'reject')).toThrow(/already added/);
  });
});

describe('run outcomes', () => {
  const base = buildPlan([input('a', 'exact', 0), input('b', 'strong', 1), input('c', 'none', 2)]);

  it('completed when every addable item was added (skips do not count as failures)', () => {
    const done = base.map((i) => (i.kind === 'ready' ? { ...i, state: 'added' as const } : i));
    expect(postRunStatus(done)).toBe('completed');
    expect(itemsToAdd(done)).toHaveLength(0);
  });

  it('partial when some were added and some failed', () => {
    const items = [
      { ...base[0]!, state: 'added' as const },
      { ...base[1]!, state: 'failed' as const },
      base[2]!,
    ];
    expect(postRunStatus(items)).toBe('partial');
    expect(itemsToAdd(items).map((i) => i.itemId)).toEqual(['b']);
  });

  it('failed when nothing was added', () => {
    const items = base.map((i) => (i.kind === 'ready' ? { ...i, state: 'failed' as const } : i));
    expect(postRunStatus(items)).toBe('failed');
  });

  it('refuses to execute when nothing can be added', () => {
    const items = buildPlan([input('c', 'none', 0)]);
    expect(() => assertExecutable('ready', items)).toThrow(/Nothing to add/);
  });
});

describe('transitions', () => {
  it('allows the documented lifecycle', () => {
    expect(() => assertTransition('ready', 'running')).not.toThrow();
    expect(() => assertTransition('running', 'partial')).not.toThrow();
    expect(() => assertTransition('partial', 'running')).not.toThrow();
  });
  it('blocks invalid moves', () => {
    expect(() => assertTransition('completed', 'running')).toThrow(DomainError);
    expect(() => assertTransition('running', 'running')).toThrow(DomainError);
    expect(() => assertTransition('needs_review', 'running')).toThrow(DomainError);
  });
});
