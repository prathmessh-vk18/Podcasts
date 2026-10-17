import { DEFAULT_THRESHOLDS, scoreCandidate } from './matching.js';
import type { EpisodeCandidate } from './types.js';

/**
 * Finds the same episode saved from different sources inside one collection
 * (e.g. a YouTube upload and its Spotify audio). Returns a group key per item id;
 * items without duplicates map to null.
 *
 * Only high-confidence, non-conflicting pairs are grouped: wrongly merging two different
 * episodes is worse than showing a duplicate.
 */
export function findDuplicateGroups(
  items: Array<{ id: string; candidate: EpisodeCandidate }>,
  threshold = DEFAULT_THRESHOLDS.strong,
): Map<string, string | null> {
  const parent = new Map<string, string>(items.map((i) => [i.id, i.id]));
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression keeps repeated lookups cheap.
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };

  // O(n²) is fine for collection sizes; guard against pathological inputs anyway.
  const capped = items.slice(0, 1000);
  for (let i = 0; i < capped.length; i++) {
    for (let j = i + 1; j < capped.length; j++) {
      const a = capped[i]!,
        b = capped[j]!;
      if (
        a.candidate.ref.platform === b.candidate.ref.platform &&
        a.candidate.ref.id === b.candidate.ref.id
      ) {
        parent.set(find(b.id), find(a.id));
        continue;
      }
      if (a.candidate.ref.platform === b.candidate.ref.platform) continue; // same source, different items
      const s = scoreCandidate(a.candidate, b.candidate);
      if (s.deterministic || (s.confidence >= threshold && !s.conflicting))
        parent.set(find(b.id), find(a.id));
    }
  }

  const sizes = new Map<string, number>();
  for (const i of items) sizes.set(find(i.id), (sizes.get(find(i.id)) ?? 0) + 1);
  return new Map(items.map((i) => [i.id, (sizes.get(find(i.id)) ?? 0) > 1 ? find(i.id) : null]));
}
