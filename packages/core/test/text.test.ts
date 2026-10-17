import { describe, expect, it } from 'vitest';
import {
  decodeEntities,
  normalizeShow,
  normalizeTitle,
  showSimilarity,
  stripHtml,
  titleSimilarity,
} from '../src/text.js';
import { formatClock, parseClockDuration, parseIsoDuration } from '../src/duration.js';

describe('decodeEntities / stripHtml', () => {
  it('decodes named, decimal and hex entities', () => {
    expect(decodeEntities('Tom &amp; Jerry &#8217;s &#x2014; &quot;hi&quot;')).toBe('Tom & Jerry ’s — "hi"');
  });
  it('leaves unknown or invalid entities alone', () => {
    expect(decodeEntities('&bogus; &#0; &#xFFFFFFF;')).toBe('&bogus; &#0; &#xFFFFFFF;');
  });
  it('strips tags and collapses whitespace', () => {
    expect(stripHtml('<p>Hello <b>world</b></p>\n\n<br/>bye')).toBe('Hello world bye');
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['#879: How to Reinvent Yourself', 'how to reinvent yourself'],
    ['Ep. 213: Maps vs Territory', 'maps vs territory'],
    ['691. Is This What a “Good Billionaire” Looks Like?', 'is this what a good billionaire looks like'],
    ['S2 E4: The Pre-Mortem', 'the pre mortem'],
    ['Noise — the error nobody audits (Audio Edition)', 'noise the error nobody audits'],
    ['Why We Sleep | Full Episode', 'why we sleep'],
    ['Feedback that changes behaviour', 'feedback that changes behavior'],
  ])('%s → %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('does not strip a number that is part of the title', () => {
    expect(normalizeTitle('10 Rules for Better Sleep')).toBe('10 rules for better sleep');
  });
});

describe('normalizeShow', () => {
  it('drops subtitles, "The" and generic suffixes', () => {
    expect(normalizeShow("Lenny's Podcast: Product | Career | Growth")).toBe('lennys');
    expect(normalizeShow('The Knowledge Project')).toBe('knowledge project');
  });
});

describe('similarity', () => {
  it('treats format variants of the same title as near-identical', () => {
    expect(
      titleSimilarity('Noise: the error nobody audits', 'Noise — the error nobody audits (Audio)'),
    ).toBeGreaterThan(0.95);
  });
  it('handles a guest list appended after a separator', () => {
    expect(
      titleSimilarity(
        'Make Better Decisions by Fixing Yourself First',
        'Make Better Decisions by Fixing Yourself First | Roblox CEO David Baszucki',
      ),
    ).toBeGreaterThan(0.9);
  });
  it('scores different episodes of the same show low', () => {
    expect(titleSimilarity('Why We Sleep', 'The Science of Focus')).toBeLessThan(0.5);
  });
  it('does not let a one-word title match everything that contains it', () => {
    expect(titleSimilarity('Sleep', 'Sleep, stress and the immune system with Dr X')).toBeLessThan(0.7);
  });
  it('returns 0 for empty input', () => {
    expect(titleSimilarity('', 'anything')).toBe(0);
    expect(showSimilarity('', '')).toBe(0);
  });
  it('matches show names across network suffixes', () => {
    expect(showSimilarity('Afford Anything | Get Smarter With Money', 'Afford Anything')).toBe(1);
  });
});

describe('durations', () => {
  it.each([
    ['PT1H2M3S', 3723],
    ['PT45S', 45],
    ['P1DT1H', 90000],
    ['PT0S', null],
    ['P', null],
    ['PT', null],
    ['garbage', null],
    [undefined, null],
  ])('parseIsoDuration(%s) = %s', (input, expected) => {
    expect(parseIsoDuration(input as string | undefined)).toBe(expected);
  });

  it.each([
    ['3723', 3723],
    [3723, 3723],
    ['62:03', 3723],
    ['1:02:03', 3723],
    ['1:02:03.5', 3724],
    [' 45:07 ', 2707],
    ['1:75', null],
    ['1:2:3:4', null],
    ['abc', null],
    ['', null],
    ['0', null],
    [null, null],
  ])('parseClockDuration(%s) = %s', (input, expected) => {
    expect(parseClockDuration(input as string | number | null)).toBe(expected);
  });

  it('formats clock strings', () => {
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(2707)).toBe('45:07');
  });
});
