import type { EpisodeCandidate, Platform } from '../src/types.js';

let seq = 0;

export function ep(
  overrides: Partial<EpisodeCandidate> & { platform?: Platform; id?: string } = {},
): EpisodeCandidate {
  const platform = overrides.platform ?? 'apple';
  const id = overrides.id ?? `id-${++seq}`;
  const { platform: _p, id: _i, ...rest } = overrides;
  return {
    ref: { platform, id, url: `https://example.com/${platform}/${id}` },
    title: 'Why Conversations Go Wrong',
    showTitle: 'Hidden Brain',
    publishedAt: new Date('2026-09-14T08:00:00Z'),
    durationSec: 3534,
    ...rest,
  };
}
