import type { Platform, Popularity } from './types';

export const PLATFORM_NAME: Record<Platform, string> = {
  youtube: 'YouTube',
  spotify: 'Spotify',
  apple: 'Apple Podcasts',
};
export const PLATFORM_SHORT: Record<Platform, string> = { youtube: 'YT', spotify: 'SP', apple: 'AP' };

export function duration(sec: number | null | undefined): string {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}

export function clock(sec: number | null | undefined): string {
  if (!sec) return '—';
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = sec % 60;
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(s).padStart(2, '0')}`;
}

export function date(iso: string | null | undefined): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Source-labelled popularity; missing data is "unavailable", never zero (PRD DISC-03). */
export function popularity(p: Popularity | null | undefined): { label: string; detail: string } | null {
  if (!p) return null;
  if (!p.available || p.value === undefined)
    return { label: 'No public metric', detail: `${PLATFORM_NAME[p.source]} doesn't share one` };
  const kind = p.kind === 'views' ? 'Views' : p.kind === 'chart_rank' ? 'Chart rank' : 'Rating';
  const label =
    p.kind === 'views'
      ? `${Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(p.value)} views`
      : p.kind === 'chart_rank'
        ? `#${p.value}${p.context ? ` in ${p.context}` : ''}`
        : `${p.value.toFixed(1)}★${p.context ? ` · ${p.context}` : ''}`;
  return { label, detail: `${kind} · ${PLATFORM_NAME[p.source]}` };
}

export function initials(name: string): string {
  return name
    .replace(/^The\s+/i, '')
    .split(/[\s&’']+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

/** Apple artwork URLs end in "/600x600bb.jpg"; ask for the size we need. */
export function art(url: string | null | undefined, size = 400): string | null {
  if (!url) return null;
  return url.replace(/\/\d+x\d+bb\.(jpg|png|webp)$/, `/${size}x${size}bb.$1`);
}

export function newKey(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
