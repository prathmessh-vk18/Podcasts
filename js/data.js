/* Builds the working catalog from the real shows and episodes in catalog.js.
   Real: show names, hosts, episode titles, descriptions, durations, dates, artwork, Apple links.
   Simulated for the prototype: where each episode was "discovered", popularity numbers and match results. */

const SOURCES = {
  youtube: { id: 'youtube', name: 'YouTube', short: 'YT', host: 'youtube.com', writable: true },
  spotify: { id: 'spotify', name: 'Spotify', short: 'SP', host: 'open.spotify.com', writable: true },
  apple:   { id: 'apple',   name: 'Apple Podcasts', short: 'AP', host: 'podcasts.apple.com', writable: false },
};

const TOPICS = [
  { id: 'decisions',    name: 'Decision-making',   blurb: 'Judgement, risk and choosing well when you can’t know for sure.' },
  { id: 'psychology',   name: 'Psychology',        blurb: 'Why we do what we do, and how to work with your own mind.' },
  { id: 'health',       name: 'Health',            blurb: 'Sleep, training, nutrition and longevity, from the evidence.' },
  { id: 'money',        name: 'Money',             blurb: 'Investing and personal finance without the noise.' },
  { id: 'business',     name: 'Business',          blurb: 'Founders, operators and how great companies get built.' },
  { id: 'tech',         name: 'AI & Tech',         blurb: 'What new technology can really do, and what it means.' },
  { id: 'science',      name: 'Science',           blurb: 'Curious, rigorous stories about how the world works.' },
  { id: 'productivity', name: 'Focus',             blurb: 'Deep work, attention and building a life that works.' },
  { id: 'creativity',   name: 'Creativity',        blurb: 'Design, music, writing and the craft behind them.' },
];

function hashStr(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* Strip feed-style suffixes so show names read cleanly on cards. */
function shortShowName(n) {
  return n.split(/\s[|–-]\s|\s\(|:\s/)[0].replace(/\s+with\s+.+$/i, '').trim();
}

const SHOW = Object.fromEntries(RAW_SHOWS.map(s => [s.id, { ...s, short: shortShowName(s.name) }]));

const CHART_CATS = { decisions: 'Education', psychology: 'Social Sciences', health: 'Health & Fitness', money: 'Investing', business: 'Business', tech: 'Technology', science: 'Science', productivity: 'Self-Improvement', creativity: 'Arts' };

function simulate(e) {
  const h = hashStr(e.id);
  const show = SHOW[e.show];
  const r = h % 100;
  const source = r < 42 ? 'youtube' : r < 82 ? 'spotify' : 'apple';

  let metric = { type: 'none' };
  const m = (h >>> 8) % 100;
  if (source === 'youtube') {
    const v = 40 + ((h >>> 3) % 3200);
    metric = { type: 'views', label: v >= 1000 ? (v / 1000).toFixed(1) + 'M views' : v + 'K views', age: '2h ago' };
  } else if (source === 'spotify' && m < 60) {
    metric = { type: 'chart', label: `#${1 + (h % 40)} in ${CHART_CATS[show.topic]}`, age: 'today' };
  } else if (source === 'apple' && m < 70) {
    metric = { type: 'rating', label: `${(4.4 + (h % 6) / 10).toFixed(1)}★ · ${1 + (h % 40)}k ratings`, age: '1d ago' };
  }

  const mt = {};
  ['youtube', 'spotify', 'apple'].filter(d => d !== source).forEach((d, i) => {
    const k = (h >>> (5 + i * 7)) % 100;
    mt[d] = k < 34 ? 'x' + (97 + k % 3) : k < 74 ? 's' + (90 + k % 8) : k < 87 ? 'r' + (62 + k % 24) : 'n';
  });

  const kind = (h >>> 12) % 3;
  const review = kind === 0
    ? { title: e.title.replace(/\s*\|.*$/, '') + ' (Audio)', delta: 'Duration differs by 6 min. The other version may be an edited cut.', durDelta: -372 }
    : kind === 1
      ? { title: 'Ep. ' + (100 + h % 400) + ': ' + e.title.replace(/\s*\|.*$/, ''), delta: 'Title format differs. Same show and release date, and the duration matches within a minute.', durDelta: 41 }
      : { title: e.title, delta: 'Release date differs by 2 days. Title and duration match.', durDelta: 12, dateOff: true };

  return { ...e, showName: show.short, host: show.host, topic: show.topic, source, metric, mt, review };
}

const EPISODES = RAW_EPISODES.map(simulate);

/* One conversation saved twice, from two sources, to show duplicate handling. */
(() => {
  const base = EPISODES.find(e => e.topic === 'decisions' && e.source === 'youtube');
  if (!base) return;
  EPISODES.push({ ...base, id: base.id + 'dup', source: 'spotify', dupOf: base.id, dur: base.dur - 30,
    metric: { type: 'chart', label: '#12 in Education', age: 'today' }, mt: { youtube: 'x98', apple: 's95' } });
})();

const EP = Object.fromEntries(EPISODES.map(e => [e.id, e]));

/* Seed collections drawn from the real catalog. */
function pick(topic, n, pred = () => true) {
  return EPISODES.filter(e => e.topic === topic && !e.dupOf && pred(e)).slice(0, n).map(e => e.id);
}
const SEED_COLLECTIONS = (() => {
  const dup = EPISODES.find(e => e.dupOf);
  const reviewEp = EPISODES.find(e => e.topic === 'psychology' && e.source !== 'spotify' && e.mt.spotify?.[0] === 'r');
  const c1 = [...new Set([...pick('decisions', 3), ...pick('psychology', 2), reviewEp?.id, dup?.dupOf, dup?.id].filter(Boolean))];
  return [
    { id: 'c1', name: 'Decisions under uncertainty', desc: 'Start with how we think, end with how we choose.', layout: 'mosaic', tone: 'ink', items: c1, privacy: 'private' },
    { id: 'c2', name: 'Sleep, training, longevity', desc: 'The health basics, from people who study them.', layout: 'single', tone: 'violet', items: pick('health', 5), privacy: 'link' },
    { id: 'c3', name: 'Money, calmly', desc: 'Boring is beautiful.', layout: 'mosaic', tone: 'ink', items: pick('money', 4), privacy: 'private' },
    { id: 'c4', name: 'How things get built', desc: '', layout: 'stack', tone: 'ink', items: pick('business', 4), privacy: 'private' },
  ];
})();

const SEARCH_SUGGESTIONS = ['Decisions', 'Sleep', 'Investing', 'AI', 'Founders'];
