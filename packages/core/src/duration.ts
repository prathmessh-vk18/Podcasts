/**
 * Duration parsing for the formats providers actually send:
 * - ISO 8601 (YouTube): "PT1H2M3S", "P1DT2H", "PT45S"
 * - itunes:duration (RSS): "3723", "62:03", "1:02:03", sometimes "1:02:03.500" or with spaces
 * Returns whole seconds, or null when the value is missing or nonsense. Never throws.
 */

const ISO = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i;

/** Longer than this is almost certainly a data error (livestream archives can be long, so be generous). */
const MAX_REASONABLE_SEC = 7 * 24 * 3600;

function clamp(sec: number): number | null {
  if (!Number.isFinite(sec) || sec <= 0 || sec > MAX_REASONABLE_SEC) return null;
  return Math.round(sec);
}

export function parseIsoDuration(input: string | null | undefined): number | null {
  if (!input) return null;
  const m = ISO.exec(input.trim());
  if (!m || input.trim() === 'P' || input.trim().toUpperCase() === 'PT') return null;
  const [, d, h, min, s] = m;
  return clamp(Number(d ?? 0) * 86400 + Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0));
}

export function parseClockDuration(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return clamp(input);
  const s = input.trim();
  if (!s) return null;
  if (/^\d+(?:\.\d+)?$/.test(s)) return clamp(Number(s));
  const parts = s.split(':').map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !/^\d+(?:\.\d+)?$/.test(p))) return null;
  const nums = parts.map(Number);
  const [a = 0, b = 0, c = 0] = nums;
  const sec = nums.length === 3 ? a * 3600 + b * 60 + c : a * 60 + b;
  // Reject "1:75" style values where minutes/seconds overflow.
  if (nums.slice(1).some((n) => n >= 60)) return null;
  return clamp(sec);
}

/** "1:02:03" or "45:07" for display and match explanations. */
export function formatClock(sec: number): string {
  const h = Math.floor(sec / 3600),
    m = Math.floor((sec % 3600) / 60),
    s = Math.round(sec % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}
