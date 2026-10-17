import { describe, expect, it } from 'vitest';
import { buildSearchQuery, matchEpisode, scoreCandidate } from '../src/matching.js';
import { findDuplicateGroups } from '../src/dedupe.js';
import { ep } from './fixtures.js';

const source = ep({ platform: 'apple', id: 'a1' });

describe('matchEpisode', () => {
  it('returns native when the source is already on the destination', () => {
    const r = matchEpisode(source, 'apple', []);
    expect(r.status).toBe('native');
    expect(r.candidate).toBe(source);
  });

  it('returns none when there are no candidates', () => {
    const r = matchEpisode(source, 'spotify', []);
    expect(r).toMatchObject({ status: 'none', confidence: 0, candidate: null });
  });

  it('auto-selects a strong match with consistent metadata', () => {
    const c = ep({ platform: 'spotify', id: 's1', durationSec: 3540 });
    const r = matchEpisode(source, 'spotify', [c]);
    expect(r.status).toBe('strong');
    expect(r.candidate?.ref.id).toBe('s1');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('treats a shared feed GUID in the same show as exact', () => {
    const s = ep({ feedItemGuid: 'guid-123' });
    const c = ep({
      platform: 'spotify',
      id: 's2',
      feedItemGuid: 'guid-123',
      title: 'Totally different title',
    });
    expect(matchEpisode(s, 'spotify', [c]).status).toBe('exact');
  });

  it('does not trust a shared GUID across different shows', () => {
    const s = ep({ feedItemGuid: '1' });
    const c = ep({
      platform: 'spotify',
      id: 's3',
      feedItemGuid: '1',
      showTitle: 'Planet Money',
      title: 'Something else',
    });
    expect(matchEpisode(s, 'spotify', [c]).status).toBe('none');
  });

  it('treats the same enclosure URL (ignoring tracking query) as exact', () => {
    const s = ep({ enclosureUrl: 'https://traffic.host.com/ep/123.mp3?utm=a' });
    const c = ep({ platform: 'spotify', id: 's4', enclosureUrl: 'http://www.traffic.host.com/ep/123.mp3' });
    expect(matchEpisode(s, 'spotify', [c]).status).toBe('exact');
  });

  it('sends an edited cut (large duration difference) to review, never auto-selects it', () => {
    const c = ep({
      platform: 'youtube',
      id: 'y1',
      title: 'Why Conversations Go Wrong (Audio)',
      durationSec: 3534 - 372 * 3,
    });
    const r = matchEpisode(source, 'youtube', [c]);
    expect(r.status).toBe('review');
    expect(r.reviewReason).toBe('conflicting_evidence');
    expect(r.evidence.find((e) => e.field === 'duration')?.result).toBe('mismatch');
  });

  it('marks near-equal candidates as ambiguous', () => {
    const a = ep({ platform: 'spotify', id: 'x1', durationSec: 3534 });
    const b = ep({ platform: 'spotify', id: 'x2', durationSec: 3530 });
    const r = matchEpisode(source, 'spotify', [a, b]);
    expect(r.status).toBe('review');
    expect(r.reviewReason).toBe('ambiguous');
    expect(r.alternatives).toHaveLength(1);
  });

  it('rejects a different episode of the same show', () => {
    const c = ep({
      platform: 'spotify',
      id: 's5',
      title: 'The Science of Focus',
      publishedAt: new Date('2026-08-01'),
    });
    expect(matchEpisode(source, 'spotify', [c]).status).toBe('none');
  });

  it('rejects the same title from a different show', () => {
    const c = ep({ platform: 'spotify', id: 's6', showTitle: 'Freakonomics Radio' });
    expect(matchEpisode(source, 'spotify', [c]).status).toBe('none');
  });

  it('cannot reach strong on title and show alone when duration and date are missing', () => {
    const s = ep({ durationSec: null, publishedAt: null });
    const c = ep({ platform: 'spotify', id: 's7', durationSec: null, publishedAt: null });
    const r = matchEpisode(s, 'spotify', [c]);
    expect(r.status).toBe('review');
    expect(r.reviewReason).toBe('low_confidence');
  });

  it('ignores candidates from other platforms and duplicate refs', () => {
    const wrong = ep({ platform: 'youtube', id: 'y9' });
    const c = ep({ platform: 'spotify', id: 's8' });
    const r = matchEpisode(source, 'spotify', [wrong, c, { ...c }]);
    expect(r.candidate?.ref.id).toBe('s8');
    expect(r.alternatives).toHaveLength(0);
  });

  it('handles invalid dates without throwing', () => {
    const c = ep({ platform: 'spotify', id: 's9', publishedAt: new Date('not a date') });
    const s = scoreCandidate(source, c);
    expect(s.evidence.find((e) => e.field === 'published_at')?.result).toBe('missing');
  });
});

describe('buildSearchQuery', () => {
  it('combines show and title, dropping guest suffixes', () => {
    expect(
      buildSearchQuery(
        ep({
          title: 'Fixing Yourself First | Roblox CEO David Baszucki',
          showTitle: 'The Knowledge Project',
        }),
      ),
    ).toBe('The Knowledge Project Fixing Yourself First');
  });
  it('truncates long queries at a word boundary', () => {
    const q = buildSearchQuery(ep({ title: 'word '.repeat(60) }), 50);
    expect(q.length).toBeLessThanOrEqual(50);
    expect(q.endsWith(' ')).toBe(false);
  });
});

describe('findDuplicateGroups', () => {
  it('groups the same episode saved from two sources', () => {
    const groups = findDuplicateGroups([
      { id: 'i1', candidate: ep({ platform: 'youtube', id: 'y1', durationSec: 3560 }) },
      { id: 'i2', candidate: ep({ platform: 'spotify', id: 's1' }) },
      { id: 'i3', candidate: ep({ platform: 'spotify', id: 's2', title: 'The Science of Focus' }) },
    ]);
    expect(groups.get('i1')).not.toBeNull();
    expect(groups.get('i1')).toBe(groups.get('i2'));
    expect(groups.get('i3')).toBeNull();
  });
  it('never groups two different items from the same platform', () => {
    const groups = findDuplicateGroups([
      { id: 'i1', candidate: ep({ platform: 'spotify', id: 's1' }) },
      { id: 'i2', candidate: ep({ platform: 'spotify', id: 's2' }) },
    ]);
    expect(groups.get('i1')).toBeNull();
  });
  it('does not merge an edited cut with the full episode', () => {
    const groups = findDuplicateGroups([
      { id: 'i1', candidate: ep({ platform: 'youtube', id: 'y1', durationSec: 1200 }) },
      { id: 'i2', candidate: ep({ platform: 'spotify', id: 's1' }) },
    ]);
    expect(groups.get('i1')).toBeNull();
  });
});
