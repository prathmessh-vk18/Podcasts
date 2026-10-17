/* Page views. Each returns { html, mount? } and is rendered by the router in app.js. */

function filterBySource(list) {
  return state.source === 'all' ? list : list.filter(e => e.source === state.source);
}

function sourceSwitch() {
  const opts = [['all', 'All sources'], ['youtube', 'YouTube'], ['spotify', 'Spotify'], ['apple', 'Apple Podcasts']];
  return `<div class="seg" role="radiogroup" aria-label="Filter by source">
    <span class="seg-pill" aria-hidden="true"></span>
    ${opts.map(([k, l]) => `<button class="seg-btn${state.source === k ? ' on' : ''}" role="radio" aria-checked="${state.source === k}" data-source="${k}">${l}</button>`).join('')}
  </div>`;
}

function placeSegPill(root = document) {
  $$('.seg', root).forEach(seg => {
    const on = seg.querySelector('.seg-btn.on'), pill = seg.querySelector('.seg-pill');
    if (!on || !pill) return;
    pill.style.width = on.offsetWidth + 'px';
    pill.style.transform = `translateX(${on.offsetLeft}px)`;
  });
}

/* A varied, recent-first trending list: one episode per show. */
const TRENDING = (() => {
  const seen = new Set();
  return [...EPISODES].filter(e => !e.dupOf).sort((a, b) => b.date.localeCompare(a.date))
    .filter(e => (seen.has(e.show) ? false : seen.add(e.show))).slice(0, 16).map(e => e.id);
})();

/* ===================== DISCOVER ===================== */
let discoverQuery = '';

function viewDiscover() {
  const html = `
  <section class="hero" aria-labelledby="hero-title">
    <div class="tunnel" aria-hidden="true">
      <div class="wall wall-l">${tunnelLanes(0)}</div>
      <div class="wall wall-r">${tunnelLanes(1)}</div>
    </div>
    <div class="hero-fog" aria-hidden="true"></div>
    <div class="wrap hero-inner">
      <p class="hero-eyebrow"><span class="live-dot"></span>${EPISODES.filter(e => !e.dupOf).length} episodes from ${RAW_SHOWS.length} shows</p>
      <h1 class="hero-title" id="hero-title">
        <span class="ln"><span>Find your next</span></span>
        <span class="ln"><span>big idea</span></span>
      </h1>
      <p class="hero-sub">Discover episodes across YouTube, Spotify and Apple Podcasts. Save them once, listen anywhere.</p>
      <form class="search" role="search" id="search-form">
        ${icon('search', 'search-ic')}
        <label class="sr-only" for="q">Search episodes, shows, people</label>
        <input id="q" name="q" type="search" autocomplete="off" placeholder="How to make better decisions" value="${esc(discoverQuery)}">
        <button class="search-go${discoverQuery ? ' ready' : ''}" type="submit" aria-label="Search">${icon('arrowUp')}</button>
      </form>
      <div class="suggest" aria-label="Suggested searches">
        ${SEARCH_SUGGESTIONS.map(s => `<button class="chip" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}
      </div>
    </div>
  </section>

  <section id="search-results" class="wrap results" aria-live="polite"></section>

  <section class="wrap sec" aria-labelledby="trend-h">
    <header class="sec-head">
      <div><p class="sec-idx">01 · Trending this week</p>
      <h2 class="sec-title" id="trend-h">What curious people are <em>saving</em></h2></div>
      <div class="rail-nav"><button class="icon-btn" data-rail="-1" aria-label="Scroll left">${icon('arrowL')}</button><button class="icon-btn" data-rail="1" aria-label="Scroll right">${icon('arrow')}</button></div>
    </header>
    <div class="rail" id="trend-rail" tabindex="0" aria-label="Trending episodes"></div>
    <p class="fineprint">${icon('info')} Each number comes from its own source. We don’t rank YouTube views against Spotify chart positions.</p>
  </section>

  <section class="sec explore-sec" aria-labelledby="explore-h" id="explore">
    <div class="wrap">
      <header class="sec-head">
        <div><p class="sec-idx">02 · Explore by idea</p>
        <h2 class="sec-title" id="explore-h">Follow an idea, <em>not a show.</em></h2></div>
        ${sourceSwitch()}
      </header>
    </div>
    <div class="chip-bar" id="chip-bar">
      <div class="wrap chip-bar-inner" role="group" aria-label="Topics">
        <button class="chip on" data-feed-topic="all" aria-pressed="true">All</button>
        ${TOPICS.map(t => `<button class="chip" data-feed-topic="${t.id}" aria-pressed="false">${t.name}</button>`).join('')}
      </div>
    </div>
    <div class="wrap">
      <div class="masonry" id="masonry" aria-label="Episodes"></div>
      <div class="feed-sentinel" id="feed-sentinel" aria-hidden="true"></div>
      <div class="feed-end" id="feed-end" hidden></div>
    </div>
  </section>`;
  return { html, mount: mountDiscover };
}

/* Two walls of real covers that recede to a vanishing point behind the headline. */
function tunnelLanes(side) {
  const seen = new Set();
  const arts = EPISODES.filter(e => !e.dupOf && (seen.has(e.art) ? false : seen.add(e.art)))
    .sort((a, b) => hashStr(a.id + 'tunnel') - hashStr(b.id + 'tunnel'));
  return Array.from({ length: 4 }, (_, l) => {
    const start = (side * 4 + l) * 11;
    const items = Array.from({ length: 11 }, (_, k) => arts[(start + k) % arts.length]);
    const cards = items.map(e => `<span class="tl-card">${coverImg(e, 200)}</span>`).join('');
    return `<div class="lane" style="--dur:${70 + ((l * 17 + side * 9) % 40)}s"><div class="lane-track">${cards}${cards}</div></div>`;
  }).join('');
}

function mountDiscover(root) {
  renderTrending();
  placeSegPill(root);
  initTunnel(root.querySelector('.hero'));
  const q = root.querySelector('#q'), go = root.querySelector('.search-go');
  q.addEventListener('input', () => go.classList.toggle('ready', !!q.value.trim()));
  initFeed();
  if (discoverQuery) runSearch(discoverQuery, false);
  root.querySelector('#search-form').addEventListener('submit', e => {
    e.preventDefault();
    runSearch(root.querySelector('#q').value.trim());
  });
}

function renderTrending() {
  const rail = $('#trend-rail');
  if (!rail) return;
  rail.innerHTML = TRENDING.map((id, i) => episodeCard(EP[id], { rank: i + 1 })).join('');
  initTilt(rail);
}

async function runSearch(q, scroll = true) {
  discoverQuery = q;
  const host = $('#search-results');
  if (!host) return;
  if (!q) { host.innerHTML = ''; host.classList.remove('on'); return; }
  host.classList.add('on');
  host.innerHTML = `<header class="results-head"><div><p class="sec-idx">Searching…</p><h2 class="sec-title">“${esc(q)}”</h2></div></header><div class="result-grid">${skeletonCards(5)}</div>`;
  if (scroll) host.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
  await sleep(reducedMotion() ? 120 : 480);
  if (discoverQuery !== q) return;
  const words = q.toLowerCase().split(/\s+/).filter(w => w.length > 1).map(w => w.replace(/s$/, ''));
  const scored = filterBySource(EPISODES.filter(e => !e.dupOf)).map(e => {
    const title = e.title.toLowerCase(), rest = [e.showName, e.host, e.desc, TOPIC[e.topic].name].join(' ').toLowerCase();
    const score = words.reduce((s, w) => s + (title.includes(w) ? 3 : 0) + (rest.includes(w) ? 1 : 0), 0);
    return { e, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 20).map(x => x.e);
  const srcLabel = state.source === 'all' ? 'all sources' : SOURCES[state.source].name;
  if (!scored.length) {
    host.innerHTML = `<div class="empty">
      <div class="empty-art" aria-hidden="true">${[0, 1, 2, 3, 4].map(i => `<i style="--i:${i}"></i>`).join('')}</div>
      <h2 class="empty-title">No episodes for “${esc(q)}” yet</h2>
      <p>We searched ${srcLabel}. Try a broader idea, or switch sources.</p>
      <div class="suggest">${state.source !== 'all' ? `<button class="chip" data-source="all">Search all sources</button>` : ''}${SEARCH_SUGGESTIONS.slice(0, 3).map(s => `<button class="chip" data-suggest="${s}">${s}</button>`).join('')}</div>
    </div>`;
    return;
  }
  host.innerHTML = `<header class="results-head">
      <div><p class="sec-idx">${scored.length} result${scored.length > 1 ? 's' : ''} · ${srcLabel}</p><h2 class="sec-title">“${esc(q)}”</h2></div>
      <button class="btn btn-ghost btn-sm" data-clear-search>${icon('x')} Clear</button>
    </header>
    <div class="result-grid">${scored.map(e => episodeCard(e)).join('')}</div>`;
  initTilt(host);
  announce(`${scored.length} results for ${q}`);
}

/* ---------- masonry feed with infinite scroll ---------- */
const BATCH = 20;
const feed = { topic: 'all', list: [], next: 0, cols: [], n: 0, loading: false, io: null };

function feedOrder(topic) {
  let list = EPISODES.filter(e => !e.dupOf && (topic === 'all' || e.topic === topic));
  list = filterBySource(list);
  // Deal round-robin across shows so the same cover never sits next to itself.
  const byShow = new Map();
  list.sort((a, b) => hashStr(a.id + topic) - hashStr(b.id + topic))
    .forEach(e => { if (!byShow.has(e.show)) byShow.set(e.show, []); byShow.get(e.show).push(e); });
  const queues = [...byShow.values()];
  const out = [];
  while (queues.some(q => q.length)) queues.forEach(q => { if (q.length) out.push(q.shift()); });
  return out;
}

function colCount(w) { return w >= 1180 ? 5 : w >= 880 ? 4 : w >= 560 ? 3 : 2; }

function buildCols(host) {
  feed.n = colCount(host.clientWidth);
  host.style.setProperty('--cols', feed.n);
  host.innerHTML = Array.from({ length: feed.n }, () => '<div class="m-col"></div>').join('');
  feed.cols = $$('.m-col', host);
}

function placePins(eps, startIdx, animate = true) {
  const tpl = document.createElement('template');
  eps.forEach((e, k) => {
    tpl.innerHTML = pinCard(e, startIdx + k).trim();
    const node = tpl.content.firstElementChild;
    if (!animate) node.classList.add('no-anim');
    const col = feed.cols.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
    col.appendChild(node);
  });
  initTilt($('#masonry'));
}

function initFeed() {
  const host = $('#masonry');
  if (!host) return;
  feed.io?.disconnect();
  feed.list = feedOrder(feed.topic);
  feed.next = 0;
  buildCols(host);
  $('#feed-end').hidden = true;
  $$('[data-feed-topic]').forEach(b => { const on = b.dataset.feedTopic === feed.topic; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
  loadMore(true);
  feed.io = new IntersectionObserver(([en]) => { if (en.isIntersecting) loadMore(); }, { rootMargin: '900px 0px' });
  feed.io.observe($('#feed-sentinel'));
}

async function loadMore(first = false) {
  if (feed.loading || !$('#masonry')) return;
  if (feed.next >= feed.list.length) { showFeedEnd(); return; }
  feed.loading = true;
  const list = feed.list;
  if (!first) {
    feed.cols.forEach((c, i) => c.insertAdjacentHTML('beforeend', skeletonPin(i % 2)));
    await sleep(reducedMotion() ? 60 : 520);
    $$('#masonry .pin.skel').forEach(s => s.remove());
  }
  if (list !== feed.list || !$('#masonry')) { feed.loading = false; return; }
  const batch = list.slice(feed.next, feed.next + BATCH);
  placePins(batch, feed.next);
  feed.next += batch.length;
  feed.loading = false;
  if (feed.next >= list.length) showFeedEnd();
  else {
    // Keep filling if the sentinel is still near the viewport (tall screens).
    const s = $('#feed-sentinel').getBoundingClientRect();
    if (s.top < innerHeight + 900) loadMore();
  }
}

function showFeedEnd() {
  const end = $('#feed-end');
  if (!end) return;
  const topic = feed.topic === 'all' ? '' : ` in ${TOPIC[feed.topic].name}`;
  end.hidden = false;
  end.innerHTML = feed.list.length
    ? `<span></span><p>That’s all ${feed.list.length} episodes${topic}${state.source !== 'all' ? ' from ' + SOURCES[state.source].name : ''}.</p><button class="btn btn-ghost btn-sm" data-to-top>${icon('up')} Back to top</button>`
    : `<p>Nothing${topic} from ${SOURCES[state.source].name} yet.</p><button class="btn btn-ghost btn-sm" data-source="all">Show all sources</button>`;
}

function setFeedTopic(topic) {
  if (feed.topic === topic) return;
  feed.topic = topic;
  const host = $('#masonry');
  const swap = () => {
    const bar = $('#chip-bar');
    const stuck = bar && bar.getBoundingClientRect().top < 90;
    initFeed();
    host.classList.remove('swapping');
    if (stuck) window.scrollTo({ top: bar.offsetTop - 70, behavior: 'auto' });
  };
  if (reducedMotion()) return swap();
  host.classList.add('swapping');
  setTimeout(swap, 200);
}

function relayoutFeed() {
  const host = $('#masonry');
  if (!host || colCount(host.clientWidth) === feed.n) return;
  const shown = feed.list.slice(0, feed.next);
  buildCols(host);
  placePins(shown, 0, false);
}

/* ===================== TOPICS INDEX ===================== */
function topicShows(id) { return RAW_SHOWS.filter(s => s.topic === id).map(s => SHOW[s.id]); }

function viewTopics() {
  const html = `
  <section class="wrap page-head">
    <p class="sec-idx">Explore topics</p>
    <h1 class="page-title">Every topic is <em>a door.</em></h1>
    <p class="page-lede">${TOPICS.length} learning areas across ${RAW_SHOWS.length} shows. Pick one to see its shows, a suggested listening order and every episode.</p>
  </section>
  <section class="wrap">
    <ol class="topic-index">
      ${TOPICS.map((t, i) => {
        const shows = topicShows(t.id);
        const n = EPISODES.filter(e => e.topic === t.id && !e.dupOf).length;
        return `<li><a class="ti-row" href="#/topic/${t.id}">
          <span class="ti-num">${String(i + 1).padStart(2, '0')}</span>
          <span class="ti-name">${t.name}</span>
          <span class="ti-thumbs" aria-hidden="true">${shows.slice(0, 4).map((s, j) => `<i style="--j:${j}">${coverImg(s, 100)}</i>`).join('')}</span>
          <span class="ti-meta">${n} episodes<br>${shows.length} shows</span>
          <span class="ti-arrow">${icon('arrow')}</span>
        </a></li>`;
      }).join('')}
    </ol>
  </section>
  ${footer()}`;
  return { html };
}

/* ===================== TOPIC PAGE ===================== */
let topicSelection = new Set();

function viewTopic(id, query) {
  const t = TOPIC[id];
  if (!t) return viewNotFound();
  topicSelection = new Set();
  const shows = topicShows(id);
  const activeShow = query.get('show') || 'all';
  const all = EPISODES.filter(e => e.topic === id && !e.dupOf);
  const seen = new Set();
  const path = all.filter(e => (seen.has(e.show) ? false : seen.add(e.show))).slice(0, 3);
  const steps = ['Start here', 'Go deeper', 'Put it to work'];
  const html = `
  <section class="topic-hero">
    <div class="wrap topic-hero-inner">
      <div class="topic-hero-copy">
        <a class="back-link" href="#/topics">${icon('arrowL')} All topics</a>
        <p class="sec-idx">Topic · ${all.length} episodes · ${shows.length} shows</p>
        <h1 class="topic-title">${t.name}</h1>
        <p class="topic-blurb">${t.blurb}</p>
      </div>
      <div class="topic-covers" aria-hidden="true">${shows.slice(0, 4).map((s, i) => `<div class="tc tc${i}">${coverImg(s, 400)}</div>`).join('')}</div>
    </div>
  </section>

  ${path.length >= 2 ? `<section class="wrap sec path-sec" aria-labelledby="path-h">
    <header class="sec-head"><div><p class="sec-idx">Curated path</p><h2 class="sec-title" id="path-h">A suggested <em>listening order</em></h2></div>
      <button class="btn btn-ghost" data-save-path="${id}">${icon('plus')} Save path as collection</button></header>
    <ol class="path">
      ${path.map((e, i) => `<li class="path-step">
        <span class="path-k">${String(i + 1).padStart(2, '0')} · ${steps[i]}</span>
        <button class="path-card" data-open-ep="${e.id}">
          <span class="path-art">${coverImg(e, 400)}</span>
          <span class="path-txt"><b>${esc(e.title)}</b><small>${esc(e.showName)} · ${fmtDur(e.dur)}</small></span>
        </button></li>`).join('')}
    </ol>
  </section>` : ''}

  <section class="wrap sec" aria-labelledby="all-h">
    <header class="sec-head sec-head-tight">
      <div><p class="sec-idx">All episodes</p><h2 class="sec-title" id="all-h">Everything in <em>${t.name}</em></h2></div>
      ${sourceSwitch()}
    </header>
    <div class="chips-row" role="group" aria-label="Shows">
      <button class="chip${activeShow === 'all' ? ' on' : ''}" data-show="all" aria-pressed="${activeShow === 'all'}">All shows</button>
      ${shows.map(s => `<button class="chip chip-show${activeShow === s.id ? ' on' : ''}" data-show="${s.id}" aria-pressed="${activeShow === s.id}"><span class="chip-cover">${coverImg(s, 100)}</span>${esc(s.short)}</button>`).join('')}
    </div>
    <div id="topic-list" class="ep-rows" data-topic="${id}" data-active-show="${esc(activeShow)}"></div>
  </section>

  <div class="select-bar" id="select-bar" aria-live="polite">
    <span class="select-count"><b>0</b> selected</span>
    <button class="btn btn-ghost btn-sm" data-clear-select>Clear</button>
    <button class="btn btn-primary btn-sm" data-add-selected>${icon('plus')} Add to collection</button>
  </div>
  ${footer()}`;
  return { html, mount: () => { placeSegPill(); renderTopicList(); } };
}

function renderTopicList() {
  const host = $('#topic-list');
  if (!host) return;
  const id = host.dataset.topic, show = host.dataset.activeShow;
  let list = EPISODES.filter(e => e.topic === id && !e.dupOf);
  if (show !== 'all') list = list.filter(e => e.show === show);
  list = filterBySource(list);
  if (!list.length) {
    host.innerHTML = `<div class="empty empty-sm"><h3 class="empty-title">Nothing from this source</h3>
      <p>No episodes here from ${state.source === 'all' ? 'any source' : SOURCES[state.source].name} yet.</p>
      <div class="suggest"><button class="chip" data-source="all">Show all sources</button>${show !== 'all' ? '<button class="chip" data-show="all">All shows</button>' : ''}</div></div>`;
    return;
  }
  host.innerHTML = list.map((e, i) => {
    const sel = topicSelection.has(e.id);
    const saved = collectionsWith(e.id).length > 0;
    return `<div class="ep-row${sel ? ' sel' : ''}" style="--i:${Math.min(i, 14)}">
      <label class="check" title="Select for bulk add">
        <input type="checkbox" data-select-ep="${e.id}" ${sel ? 'checked' : ''} aria-label="Select ${esc(e.title)}"><span class="check-box">${icon('check')}</span>
      </label>
      <button class="ep-row-main" data-open-ep="${e.id}">
        <span class="ep-row-art">${coverImg(e, 100)}</span>
        <span class="ep-row-txt"><b>${esc(e.title)}</b><small>${esc(e.showName)} · ${fmtDate(e.date)}</small></span>
      </button>
      <span class="ep-row-src">${sourceTag(e.source)}</span>
      <span class="ep-row-metric">${metricBadge(e, { compact: true })}</span>
      <span class="ep-row-dur">${fmtDur(e.dur)}</span>
      <button class="icon-btn save-ind${saved ? ' on' : ''}" data-quick-save="${e.id}" data-saved-ind="${e.id}" aria-label="${saved ? 'Saved. Change collections' : 'Save to collection'}">${icon(saved ? 'check' : 'plus')}</button>
    </div>`;
  }).join('');
}

function updateSelectBar() {
  const bar = $('#select-bar');
  if (!bar) return;
  bar.classList.toggle('on', topicSelection.size > 0);
  bar.querySelector('b').textContent = topicSelection.size;
}

function addSelectedModal(ids) {
  const body = `<p class="modal-copy">Add ${ids.length} episode${ids.length > 1 ? 's' : ''} to:</p>
    <ul class="pick-list" role="list">${state.collections.map(c => `<li><button class="save-row" data-bulk-to="${c.id}">
      <span class="save-thumb">${collectionCover(c, 100)}</span><span class="save-name">${esc(c.name)}<small>${c.items.length} episodes</small></span><span class="save-check">${icon('arrow')}</span></button></li>`).join('')}</ul>
    <button class="save-new" data-bulk-new>${icon('plus')} New collection with these</button>`;
  const w = openModal({ eyebrow: 'Bulk add', title: 'Add to collection', body });
  w.addEventListener('click', e => {
    const to = e.target.closest('[data-bulk-to]');
    if (to) {
      const c = collection(to.dataset.bulkTo);
      const added = ids.filter(id => !c.items.includes(id));
      c.items.push(...added);
      persist(); closeModal(); updateNavBadge(); bumpBadge();
      topicSelection.clear(); renderTopicList(); updateSelectBar();
      const skipped = ids.length - added.length;
      toast(`Added ${added.length} to <b>${esc(c.name)}</b>${skipped ? ` · ${skipped} already there` : ''}`, { action: 'Arrange', onAction: () => go('#/collection/' + c.id) });
    }
    if (e.target.closest('[data-bulk-new]')) {
      createCollectionModal({ seedEps: ids, onCreated: c => {
        topicSelection.clear(); renderTopicList(); updateSelectBar(); bumpBadge();
        toast(`Created <b>${esc(c.name)}</b> with ${ids.length} episodes`, { action: 'Arrange', onAction: () => go('#/collection/' + c.id) });
      } });
    }
  });
}

/* ===================== LIBRARY ===================== */
function viewLibrary() {
  const cols = state.collections;
  const allIds = [...new Set(cols.flatMap(c => c.items))];
  const dups = allIds.filter(id => EP[id].dupOf && allIds.includes(EP[id].dupOf));
  const recent = [...allIds].reverse().slice(0, 6);
  const html = `
  <section class="wrap page-head lib-head">
    <div>
      <p class="sec-idx">My library</p>
      <h1 class="page-title">Your <em>library</em></h1>
    </div>
    <dl class="lib-stats">
      <div><dt>Collections</dt><dd>${cols.length}</dd></div>
      <div><dt>Episodes</dt><dd>${allIds.length}</dd></div>
      <div><dt>Listening</dt><dd>${Math.round(totalDur(allIds) / 3600)}<small>h</small></dd></div>
      <div><dt>Sources</dt><dd>${sourcesOf(allIds).length}</dd></div>
    </dl>
  </section>

  ${dups.length ? `<section class="wrap"><div class="notice">
    <span class="notice-ic">${icon('copy')}</span>
    <div><b>${dups.length} episode${dups.length === 1 ? ' is' : 's are'} saved from two sources</b><p>“${esc(EP[dups[0]].title)}” is in your library from both ${SOURCES[EP[EP[dups[0]].dupOf].source].name} and ${SOURCES[EP[dups[0]].source].name}. You can keep both. When you export, we’ll only add it once.</p></div>
    <a class="btn btn-sm btn-ghost" href="#/collection/${cols.find(c => c.items.includes(dups[0]))?.id}">Review</a>
  </div></section>` : ''}

  <section class="wrap sec shelf-sec" aria-label="Collections">
    ${cols.length ? `<div class="shelf">
      ${cols.map((c, i) => collectionTile(c, i)).join('')}
      <button class="tile-new" data-new-collection><span>${icon('plus')}</span><b>New collection</b><small>Group episodes around something you want to learn</small></button>
    </div>` : `<div class="empty">
      <div class="empty-art" aria-hidden="true">${[0, 1, 2, 3, 4].map(i => `<i style="--i:${i}"></i>`).join('')}</div>
      <h2 class="empty-title">Your library is empty</h2>
      <p>Collections are where your learning lives. Start one, then save episodes from anywhere.</p>
      <div class="btn-row center"><button class="btn btn-primary" data-new-collection>${icon('plus')} New collection</button><a class="btn btn-ghost" href="#/">Discover episodes</a></div>
    </div>`}
  </section>

  ${recent.length ? `<section class="wrap sec" aria-labelledby="recent-h">
    <header class="sec-head sec-head-tight"><div><p class="sec-idx">Recently added</p><h2 class="sec-title" id="recent-h">Fresh in your <em>library</em></h2></div></header>
    <div class="ep-rows compact">
      ${recent.map((id, i) => { const e = EP[id]; const where = collectionsWith(id); return `<div class="ep-row" style="--i:${i}">
        <button class="ep-row-main" data-open-ep="${e.id}">
          <span class="ep-row-art">${coverImg(e, 100)}</span>
          <span class="ep-row-txt"><b>${esc(e.title)}</b><small>${esc(e.showName)}</small></span>
        </button>
        <span class="ep-row-src">${sourceTag(e.source)}</span>
        <span class="ep-row-in">in ${where.map(c => `<a href="#/collection/${c.id}">${esc(c.name)}</a>`).join(', ')}</span>
        <span class="ep-row-dur">${fmtDur(e.dur)}</span>
      </div>`; }).join('')}
    </div>
  </section>` : ''}
  ${footer()}`;
  return { html, mount: root => initTilt(root) };
}

function collectionTile(c, i) {
  return `<a class="tile" href="#/collection/${c.id}" data-tilt>
    <div class="tile-cover">${collectionCover(c, i === 0 ? 600 : 400)}</div>
    <div class="tile-body">
      <h3 class="tile-title">${esc(c.name)}</h3>
      <p class="tile-meta">${c.items.length} episode${c.items.length === 1 ? '' : 's'} · ${fmtDur(totalDur(c.items))}</p>
      <div class="tile-foot"><span class="tile-srcs">${sourcesOf(c.items).map(s => SOURCES[s].short).join(' · ')}</span>
      <span class="tile-privacy">${icon(c.privacy === 'private' ? 'lock' : 'globe')}${c.privacy === 'private' ? 'Private' : 'Link'}</span></div>
    </div>
  </a>`;
}

/* ===================== misc ===================== */
function viewNotFound() {
  return { html: `<section class="wrap page-head"><p class="sec-idx">404</p><h1 class="page-title">Lost the <em>thread.</em></h1>
    <p class="page-lede">This page doesn’t exist, or the collection was deleted.</p><div class="btn-row"><a class="btn btn-primary" href="#/">Back to Discover</a><a class="btn btn-ghost" href="#/library">My library</a></div></section>` };
}

function footer() {
  return `<footer class="site-foot">
    <div class="wrap foot-inner">
      <div class="foot-brand">${brandMark()}<p>Find anywhere. Curate once. Listen anywhere supported.</p></div>
      <div class="foot-col"><h4>About the numbers</h4><p>Views come from YouTube, chart positions from Spotify and ratings from Apple Podcasts. Each is labelled with its source and when we fetched it, and they’re never ranked against each other.</p></div>
      <div class="foot-col"><h4>Prototype</h4><p>Shows, episodes and artwork are real, from Apple Podcasts. Sources, popularity numbers and match results are simulated. No accounts are connected.</p></div>
    </div>
  </footer>`;
}

function brandMark() {
  return `<span class="brand"><svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><circle cx="13" cy="17" r="9.5" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M4 7.5 30 7.5" stroke="var(--primary)" stroke-width="2.4" stroke-linecap="round"/><circle cx="13" cy="7.5" r="3" fill="var(--primary)"/></svg><span class="brand-word">tangent</span></span>`;
}
