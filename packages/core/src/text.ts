/**
 * Text normalisation and similarity for matching. Titles of the same episode differ across
 * platforms in predictable ways: episode-number prefixes, "(Audio)" or "| Full Episode" suffixes,
 * HTML entities, curly quotes, US/UK spelling and guest lists after a separator.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  hellip: '…',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? m;
  });
}

export function stripHtml(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Prefixes like "Ep. 213:", "#879:", "691.", "Episode 12 -", "S2 E4:". */
const EPISODE_PREFIX =
  /^\s*(?:(?:episode|ep)\.?\s*\d+[a-z]?|#\s*\d+|s\d+\s*e\d+|\d{1,4}(?=[.:)\-–—]))\s*[.:)\-–—|]?\s*/i;

/** Suffixes that describe the format, not the content. */
const FORMAT_SUFFIX =
  /\s*[([|–—-]\s*(?:audio(?:\s+only|\s+edition)?|video|full\s+(?:episode|interview|video)|podcast|official|hd|4k|remastered|rebroadcast|replay|encore)\s*[)\]]?\s*$/i;

/** A few US/UK spellings that commonly differ between a show's YouTube and RSS titles. */
const SPELLING: Array<[RegExp, string]> = [
  [/\bbehaviour/g, 'behavior'],
  [/\bcolour/g, 'color'],
  [/\bfavourite/g, 'favorite'],
  [/\borganis/g, 'organiz'],
  [/\brecognis/g, 'recogniz'],
  [/\bcentre\b/g, 'center'],
  [/\bprogramme\b/g, 'program'],
  [/\bdefence\b/g, 'defense'],
  [/\banalys(?=e|ing)/g, 'analyz'],
];

const STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'of',
  'to',
  'in',
  'on',
  'for',
  'with',
  'is',
  'at',
  'by',
]);

export function normalizeText(input: string): string {
  let s = decodeEntities(input).normalize('NFKC').toLowerCase();
  s = s.replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"');
  for (const [re, to] of SPELLING) s = s.replace(re, to);
  s = s.replace(/'s\b/g, 's').replace(/[^\p{L}\p{N}\s]/gu, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Remove numbering and format suffixes, then normalise. Repeats suffix removal for stacked suffixes. */
export function normalizeTitle(title: string): string {
  let t = decodeEntities(title).trim();
  t = t.replace(EPISODE_PREFIX, '');
  for (let i = 0; i < 3; i++) {
    const next = t.replace(FORMAT_SUFFIX, '');
    if (next === t) break;
    t = next;
  }
  return normalizeText(t);
}

/** Show names carry network or host suffixes, e.g. "Lenny's Podcast: Product | Career | Growth". */
export function normalizeShow(name: string): string {
  const base = decodeEntities(name).split(/\s[|–—]\s|:\s/)[0] ?? name;
  return normalizeText(base.replace(/\s+(?:podcast|show|radio)$/i, '').replace(/^the\s+/i, ''));
}

export function tokens(normalized: string): string[] {
  return normalized.split(' ').filter((w) => w.length > 0 && !STOPWORDS.has(w));
}

function bigrams(s: string): Map<string, number> {
  const out = new Map<string, number>();
  const compact = s.replace(/\s+/g, ' ');
  for (let i = 0; i < compact.length - 1; i++) {
    const g = compact.slice(i, i + 2);
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Sørensen–Dice over character bigrams. Robust to small spelling and punctuation differences. */
export function diceCoefficient(a: string, b: string): number {
  if (a === b) return a.length > 0 ? 1 : 0;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a),
    B = bigrams(b);
  let overlap = 0,
    total = 0;
  for (const [g, n] of A) {
    overlap += Math.min(n, B.get(g) ?? 0);
    total += n;
  }
  for (const n of B.values()) total += n;
  return (2 * overlap) / total;
}

/** Share of the shorter title's tokens that appear in the longer one. Handles "Title | Guest Name". */
export function tokenContainment(a: string, b: string): number {
  const ta = new Set(tokens(a)),
    tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  let hit = 0;
  for (const t of small) if (large.has(t)) hit++;
  return hit / small.size;
}

/**
 * Title similarity in 0..1. Takes the stronger of character-level and token-level similarity,
 * but discounts containment when the shorter title is tiny (a one-word title "contains" in everything).
 */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a),
    nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const dice = diceCoefficient(na, nb);
  const minTokens = Math.min(tokens(na).length, tokens(nb).length);
  const containment = tokenContainment(na, nb) * (minTokens >= 4 ? 0.97 : minTokens >= 2 ? 0.85 : 0.5);
  return Math.max(dice, containment);
}

export function showSimilarity(a: string, b: string): number {
  const na = normalizeShow(a),
    nb = normalizeShow(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  return Math.max(diceCoefficient(na, nb), tokenContainment(na, nb) * 0.95);
}
