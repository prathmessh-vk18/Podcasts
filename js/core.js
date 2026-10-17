/* State, helpers and shared UI: toasts, modals, the episode drawer, the save popover, cards. */

const STORE_KEY = 'tangent-prototype-v2';
const TOPIC = Object.fromEntries(TOPICS.map(t => [t.id, t]));

function freshState() {
  return {
    collections: JSON.parse(JSON.stringify(SEED_COLLECTIONS)),
    connected: {},
    source: 'all',
    prefs: { reducedMotion: false, simulateFailure: true },
  };
}

let state = (() => {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = Object.assign(freshState(), JSON.parse(raw));
      s.collections.forEach(c => { c.items = c.items.filter(id => EP[id]); });
      return s;
    }
  } catch (e) { /* storage unavailable: run in memory */ }
  return freshState();
})();

function persist() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

/* ---------- helpers ---------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const uid = () => 'c' + Math.random().toString(36).slice(2, 8);

function reducedMotion() {
  return state.prefs.reducedMotion || matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m} min`;
}
function fmtClock(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + String(s).padStart(2, '0');
}
function fmtDate(iso) {
  return new Date(iso + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
function totalDur(ids) { return ids.reduce((a, id) => a + (EP[id]?.dur || 0), 0); }
function sourcesOf(ids) { return [...new Set(ids.map(id => EP[id]?.source).filter(Boolean))]; }

/* Apple links are the real episode pages. YouTube and Spotify open a search for the episode,
   since the prototype doesn't hold their IDs. */
function sourceLink(ep, src = ep.source) {
  const q = encodeURIComponent(`${ep.showName} ${ep.title}`.slice(0, 120));
  if (src === 'apple') return ep.url;
  if (src === 'youtube') return `https://www.youtube.com/results?search_query=${q}`;
  return `https://open.spotify.com/search/${q}/episodes`;
}
function displayUrl(ep) {
  return sourceLink(ep).replace(/^https?:\/\/(www\.)?/, '').replace(/\?uo=4$/, '');
}
function openSource(ep, src) { window.open(sourceLink(ep, src), '_blank', 'noopener'); }

function parseMatch(ep, dest) {
  if (ep.source === dest) return { status: 'native', conf: 100 };
  const code = ep.mt?.[dest] || 'n';
  const kind = { x: 'exact', s: 'strong', r: 'review', n: 'none' }[code[0]];
  return { status: kind, conf: kind === 'none' ? 0 : parseInt(code.slice(1), 10) };
}

function collection(id) { return state.collections.find(c => c.id === id); }
function collectionsWith(epId) { return state.collections.filter(c => c.items.includes(epId)); }
function totalSaved() { return new Set(state.collections.flatMap(c => c.items)).size; }

/* ---------- icons ---------- */
const ICON = {
  search: '<path d="M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm10 2-4.35-4.35"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  arrowL: '<path d="M19 12H5m6 6-6-6 6-6"/>',
  up: '<path d="m6 15 6-6 6 6"/>',
  arrowUp: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  grip: '<circle cx="9" cy="6" r="1.4"/><circle cx="15" cy="6" r="1.4"/><circle cx="9" cy="12" r="1.4"/><circle cx="15" cy="12" r="1.4"/><circle cx="9" cy="18" r="1.4"/><circle cx="15" cy="18" r="1.4"/>',
  ext: '<path d="M14 4h6v6m0-6-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  share: '<path d="M12 3v13m0-13-4 4m4-4 4 4M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  export: '<path d="M4 12h11m0 0-4-4m4 4-4 4M20 4v16"/>',
  trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4"/>',
  lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  alert: '<path d="M12 9v4m0 4h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  retry: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9m0-5v5h-5M20 12a8 8 0 0 1-14 5.3L4 15m0 5v-5h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
  grid: '<rect x="4" y="4" width="7" height="9" rx="1.5"/><rect x="13" y="4" width="7" height="5" rx="1.5"/><rect x="13" y="11" width="7" height="9" rx="1.5"/><rect x="4" y="15" width="7" height="5" rx="1.5"/>',
};
function icon(name, cls = '') {
  return `<svg class="icon ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${ICON[name]}</svg>`;
}

/* ---------- source + metric ---------- */
function sourceTag(src, opts = {}) {
  const s = SOURCES[src];
  return `<span class="src-tag${opts.solid ? ' solid' : ''}">${opts.short ? s.short : s.name}</span>`;
}

function metricBadge(ep, opts = {}) {
  const m = ep.metric;
  if (!m || m.type === 'none') {
    return `<span class="metric metric-none" title="${SOURCES[ep.source].name} doesn’t share a popularity number for this episode">${opts.compact ? 'No public metric' : 'Popularity unavailable'}</span>`;
  }
  const kind = { views: 'Views', chart: 'Chart rank', rating: 'Rating' }[m.type];
  return `<span class="metric" title="${kind} from ${SOURCES[ep.source].name}, fetched ${m.age}. Not comparable across sources.">
    <b>${m.label}</b>${opts.compact ? '' : `<span class="metric-src">${kind} · ${SOURCES[ep.source].name} · ${m.age}</span>`}</span>`;
}

/* ---------- live region + toasts ---------- */
function announce(msg) {
  const lr = $('#live');
  lr.textContent = '';
  requestAnimationFrame(() => { lr.textContent = msg; });
}

function toast(msg, opts = {}) {
  const host = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="toast-icon">${icon(opts.icon || 'check')}</span>
    <span class="toast-msg">${msg}</span>
    ${opts.action ? `<button class="toast-btn">${opts.action}</button>` : ''}
    <button class="toast-x" aria-label="Dismiss">${icon('x')}</button>`;
  host.appendChild(el);
  const kill = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  el.querySelector('.toast-x').onclick = kill;
  if (opts.action) el.querySelector('.toast-btn').onclick = () => { opts.onAction?.(); kill(); };
  setTimeout(kill, opts.duration || (opts.action ? 6500 : 3200));
  return el;
}

/* ---------- modal ---------- */
let modalReturn = null;
function openModal({ title, eyebrow = '', body, actions = '', wide = false, onMount }) {
  closeModal(true);
  modalReturn = document.activeElement;
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal-scrim" data-close></div>
    <div class="modal${wide ? ' modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title">
      <header class="modal-head">
        ${eyebrow ? `<p class="eyebrow">${eyebrow}</p>` : ''}
        <h2 id="modal-title" class="modal-title">${title}</h2>
        <button class="icon-btn modal-x" data-close aria-label="Close">${icon('x')}</button>
      </header>
      <div class="modal-body">${body}</div>
      ${actions ? `<footer class="modal-foot">${actions}</footer>` : ''}
    </div>`;
  document.body.appendChild(wrap);
  document.body.classList.add('locked');
  wrap.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
  requestAnimationFrame(() => wrap.classList.add('in'));
  onMount?.(wrap);
  const first = wrap.querySelector('input, [autofocus], .modal-body button, .modal-foot button');
  (first || wrap.querySelector('.modal-x')).focus();
  return wrap;
}
function closeModal(instant) {
  const wrap = $('.modal-wrap');
  if (!wrap) return;
  if (!$('.drawer-wrap.in')) document.body.classList.remove('locked');
  if (instant) { wrap.remove(); return; }
  wrap.classList.remove('in');
  setTimeout(() => wrap.remove(), 260);
  modalReturn?.focus?.();
}

function confirmModal({ title, body, confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const w = openModal({
      title, body: `<p class="modal-copy">${body}</p>`,
      actions: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-ok>${confirm}</button>`,
    });
    w.querySelector('[data-ok]').onclick = () => { resolve(true); closeModal(); };
    w.addEventListener('click', e => { if (e.target.closest('[data-close]')) resolve(false); });
  });
}

/* ---------- create collection ---------- */
function createCollectionModal({ seedEp = null, seedEps = [], name = '', onCreated } = {}) {
  const items = seedEps.length ? [...seedEps] : seedEp ? [seedEp] : [];
  const draft = { id: 'draft', layout: 'mosaic', tone: 'ink', items };
  const body = `
    <div class="create-grid">
      <div class="cover-preview" id="cv-prev">${collectionCover(draft, 400)}<span class="cover-title" id="cv-title">${esc(name) || 'Untitled collection'}</span></div>
      <div class="create-fields">
        <label class="field"><span class="field-label">Name</span>
          <input class="input" id="cv-name" maxlength="60" placeholder="e.g. Thinking in probabilities" autocomplete="off" value="${esc(name)}"></label>
        <label class="field"><span class="field-label">What are you learning? (optional)</span>
          <input class="input" id="cv-desc" maxlength="120" placeholder="A sentence about the goal" autocomplete="off"></label>
        ${items.length ? `<p class="modal-note">${icon('check')} ${items.length > 1 ? items.length + ' episodes' : '“' + esc(EP[items[0]].title) + '”'} will be added.</p>` : '<p class="modal-note">' + icon('info') + ' The cover builds itself from the episodes you add.</p>'}
      </div>
    </div>`;
  const w = openModal({
    eyebrow: 'New collection', title: 'Start a learning collection', body, wide: true,
    actions: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" id="cv-create" ${name ? '' : 'disabled'}>Create collection</button>`,
  });
  const nameEl = w.querySelector('#cv-name'), btn = w.querySelector('#cv-create');
  nameEl.addEventListener('input', () => {
    w.querySelector('#cv-title').textContent = nameEl.value.trim() || 'Untitled collection';
    btn.disabled = !nameEl.value.trim();
  });
  const submit = () => {
    if (!nameEl.value.trim()) return;
    const col = { id: uid(), name: nameEl.value.trim(), desc: w.querySelector('#cv-desc').value.trim(), layout: 'mosaic', tone: 'ink', items, privacy: 'private' };
    state.collections.unshift(col);
    persist();
    closeModal();
    updateNavBadge();
    onCreated ? onCreated(col) : toast(`Created <b>${esc(col.name)}</b>`, { action: 'Open', onAction: () => go('#/collection/' + col.id) });
  };
  btn.onclick = submit;
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

/* ---------- save list (popover + drawer) ---------- */
function saveListHTML(epId) {
  return `<div class="save-list" data-ep="${epId}">
    <p class="save-list-head">Save to collection</p>
    <ul role="list">
      ${state.collections.map(c => {
        const on = c.items.includes(epId);
        return `<li><button class="save-row${on ? ' on' : ''}" data-save-to="${c.id}" aria-pressed="${on}">
          <span class="save-thumb">${collectionCover(c, 100)}</span>
          <span class="save-name">${esc(c.name)}<small>${c.items.length} episode${c.items.length === 1 ? '' : 's'}</small></span>
          <span class="save-check">${icon(on ? 'check' : 'plus')}</span>
        </button></li>`;
      }).join('')}
    </ul>
    <button class="save-new" data-save-new>${icon('plus')} New collection</button>
  </div>`;
}

function toggleSave(epId, colId, originEl) {
  const c = collection(colId);
  const i = c.items.indexOf(epId);
  if (i >= 0) {
    c.items.splice(i, 1);
    persist();
    toast(`Removed from <b>${esc(c.name)}</b>`, { icon: 'x', action: 'Undo', onAction: () => { c.items.splice(i, 0, epId); persist(); refreshSaveUI(epId); updateNavBadge(); } });
  } else {
    c.items.push(epId);
    persist();
    flyToLibrary(originEl, epId);
    toast(`Saved to <b>${esc(c.name)}</b>`, { action: 'View', onAction: () => go('#/collection/' + c.id) });
  }
  refreshSaveUI(epId);
  updateNavBadge();
}

function refreshSaveUI(epId) {
  $$(`.save-list[data-ep="${epId}"]`).forEach(el => { el.outerHTML = saveListHTML(epId); });
  $$(`[data-saved-ind="${epId}"]`).forEach(el => {
    const n = collectionsWith(epId).length;
    el.classList.toggle('on', n > 0);
    el.setAttribute('aria-label', n ? `Saved in ${n} collection${n > 1 ? 's' : ''}. Change` : 'Save to collection');
    el.innerHTML = icon(n ? 'check' : 'plus');
  });
}

/* Cause and effect: the cover travels to the Library tab. */
function flyToLibrary(fromEl, epId) {
  const target = $$('[data-nav="library"]').find(el => el.offsetParent !== null);
  if (!fromEl || !target || reducedMotion()) { bumpBadge(); return; }
  const a = fromEl.getBoundingClientRect(), b = target.getBoundingClientRect();
  const dot = document.createElement('div');
  dot.className = 'fly-dot';
  dot.innerHTML = coverImg(EP[epId], 100);
  document.body.appendChild(dot);
  const x0 = a.left + a.width / 2 - 22, y0 = a.top + a.height / 2 - 22;
  const x1 = b.left + b.width / 2 - 22, y1 = b.top + b.height / 2 - 22;
  const mx = (x0 + x1) / 2, my = Math.min(y0, y1) - 120;
  const anim = dot.animate([
    { transform: `translate(${x0}px, ${y0}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${x0}px, ${y0 - 30}px) scale(1.1) rotate(-8deg)`, opacity: 1, offset: .18 },
    { transform: `translate(${mx}px, ${my}px) scale(.9) rotate(10deg)`, opacity: 1, offset: .55 },
    { transform: `translate(${x1}px, ${y1}px) scale(.3)`, opacity: .4 },
  ], { duration: 820, easing: 'cubic-bezier(.5,0,.3,1)' });
  anim.onfinish = () => { dot.remove(); bumpBadge(); };
}
function bumpBadge() {
  $$('.nav-badge').forEach(b => { b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); });
}
function updateNavBadge() {
  const n = totalSaved();
  $$('.nav-badge').forEach(b => { b.textContent = n; b.hidden = !n; });
}

/* ---------- popover ---------- */
function openSavePopover(anchor, epId) {
  closePopover();
  const pop = document.createElement('div');
  pop.className = 'popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Save to collection');
  pop.innerHTML = saveListHTML(epId);
  document.body.appendChild(pop);
  const r = anchor.getBoundingClientRect();
  const pw = Math.min(300, innerWidth - 24);
  const left = Math.min(Math.max(12, r.right - pw), innerWidth - pw - 12);
  let top = r.bottom + 8;
  const ph = pop.offsetHeight;
  if (top + ph > innerHeight - 12) top = Math.max(12, r.top - ph - 8);
  Object.assign(pop.style, { left: left + 'px', top: top + 'px', width: pw + 'px' });
  requestAnimationFrame(() => pop.classList.add('in'));
  pop._anchor = anchor;
  pop.querySelector('button')?.focus();
}
function closePopover() {
  const p = $('.popover');
  if (!p) return;
  const a = p._anchor;
  const hadFocus = p.contains(document.activeElement);
  p.remove();
  if (a && document.body.contains(a) && hadFocus) a.focus();
}

/* ---------- episode drawer ---------- */
function openEpisode(epId) {
  const ep = EP[epId];
  if (!ep) return;
  closePopover();
  $('.drawer-wrap')?.remove();
  const dests = Object.keys(SOURCES).filter(s => s !== ep.source);
  const topic = TOPIC[ep.topic];
  const wrap = document.createElement('div');
  wrap.className = 'drawer-wrap';
  wrap._return = document.activeElement;
  wrap.innerHTML = `<div class="drawer-scrim" data-dclose></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="ep-title">
    <button class="icon-btn drawer-x" data-dclose aria-label="Close episode">${icon('x')}</button>
    <div class="drawer-hero">
      <div class="drawer-bg">${coverImg(ep, 100)}</div>
      <div class="drawer-cover">${coverImg(ep, 600)}</div>
    </div>
    <div class="drawer-body">
      <div class="drawer-meta-top">${sourceTag(ep.source, { solid: true })}<a class="topic-link" href="#/topic/${topic.id}">${topic.name}</a></div>
      <h2 id="ep-title" class="drawer-title">${esc(ep.title)}</h2>
      <p class="drawer-show"><b>${esc(ep.showName)}</b> · ${esc(ep.host)}</p>
      <p class="drawer-note">${esc(ep.desc)}</p>
      <dl class="facts">
        <div><dt>Duration</dt><dd>${fmtClock(ep.dur)}</dd></div>
        <div><dt>Published</dt><dd>${fmtDate(ep.date)}</dd></div>
        <div><dt>Topic</dt><dd>${topic.name}</dd></div>
      </dl>

      <section class="d-sec">
        <h3 class="d-h">Popularity <button class="info-tip" aria-label="About popularity numbers" data-tip="Each number comes from one source and is never compared with another source's number.">${icon('info')}</button></h3>
        ${metricBadge(ep)}
      </section>

      <section class="d-sec">
        <h3 class="d-h">Source</h3>
        <div class="source-card">
          <div><p class="source-card-k">Found on ${SOURCES[ep.source].name}</p><code class="source-url">${esc(displayUrl(ep))}</code></div>
          <button class="btn btn-sm btn-ghost" data-open-source="${ep.id}">${icon('ext')} Open</button>
        </div>
        <ul class="avail" role="list">
          ${dests.map(d => {
            const m = parseMatch(ep, d);
            const label = { exact: 'Exact match', strong: 'Likely match', review: 'Possible match, needs review', none: 'Not found' }[m.status];
            return `<li class="avail-row m-${m.status}"><span class="avail-src">${SOURCES[d].name}</span><span class="avail-state"><i></i>${label}${m.conf ? ` <small>${m.conf}%</small>` : ''}</span></li>`;
          }).join('')}
        </ul>
      </section>

      <section class="d-sec d-save">${saveListHTML(ep.id)}</section>
    </div>
  </aside>`;
  document.body.appendChild(wrap);
  document.body.classList.add('locked');
  requestAnimationFrame(() => wrap.classList.add('in'));
  wrap.querySelector('.drawer-x').focus();
  wrap.addEventListener('click', e => { if (e.target.closest('[data-dclose]') || e.target.closest('.topic-link')) closeDrawer(); });
}
function closeDrawer() {
  const w = $('.drawer-wrap');
  if (!w) return;
  w.classList.remove('in');
  if (!$('.modal-wrap')) document.body.classList.remove('locked');
  setTimeout(() => w.remove(), 380);
  if (w._return && document.body.contains(w._return)) w._return.focus();
}

/* ---------- cards ---------- */
function saveFab(ep) {
  const saved = collectionsWith(ep.id).length > 0;
  return `<button class="save-fab${saved ? ' on' : ''}" data-quick-save="${ep.id}" data-saved-ind="${ep.id}" aria-label="${saved ? 'Saved. Change collections' : 'Save to collection'}">${icon(saved ? 'check' : 'plus')}</button>`;
}

/* Rail card. */
function episodeCard(ep, opts = {}) {
  return `<article class="ep-card" data-tilt>
    <button class="card-hit" data-open-ep="${ep.id}" aria-label="${esc(ep.title)}, ${esc(ep.showName)}, on ${SOURCES[ep.source].name}"></button>
    <div class="ep-art">${coverImg(ep, 400)}<span class="ep-dur">${fmtDur(ep.dur)}</span></div>
    <div class="ep-body">
      <div class="ep-top">${sourceTag(ep.source)}${opts.rank ? `<span class="ep-rank">${String(opts.rank).padStart(2, '0')}</span>` : ''}</div>
      <h3 class="ep-title">${esc(ep.title)}</h3>
      <p class="ep-show">${esc(ep.showName)}</p>
      <div class="ep-foot">${metricBadge(ep, { compact: true })}</div>
    </div>
    ${saveFab(ep)}
  </article>`;
}

/* Masonry pin: height varies with title length and whether a description shows. */
function pinCard(ep, i) {
  const withDesc = hashStr(ep.id) % 3 === 0;
  return `<article class="pin" data-tilt style="--i:${i % 12}">
    <button class="card-hit" data-open-ep="${ep.id}" aria-label="${esc(ep.title)}, ${esc(ep.showName)}, on ${SOURCES[ep.source].name}"></button>
    <div class="pin-art">${coverImg(ep, 400)}<span class="ep-dur">${fmtDur(ep.dur)}</span></div>
    <div class="pin-body">
      <h3 class="pin-title">${esc(ep.title)}</h3>
      ${withDesc ? `<p class="pin-desc">${esc(ep.desc)}</p>` : ''}
      <div class="pin-meta"><span class="pin-show">${esc(ep.showName)}</span>${sourceTag(ep.source, { short: true })}</div>
    </div>
    ${saveFab(ep)}
  </article>`;
}

function skeletonCards(n = 4) {
  return Array.from({ length: n }, () => `<div class="ep-card skel"><div class="ep-art sk"></div><div class="ep-body"><i class="sk sk-line w40"></i><i class="sk sk-line w90"></i><i class="sk sk-line w60"></i></div></div>`).join('');
}
function skeletonPin(h) {
  return `<div class="pin skel"><div class="pin-art sk"></div><div class="pin-body"><i class="sk sk-line w90"></i><i class="sk sk-line w60"></i>${h ? '<i class="sk sk-line w40"></i>' : ''}</div></div>`;
}
