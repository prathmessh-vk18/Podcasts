/* Router, navigation, signature effects and global event wiring. */

const ROUTES = [
  [/^\/?$/, () => viewDiscover(), 'discover'],
  [/^\/topics$/, () => viewTopics(), 'topics'],
  [/^\/topic\/(\w+)$/, (m, q) => viewTopic(m[1], q), 'topics'],
  [/^\/library$/, () => viewLibrary(), 'library'],
  [/^\/collection\/(\w+)$/, m => viewCollection(m[1]), 'library'],
  [/^\/export\/(\w+)$/, (m, q) => viewExport(m[1], q), 'library'],
  [/^\/shared\/(\w+)$/, m => viewShared(m[1]), ''],
];

let heroCleanup = null;
let lastPath = null;

function go(hash) { location.hash = hash; }

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: new URLSearchParams(qs || '') };
}

function render() {
  const { path, query } = parseHash();
  let view = null, nav = '';
  for (const [re, fn, n] of ROUTES) {
    const m = path.match(re);
    if (m) { view = fn(m, query); nav = n; break; }
  }
  if (!view) view = viewNotFound();
  const samePage = path === lastPath;
  lastPath = path;

  const apply = () => {
    heroCleanup?.(); heroCleanup = null;
    feed.io?.disconnect();
    closePopover();
    closeDrawer();
    const main = $('#main');
    main.innerHTML = view.html;
    main.dataset.route = nav || 'shared';
    document.body.dataset.route = path.split('/')[1] || 'discover';
    setActiveNav(nav);
    if (!samePage) window.scrollTo(0, 0);
    view.mount?.(main);
    revealOnScroll(main);
    document.title = pageTitle(path);
  };

  if (document.startViewTransition && !reducedMotion() && !samePage) {
    const vt = document.startViewTransition(apply);
    // A transition interrupted by fast navigation rejects; the DOM update still applies.
    [vt.ready, vt.finished, vt.updateCallbackDone].forEach(p => p.catch(() => {}));
  } else apply();
}

function pageTitle(path) {
  const seg = path.split('/')[1];
  const map = { '': 'Discover', topics: 'Topics', topic: 'Topic', library: 'Library', collection: 'Collection', export: 'Export', shared: 'Shared collection' };
  return `Tangent · ${map[seg] ?? 'Discover'}`;
}

function setActiveNav(nav) {
  $$('[data-nav]').forEach(a => {
    const on = a.dataset.nav === nav;
    a.classList.toggle('on', on);
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  });
  const pill = $('.nav-pill');
  const on = $('.nav-tabs [data-nav].on');
  if (pill) {
    if (on) { pill.style.opacity = 1; pill.style.width = on.offsetWidth + 'px'; pill.style.transform = `translateX(${on.offsetLeft}px)`; }
    else pill.style.opacity = 0;
  }
}

/* ---------- reveal ---------- */
function revealOnScroll(root) {
  const els = $$('.sec-head, .rail, .chip-bar, .shelf > *, .path-step, .topic-index li, .shared-item, .cta-band', root);
  if (reducedMotion() || !('IntersectionObserver' in window)) return;
  els.forEach(el => el.classList.add('reveal'));
  const io = new IntersectionObserver(entries => entries.forEach(en => {
    if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); }
  }), { rootMargin: '0px 0px -8% 0px' });
  els.forEach((el, i) => { el.style.setProperty('--ri', i % 6); io.observe(el); });
}

/* ---------- hero cover tunnel ---------- */
function initTunnel(hero) {
  if (!hero) return;
  const tunnel = hero.querySelector('.tunnel');
  // Pause the lanes when the hero is off screen.
  const io = new IntersectionObserver(([en]) => tunnel.classList.toggle('paused', !en.isIntersecting));
  io.observe(hero);
  let onMove = null;
  if (!reducedMotion() && matchMedia('(pointer: fine)').matches) {
    onMove = e => {
      const r = hero.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      tunnel.style.perspectiveOrigin = `${50 + x * 14}% ${46 + y * 12}%`;
    };
    hero.addEventListener('pointermove', onMove);
  }
  const prev = heroCleanup;
  heroCleanup = () => { prev?.(); io.disconnect(); };
}

/* ---------- card tilt ---------- */
function initTilt(root) {
  if (reducedMotion() || !matchMedia('(pointer: fine)').matches) return;
  $$('.ep-card:not(.skel), [data-tilt]', root).forEach(card => {
    if (card._tilt) return;
    card._tilt = true;
    card.addEventListener('pointermove', e => {
      const r = card.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - .5, y = (e.clientY - r.top) / r.height - .5;
      card.style.setProperty('--rx', (-y * 7).toFixed(2) + 'deg');
      card.style.setProperty('--ry', (x * 9).toFixed(2) + 'deg');
      card.style.setProperty('--mx', ((x + .5) * 100).toFixed(1) + '%');
      card.style.setProperty('--my', ((y + .5) * 100).toFixed(1) + '%');
    });
    card.addEventListener('pointerleave', () => { card.style.setProperty('--rx', '0deg'); card.style.setProperty('--ry', '0deg'); });
  });
}

/* ---------- source filter ---------- */
function setSource(src) {
  if (state.source === src) return;
  state.source = src; persist();
  $$('.seg-btn').forEach(b => { const on = b.dataset.source === src; b.classList.toggle('on', on); b.setAttribute('aria-checked', on); });
  placeSegPill();
  const swap = () => {
    if ($('#masonry')) initFeed();
    renderTopicList();
    if (discoverQuery && $('#search-results')) runSearch(discoverQuery, false);
  };
  const targets = $$('#masonry, #topic-list');
  if (reducedMotion()) { swap(); return; }
  targets.forEach(t => t.classList.add('swapping'));
  setTimeout(() => { swap(); targets.forEach(t => { t.classList.remove('swapping'); t.classList.add('swapped'); setTimeout(() => t.classList.remove('swapped'), 500); }); }, 180);
  announce(src === 'all' ? 'Showing all sources' : `Showing ${SOURCES[src].name} only`);
}

/* ---------- prototype panel ---------- */
function protoPanel() {
  const p = state.prefs;
  return `<div class="proto-panel" id="proto-panel" role="dialog" aria-label="Prototype controls" hidden>
    <p class="proto-k">Prototype controls</p>
    <label class="switch proto-row"><span class="switch-l">Reduce motion</span><input type="checkbox" data-pref="reducedMotion" ${p.reducedMotion ? 'checked' : ''}><span class="switch-ui"></span></label>
    <label class="switch proto-row"><span class="switch-l">Simulate a failed export item</span><input type="checkbox" data-pref="simulateFailure" ${p.simulateFailure ? 'checked' : ''}><span class="switch-ui"></span></label>
    <p class="proto-k">Test journeys</p>
    <div class="proto-links">
      <a href="#/">1 · Discover → save</a>
      <a href="#/topic/decisions">2 · Topic → bulk add</a>
      <a href="#/export/c1?fresh=1">3 · Export a collection</a>
      <a href="#/shared/c2">4 · Shared collection</a>
    </div>
    <button class="btn btn-sm btn-ghost btn-block" data-reset>${icon('retry')} Reset demo data</button>
  </div>`;
}

function applyPrefs() {
  document.documentElement.classList.toggle('reduce-motion', !!state.prefs.reducedMotion);
}

/* ---------- global events ---------- */
document.addEventListener('click', e => {
  const t = e.target;

  // popover: close on outside click
  if ($('.popover') && !t.closest('.popover') && !t.closest('[data-quick-save]')) closePopover();

  if (handleExportClick(e)) return;

  const q = t.closest('[data-quick-save]');
  if (q) { e.preventDefault(); e.stopPropagation(); const open = $('.popover'); if (open && open._anchor === q) closePopover(); else openSavePopover(q, q.dataset.quickSave); return; }

  const saveTo = t.closest('[data-save-to]');
  if (saveTo) { toggleSave(saveTo.closest('[data-ep]').dataset.ep, saveTo.dataset.saveTo, saveTo); return; }

  if (t.closest('[data-save-new]')) {
    const epId = t.closest('[data-ep]').dataset.ep;
    closePopover();
    createCollectionModal({ seedEp: epId, onCreated: c => { refreshSaveUI(epId); bumpBadge(); toast(`Saved to new collection <b>${esc(c.name)}</b>`, { action: 'View', onAction: () => go('#/collection/' + c.id) }); } });
    return;
  }

  const open = t.closest('[data-open-ep]');
  if (open) { openEpisode(open.dataset.openEp); return; }

  const src = t.closest('[data-source]');
  if (src) { setSource(src.dataset.source); return; }

  const ft = t.closest('[data-feed-topic]');
  if (ft) { setFeedTopic(ft.dataset.feedTopic); return; }
  if (t.closest('[data-to-top]')) { window.scrollTo({ top: $('#explore')?.offsetTop || 0, behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }

  const sug = t.closest('[data-suggest]');
  if (sug) {
    const qv = sug.dataset.suggest;
    if (!$('#search-results')) { discoverQuery = qv; go('#/'); return; }
    $('#q').value = qv; runSearch(qv); return;
  }
  if (t.closest('[data-clear-search]')) { $('#q').value = ''; runSearch(''); return; }

  const rail = t.closest('[data-rail]');
  if (rail) { const r = $('#trend-rail'); r.scrollBy({ left: Number(rail.dataset.rail) * r.clientWidth * .8, behavior: reducedMotion() ? 'auto' : 'smooth' }); return; }

  const show = t.closest('[data-show]');
  if (show && $('#topic-list')) {
    $('#topic-list').dataset.activeShow = show.dataset.show;
    $$('.chips-row [data-show]').forEach(b => { const on = b.dataset.show === show.dataset.show; b.classList.toggle('on', on); b.setAttribute('aria-pressed', on); });
    renderTopicList(); return;
  }
  if (t.closest('[data-clear-select]')) { topicSelection.clear(); renderTopicList(); updateSelectBar(); return; }
  if (t.closest('[data-add-selected]')) { addSelectedModal([...topicSelection]); return; }
  const sp = t.closest('[data-save-path]');
  if (sp) {
    const tp = TOPIC[sp.dataset.savePath];
    const ids = $$('.path-card').map(b => b.dataset.openEp);
    createCollectionModal({ seedEps: ids, name: `${tp.name}: the path`, onCreated: c => { bumpBadge(); toast(`Saved the ${tp.name} path as <b>${esc(c.name)}</b>`, { action: 'Arrange', onAction: () => go('#/collection/' + c.id) }); } });
    return;
  }

  if (t.closest('[data-new-collection]')) { createCollectionModal({ onCreated: c => go('#/collection/' + c.id) }); return; }
  if (t.closest('[data-edit-cover]')) { const id = parseHash().path.split('/')[2]; coverBuilder(collection(id)); return; }
  const sh = t.closest('[data-share]');
  if (sh) { shareModal(collection(sh.dataset.share)); return; }
  const pv = t.closest('[data-privacy]');
  if (pv) { shareModal(collection(pv.dataset.privacy)); return; }
  const del = t.closest('[data-delete-col]');
  if (del) {
    const c = collection(del.dataset.deleteCol);
    confirmModal({ title: `Delete “${esc(c.name)}”?`, body: `The collection and its order will be removed. The ${c.items.length} episodes stay available in Discover. Playlists you’ve already exported won’t change.`, confirm: 'Delete collection', danger: true })
      .then(ok => {
        if (!ok) return;
        const idx = state.collections.indexOf(c);
        state.collections.splice(idx, 1); persist(); updateNavBadge();
        go('#/library');
        toast(`Deleted <b>${esc(c.name)}</b>`, { icon: 'trash', action: 'Undo', onAction: () => { state.collections.splice(idx, 0, c); persist(); updateNavBadge(); render(); } });
      });
    return;
  }

  const cs = t.closest('[data-copy-shared]');
  if (cs) { copyCollectionToLibrary(collection(cs.dataset.copyShared)); return; }
  const cl = t.closest('[data-copy-links]');
  if (cl) {
    const c = collection(cl.dataset.copyLinks);
    navigator.clipboard?.writeText(c.items.map(id => sourceLink(EP[id])).join('\n')).catch(() => {});
    toast(`Copied ${c.items.length} source links`); return;
  }
  const os = t.closest('[data-open-source]');
  if (os) { openSource(EP[os.dataset.openSource]); return; }

  // prototype panel
  if (t.closest('#proto-toggle')) { const p = $('#proto-panel'); p.hidden = !p.hidden; t.closest('#proto-toggle').setAttribute('aria-expanded', !p.hidden); return; }
  if (t.closest('[data-reset]')) { state = freshState(); persist(); X = null; applyPrefs(); $('#proto-slot').innerHTML = protoPanel(); updateNavBadge(); render(); toast('Demo data reset'); return; }
  if ($('#proto-panel') && !$('#proto-panel').hidden && !t.closest('#proto-panel')) $('#proto-panel').hidden = true;
});

document.addEventListener('change', e => {
  if (handleExportChange(e)) return;
  const sel = e.target.closest('[data-select-ep]');
  if (sel) {
    sel.checked ? topicSelection.add(sel.dataset.selectEp) : topicSelection.delete(sel.dataset.selectEp);
    sel.closest('.ep-row').classList.toggle('sel', sel.checked);
    updateSelectBar(); return;
  }
  const pref = e.target.closest('[data-pref]');
  if (pref) { state.prefs[pref.dataset.pref] = pref.checked; persist(); applyPrefs(); if (pref.dataset.pref === 'reducedMotion') render(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if ($('.popover')) return closePopover();
    if ($('.modal-wrap')) return closeModal();
    if ($('.drawer-wrap')) return closeDrawer();
    if ($('#proto-panel') && !$('#proto-panel').hidden) { $('#proto-panel').hidden = true; return; }
  }
  if (e.key === '/' && !/input|textarea/i.test(document.activeElement.tagName)) {
    const q = $('#q');
    if (q) { e.preventDefault(); q.focus(); q.select(); }
  }
  // keep Tab inside open dialogs
  if (e.key === 'Tab') {
    const dlg = $('.modal-wrap .modal') || $('.drawer-wrap .drawer');
    if (!dlg) return;
    const f = $$('button:not([disabled]), a[href], input, textarea, [tabindex="0"]', dlg).filter(x => x.offsetParent !== null);
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
});

let resizeT;
addEventListener('resize', () => {
  clearTimeout(resizeT);
  resizeT = setTimeout(() => { placeSegPill(); setActiveNav($('.nav-tabs [data-nav].on')?.dataset.nav); relayoutFeed(); }, 150);
});

addEventListener('scroll', () => { document.body.classList.toggle('scrolled', scrollY > 24); }, { passive: true });
addEventListener('hashchange', render);

/* ---------- boot ---------- */
function boot() {
  applyPrefs();
  $('#brand-slot').innerHTML = brandMark();
  $('#proto-slot').innerHTML = protoPanel();
  updateNavBadge();
  render();
  document.fonts?.ready.then(() => { placeSegPill(); setActiveNav($('.nav-tabs [data-nav].on')?.dataset.nav); });
}
boot();
