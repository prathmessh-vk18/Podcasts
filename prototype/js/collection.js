/* Playlist canvas (collection detail), cover builder, share, and the public shared page. */

function viewCollection(id) {
  const c = collection(id);
  if (!c) return viewNotFound();
  const html = `
  <section class="col-page">
    <div class="col-bg" aria-hidden="true">${c.items[0] ? coverImg(EP[c.items[0]], 100) : ''}</div>
    <div class="wrap col-grid">
      <aside class="col-side">
        <a class="back-link" href="#/library">${icon('arrowL')} Library</a>
        <button class="col-cover" data-edit-cover aria-label="Edit cover">
          ${collectionCover(c, 600)}
          <span class="col-cover-edit">${icon('edit')} Edit cover</span>
        </button>
        <div class="col-info">
          <label class="sr-only" for="col-name">Collection name</label>
          <input class="col-name" id="col-name" value="${esc(c.name)}" maxlength="60" spellcheck="false">
          <textarea class="col-desc" id="col-desc" rows="2" maxlength="160" placeholder="Add a sentence about what you’re learning…">${esc(c.desc)}</textarea>
          <p class="col-stats"></p>
          <div class="col-actions">
            <a class="btn btn-primary btn-block${c.items.length ? '' : ' disabled'}" ${c.items.length ? `href="#/export/${c.id}?fresh=1"` : 'aria-disabled="true"'}>${icon('export')} Export to a listening app</a>
            <div class="btn-row">
              <button class="btn btn-ghost" data-share="${c.id}">${icon('share')} Share</button>
              <button class="btn btn-ghost" data-privacy="${c.id}">${icon(c.privacy === 'private' ? 'lock' : 'globe')} ${c.privacy === 'private' ? 'Private' : 'Link'}</button>
              <button class="icon-btn" data-delete-col="${c.id}" aria-label="Delete collection">${icon('trash')}</button>
            </div>
          </div>
        </div>
      </aside>

      <section class="col-main" aria-labelledby="seq-h">
        <header class="seq-head">
          <div><p class="sec-idx">Listening order</p><h2 class="sec-title" id="seq-h">Arrange your <em>sequence</em></h2></div>
          <p class="seq-hint">${icon('grip')} Drag to reorder, or focus a handle and use ↑ ↓</p>
        </header>
        <ol class="seq" id="seq" data-col="${c.id}" aria-describedby="seq-help"></ol>
        <p id="seq-help" class="sr-only">Each item has a reorder handle. Focus it and press arrow up or arrow down to move the episode.</p>
        <div class="seq-add">
          <a class="btn btn-ghost" href="#/">${icon('search')} Find more episodes</a>
          <a class="btn btn-ghost" href="#/topics">${icon('grid')} Browse topics</a>
        </div>
      </section>
    </div>
  </section>
  ${footer()}`;
  return { html, mount: root => mountCollection(root, c) };
}

function renderSeq(c, focusIdx = null) {
  const host = $('#seq');
  if (!host) return;
  if (!c.items.length) {
    host.innerHTML = `<li class="empty empty-seq">
      <div class="empty-art" aria-hidden="true">${[0, 1, 2, 3, 4].map(i => `<i style="--i:${i}"></i>`).join('')}</div>
      <h3 class="empty-title">An empty canvas</h3>
      <p>Save episodes from Discover or a topic page and they’ll appear here, ready to put in order.</p>
    </li>`;
    return;
  }
  host.innerHTML = c.items.map((id, i) => {
    const e = EP[id];
    const partner = e.dupOf && c.items.includes(e.dupOf) ? EP[e.dupOf] : c.items.map(x => EP[x]).find(x => x.dupOf === id);
    return `<li class="seq-item" data-id="${id}">
      <button class="seq-grip" data-grip aria-label="Reorder ${esc(e.title)}, position ${i + 1} of ${c.items.length}">${icon('grip')}</button>
      <span class="seq-n">${String(i + 1).padStart(2, '0')}</span>
      <button class="seq-main" data-open-ep="${id}">
        <span class="seq-art">${coverImg(e, 100)}</span>
        <span class="seq-txt"><b>${esc(e.title)}</b><small>${esc(e.showName)} · ${fmtDur(e.dur)}</small></span>
      </button>
      <span class="seq-src">${sourceTag(e.source)}${partner ? `<span class="dup-flag">${icon('copy')} Also from ${SOURCES[partner.source].name}</span>` : ''}</span>
      <span class="seq-ctl">
        <button class="icon-btn icon-btn-sm" data-move="-1" aria-label="Move up" ${i === 0 ? 'disabled' : ''}>${icon('up')}</button>
        <button class="icon-btn icon-btn-sm" data-move="1" aria-label="Move down" ${i === c.items.length - 1 ? 'disabled' : ''}>${icon('down')}</button>
        <button class="icon-btn icon-btn-sm" data-remove aria-label="Remove from collection">${icon('x')}</button>
      </span>
    </li>`;
  }).join('');
  if (focusIdx !== null) host.children[focusIdx]?.querySelector('[data-grip]')?.focus();
}

/* FLIP: animate items from their previous positions to the new ones. */
function flip(host, mutate) {
  const before = new Map($$('.seq-item', host).map(el => [el.dataset.id, el.getBoundingClientRect().top]));
  mutate();
  if (reducedMotion()) return;
  $$('.seq-item', host).forEach(el => {
    const prev = before.get(el.dataset.id);
    if (prev == null) return;
    const dy = prev - el.getBoundingClientRect().top;
    if (!dy) return;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'translateY(0)' }], { duration: 420, easing: 'cubic-bezier(.34,1.4,.64,1)' });
  });
}

function moveItem(c, from, to, viaKeyboard) {
  if (to < 0 || to >= c.items.length || from === to) return;
  flip($('#seq'), () => {
    const [x] = c.items.splice(from, 1);
    c.items.splice(to, 0, x);
    persist();
    renderSeq(c, viaKeyboard ? to : null);
  });
  announce(`Moved to position ${to + 1} of ${c.items.length}`);
}

function mountCollection(root, c) {
  renderSeq(c);
  refreshCollectionStats(c);
  const host = root.querySelector('#seq');

  const nameEl = root.querySelector('#col-name'), descEl = root.querySelector('#col-desc');
  nameEl.addEventListener('change', () => {
    const v = nameEl.value.trim();
    if (!v) { nameEl.value = c.name; return; }
    c.name = v; persist();
    toast('Renamed collection');
  });
  nameEl.addEventListener('keydown', e => { if (e.key === 'Enter') nameEl.blur(); });
  descEl.addEventListener('change', () => { c.desc = descEl.value.trim(); persist(); });

  host.addEventListener('click', e => {
    const item = e.target.closest('.seq-item');
    if (!item) return;
    const idx = c.items.indexOf(item.dataset.id);
    const mv = e.target.closest('[data-move]');
    if (mv) moveItem(c, idx, idx + Number(mv.dataset.move), true);
    if (e.target.closest('[data-remove]')) {
      const id = item.dataset.id, ep = EP[id];
      item.classList.add('leaving');
      setTimeout(() => {
        flip(host, () => { c.items.splice(idx, 1); persist(); renderSeq(c); });
        updateNavBadge(); refreshCollectionStats(c);
      }, reducedMotion() ? 0 : 220);
      toast(`Removed “${esc(ep.title)}”`, { icon: 'x', action: 'Undo', onAction: () => {
        c.items.splice(idx, 0, id); persist();
        flip(host, () => renderSeq(c)); updateNavBadge(); refreshCollectionStats(c);
      } });
    }
  });

  host.addEventListener('keydown', e => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || !['ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const idx = c.items.indexOf(grip.closest('.seq-item').dataset.id);
    moveItem(c, idx, idx + (e.key === 'ArrowUp' ? -1 : 1), true);
  });

  initDragSort(host, c);
}

function refreshCollectionStats(c) {
  const st = $('.col-stats');
  if (!st) return;
  st.innerHTML = `<span><b>${c.items.length}</b> episodes</span><span><b>${fmtDur(totalDur(c.items))}</b></span>
    <span class="col-srcs">${sourcesOf(c.items).map(s => sourceTag(s, { short: true })).join('')}</span>`;
  if (!c.items.length) renderSeq(c);
}

/* Pointer-based drag sort. Works with mouse and touch; siblings make room as you drag. */
function initDragSort(host, c) {
  let drag = null;

  host.addEventListener('pointerdown', e => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || e.button > 0) return;
    const el = grip.closest('.seq-item');
    const items = $$('.seq-item', host);
    const startIdx = items.indexOf(el);
    const rects = items.map(i => i.getBoundingClientRect());
    const gap = rects.length > 1 ? rects[1].top - rects[0].bottom : 10;
    drag = { el, items, startIdx, idx: startIdx, rects, y0: e.clientY, step: rects[startIdx].height + gap, id: e.pointerId, moved: false };
    grip.setPointerCapture(e.pointerId);
  });

  host.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.y0;
    if (!drag.moved && Math.abs(dy) < 4) return;
    if (!drag.moved) { drag.moved = true; drag.el.classList.add('dragging'); host.classList.add('sorting'); }
    e.preventDefault();
    drag.el.style.transform = `translateY(${dy}px) scale(1.02) rotate(${Math.max(-1.2, Math.min(1.2, dy / 180))}deg)`;
    const center = drag.rects[drag.startIdx].top + drag.rects[drag.startIdx].height / 2 + dy;
    let idx = drag.startIdx;
    drag.rects.forEach((r, i) => {
      const mid = r.top + r.height / 2;
      if (i > drag.startIdx && center > mid) idx = Math.max(idx, i);
      if (i < drag.startIdx && center < mid) idx = Math.min(idx, i);
    });
    if (idx !== drag.idx) { drag.idx = idx; if (navigator.vibrate) navigator.vibrate(4); }
    drag.items.forEach((it, i) => {
      if (it === drag.el) return;
      let shift = 0;
      if (drag.startIdx < idx && i > drag.startIdx && i <= idx) shift = -drag.step;
      if (drag.startIdx > idx && i >= idx && i < drag.startIdx) shift = drag.step;
      it.style.transform = shift ? `translateY(${shift}px)` : '';
    });
  });

  const end = e => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (!d.moved) return;
    d.el.classList.add('settling');
    d.el.style.transform = `translateY(${(d.idx - d.startIdx) * d.step}px)`;
    setTimeout(() => {
      host.classList.remove('sorting');
      d.items.forEach(it => { it.style.transform = ''; });
      d.el.classList.remove('dragging', 'settling');
      if (d.idx !== d.startIdx) {
        const [x] = c.items.splice(d.startIdx, 1);
        c.items.splice(d.idx, 0, x);
        persist();
        announce(`Moved to position ${d.idx + 1}`);
      }
      renderSeq(c);
    }, reducedMotion() ? 0 : 240);
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
}

/* ---------- cover builder ---------- */
function coverBuilder(c) {
  let layout = c.layout || 'mosaic', tone = c.tone || 'ink';
  const layouts = [['mosaic', 'Mosaic'], ['single', 'Hero cover'], ['stack', 'Stack']];
  const tones = [['ink', 'Ink'], ['violet', 'Violet']];
  const preview = () => `${collectionCover({ ...c, layout, tone }, 600)}<span class="cover-title">${esc(c.name)}</span>`;
  const w = openModal({
    eyebrow: 'Cover builder', title: 'Make it yours', wide: true,
    body: `<div class="create-grid">
      <div class="cover-preview" id="cb-prev">${preview()}</div>
      <div class="create-fields">
        <div class="field"><span class="field-label">Layout</span>
          <div class="opt-row" role="radiogroup" aria-label="Layout">
            ${layouts.map(([k, l]) => `<button class="chip${k === layout ? ' on' : ''}" role="radio" aria-checked="${k === layout}" data-layout="${k}">${l}</button>`).join('')}
          </div></div>
        <div class="field"><span class="field-label">Background</span>
          <div class="opt-row" role="radiogroup" aria-label="Background">
            ${tones.map(([k, l]) => `<button class="chip${k === tone ? ' on' : ''}" role="radio" aria-checked="${k === tone}" data-tone="${k}"><i class="tone-dot tone-${k}"></i>${l}</button>`).join('')}
          </div></div>
        <p class="modal-note">${icon('info')} Covers use the artwork of the episodes in your collection, in your listening order.</p>
      </div></div>`,
    actions: `<button class="btn btn-ghost" data-close>Cancel</button><button class="btn btn-primary" data-apply>Apply cover</button>`,
  });
  const refresh = () => {
    const p = w.querySelector('#cb-prev');
    p.innerHTML = preview();
    if (!reducedMotion()) p.animate([{ transform: 'scale(.97)' }, { transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    $$('[data-layout]', w).forEach(b => { b.classList.toggle('on', b.dataset.layout === layout); b.setAttribute('aria-checked', b.dataset.layout === layout); });
    $$('[data-tone]', w).forEach(b => { b.classList.toggle('on', b.dataset.tone === tone); b.setAttribute('aria-checked', b.dataset.tone === tone); });
  };
  w.addEventListener('click', e => {
    const l = e.target.closest('[data-layout]'), t = e.target.closest('[data-tone]');
    if (l) { layout = l.dataset.layout; refresh(); }
    if (t) { tone = t.dataset.tone; refresh(); }
    if (e.target.closest('[data-apply]')) {
      c.layout = layout; c.tone = tone; persist(); closeModal(); render();
      toast('Cover updated');
    }
  });
}

/* ---------- share ---------- */
function shareModal(c) {
  const url = `tangent.fm/c/${c.id}${hashStr(c.name).toString(36).slice(0, 4)}`;
  const w = openModal({
    eyebrow: 'Share', title: `Share “${esc(c.name)}”`,
    body: `<div class="privacy-opts" role="radiogroup" aria-label="Who can view">
        <button class="privacy-opt${c.privacy === 'private' ? ' on' : ''}" role="radio" aria-checked="${c.privacy === 'private'}" data-priv="private">
          ${icon('lock')}<span><b>Private</b><small>Only you can see this collection.</small></span></button>
        <button class="privacy-opt${c.privacy !== 'private' ? ' on' : ''}" role="radio" aria-checked="${c.privacy !== 'private'}" data-priv="link">
          ${icon('globe')}<span><b>Anyone with the link</b><small>Read-only. Viewers see titles and source links, and can copy it to their own library.</small></span></button>
      </div>
      <div class="share-link${c.privacy === 'private' ? ' off' : ''}">
        <code>${url}</code><button class="btn btn-sm btn-primary" data-copy-link>${icon('copy')} Copy link</button>
      </div>
      <p class="modal-note">${icon('info')} Shared pages never include your connected accounts or listening history.</p>`,
    actions: `<a class="btn btn-ghost" href="#/shared/${c.id}" data-close>Preview shared page ${icon('arrow')}</a>`,
  });
  w.addEventListener('click', e => {
    const p = e.target.closest('[data-priv]');
    if (p) {
      c.privacy = p.dataset.priv; persist();
      $$('[data-priv]', w).forEach(b => { b.classList.toggle('on', b === p); b.setAttribute('aria-checked', b === p); });
      w.querySelector('.share-link').classList.toggle('off', c.privacy === 'private');
      const pb = $(`[data-privacy="${c.id}"]`);
      if (pb) pb.innerHTML = `${icon(c.privacy === 'private' ? 'lock' : 'globe')} ${c.privacy === 'private' ? 'Private' : 'Link'}`;
    }
    if (e.target.closest('[data-copy-link]')) {
      if (c.privacy === 'private') { c.privacy = 'link'; persist(); }
      navigator.clipboard?.writeText('https://' + url).catch(() => {});
      const b = e.target.closest('[data-copy-link]');
      b.innerHTML = `${icon('check')} Copied`;
      setTimeout(() => { b.innerHTML = `${icon('copy')} Copy link`; }, 1800);
    }
  });
}

/* ---------- shared (public) page ---------- */
function viewShared(id) {
  const c = collection(id);
  if (!c) return viewNotFound();
  const isPrivate = c.privacy === 'private';
  const html = `
  <section class="shared">
    <div class="col-bg" aria-hidden="true">${c.items[0] ? coverImg(EP[c.items[0]], 100) : ''}</div>
    <div class="wrap shared-grid">
      <div class="shared-cover">${collectionCover(c, 600)}</div>
      <div class="shared-copy">
        <p class="shared-badge">${icon(isPrivate ? 'lock' : 'globe')} ${isPrivate ? 'Private preview: only you can see this' : 'Shared collection · read-only'}</p>
        <h1 class="shared-title">${esc(c.name)}</h1>
        <p class="shared-by"><span class="avatar sm" aria-hidden="true">Y</span> Curated by <b>you</b></p>
        ${c.desc ? `<p class="shared-desc">${esc(c.desc)}</p>` : ''}
        <p class="col-stats"><span><b>${c.items.length}</b> episodes</span><span><b>${fmtDur(totalDur(c.items))}</b></span>
          <span class="col-srcs">${sourcesOf(c.items).map(s => sourceTag(s, { short: true })).join('')}</span></p>
        <div class="btn-row">
          <button class="btn btn-primary" data-copy-shared="${c.id}">${icon('copy')} Copy to my library</button>
          <button class="btn btn-ghost" data-copy-links="${c.id}">${icon('link')} Copy all source links</button>
        </div>
      </div>
    </div>
  </section>
  <section class="wrap sec">
    <ol class="shared-list">
      ${c.items.map((eid, i) => { const e = EP[eid]; return `<li class="shared-item">
        <span class="shared-n">${String(i + 1).padStart(2, '0')}</span>
        <span class="shared-art">${coverImg(e, 200)}</span>
        <div class="shared-txt"><b>${esc(e.title)}</b><small>${esc(e.showName)} · ${fmtDur(e.dur)}</small>
          <p>${esc(e.desc)}</p></div>
        <div class="shared-act">${sourceTag(e.source)}<button class="btn btn-sm btn-ghost" data-open-source="${e.id}">${icon('ext')} Open on ${SOURCES[e.source].name}</button></div>
      </li>`; }).join('')}
    </ol>
  </section>
  <section class="wrap sec">
    <div class="cta-band">
      <div><h2 class="sec-title">Build your own <em>learning library</em></h2><p>Find episodes on any service, keep them in one place, and send them to the app you listen in.</p></div>
      <a class="btn btn-primary" href="#/">Start discovering ${icon('arrow')}</a>
    </div>
  </section>
  ${footer()}`;
  return { html };
}

function copyCollectionToLibrary(src) {
  const col = { id: uid(), name: src.name, desc: src.desc, layout: src.layout, tone: src.tone, items: [...src.items], privacy: 'private' };
  state.collections.unshift(col);
  persist(); updateNavBadge(); bumpBadge();
  toast(`Copied <b>${esc(col.name)}</b> to your library`, { action: 'Open', onAction: () => go('#/collection/' + col.id) });
}
