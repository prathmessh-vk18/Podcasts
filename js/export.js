/* Export journey: destination → connect → match → review → result.
   Rule: an uncertain match is never added silently, and a list of links is never called a transfer. */

let X = null; // export session

const STEPS = [['dest', 'Destination'], ['connect', 'Connect'], ['match', 'Match'], ['review', 'Review'], ['result', 'Done']];

function viewExport(colId, query) {
  const c = collection(colId);
  if (!c) return viewNotFound();
  if (!X || X.colId !== colId || query.get('fresh')) X = { colId, step: 'dest', dest: null, plan: null, decisions: {}, linkInDesc: {}, result: null };
  const html = `
  <section class="xp" data-step="${X.step}">
    <div class="xp-bg" aria-hidden="true"></div>
    <div class="wrap xp-wrap">
      <header class="xp-head">
        <a class="back-link" href="#/collection/${c.id}">${icon('arrowL')} ${esc(c.name)}</a>
        <ol class="stepper" aria-label="Export progress" id="stepper"></ol>
      </header>
      <div id="xp-stage" class="xp-stage"></div>
    </div>
  </section>`;
  return { html, mount: () => renderExportStep() };
}

function setStep(step) {
  X.step = step;
  renderExportStep();
  window.scrollTo({ top: 0, behavior: reducedMotion() ? 'auto' : 'smooth' });
}

function renderStepper() {
  const el = $('#stepper');
  if (!el) return;
  const cur = STEPS.findIndex(s => s[0] === X.step);
  el.innerHTML = STEPS.map(([k, l], i) => `<li class="${i < cur ? 'done' : i === cur ? 'cur' : ''}" ${i === cur ? 'aria-current="step"' : ''}>
    <span class="st-dot">${i < cur ? icon('check') : i + 1}</span><span class="st-l">${l}</span></li>`).join('');
}

function renderExportStep() {
  const stage = $('#xp-stage');
  if (!stage) return;
  renderStepper();
  $('.xp')?.setAttribute('data-step', X.step);
  const c = collection(X.colId);
  const fn = { dest: stepDest, connect: stepConnect, match: stepMatch, review: stepReview, result: stepResult, links: stepLinks }[X.step];
  stage.innerHTML = `<div class="xp-panel" key="${X.step}">${fn(c)}</div>`;
  ({ match: animateMatching, result: runExport }[X.step] || (() => {}))(c);
}

/* ---------- plan ---------- */
function buildPlan(c, dest) {
  const seen = new Map();
  return c.items.map((id, i) => {
    const ep = EP[id];
    const canon = ep.dupOf || id;
    if (seen.has(canon)) return { id, i, kind: 'duplicate', of: seen.get(canon) };
    seen.set(canon, id);
    const m = parseMatch(ep, dest);
    const kind = { native: 'ready', exact: 'ready', strong: 'ready', review: 'review', none: 'none' }[m.status];
    return { id, i, kind, status: m.status, conf: m.conf };
  });
}

function planCounts() {
  const p = X.plan;
  const accepted = p.filter(x => x.kind === 'review' && X.decisions[x.id] === 'accept').length;
  const ready = p.filter(x => x.kind === 'ready').length + accepted;
  return {
    ready, accepted,
    review: p.filter(x => x.kind === 'review').length,
    pending: p.filter(x => x.kind === 'review' && !X.decisions[x.id]).length,
    rejected: p.filter(x => x.kind === 'review' && X.decisions[x.id] === 'reject').length,
    none: p.filter(x => x.kind === 'none').length,
    dup: p.filter(x => x.kind === 'duplicate').length,
  };
}

/* ---------- 1. destination ---------- */
function stepDest(c) {
  const dests = [
    { id: 'spotify', ok: true, line: 'Creates a new playlist with the matched podcast episodes.', note: 'Playlist API available' },
    { id: 'youtube', ok: true, line: 'Creates a playlist of matched videos. Audio-only shows often aren’t on YouTube.', note: 'Daily limits apply' },
    { id: 'apple', ok: false, line: 'Apple Podcasts doesn’t let apps create playlists. You can export a list of links instead.', note: 'No playlist API' },
  ];
  const preview = d => {
    const plan = buildPlan(c, d);
    const r = plan.filter(x => x.kind === 'ready').length, rv = plan.filter(x => x.kind === 'review').length;
    return `${r} ready · ${rv} to review`;
  };
  return `
    <div class="xp-title-row">
      <p class="sec-idx">Step 1 of 5</p>
      <h1 class="xp-title">Where do you <em>listen?</em></h1>
      <p class="xp-lede">We’ll find each of the ${c.items.length} episodes in “${esc(c.name)}” on the app you pick. You’ll see every match before anything is added.</p>
    </div>
    <div class="dest-grid">
      ${dests.map(d => `<button class="dest dest-${d.id}${d.ok ? '' : ' dest-limited'}" data-dest="${d.id}">
        <span class="dest-glow" aria-hidden="true"></span>
        <span class="dest-top">${sourceTag(d.id, { solid: true })}<span class="dest-note ${d.ok ? '' : 'warn'}">${icon(d.ok ? 'check' : 'info')} ${d.note}</span></span>
        <b class="dest-name">${SOURCES[d.id].name}</b>
        <span class="dest-line">${d.line}</span>
        <span class="dest-foot">${d.ok ? `<span class="dest-est">${preview(d.id)}</span>${state.connected[d.id] ? '<span class="dest-conn">Connected</span>' : ''}` : '<span class="dest-est">Link list only</span>'}
          <span class="dest-go">${icon('arrow')}</span></span>
      </button>`).join('')}
    </div>
    <p class="fineprint center">${icon('info')} Prototype: these destinations show the behaviour we plan to test in the API spike. Nothing is really connected.</p>`;
}

/* ---------- 2. connect ---------- */
function stepConnect() {
  const d = SOURCES[X.dest];
  if (state.connected[X.dest]) {
    return `<div class="connect-card connected">
      <div class="connect-ic ok">${icon('check')}</div>
      <p class="sec-idx">Step 2 of 5</p>
      <h1 class="xp-title">${d.name} is <em>connected</em></h1>
      <p class="xp-lede">Signed in as <b>you@example.com</b>. You can disconnect at any time, and we’ll delete the access token straight away.</p>
      <div class="btn-row center"><button class="btn btn-primary btn-lg" data-xp-go="match">Find matches ${icon('arrow')}</button>
      <button class="btn btn-ghost" data-disconnect="${X.dest}">Disconnect</button></div>
    </div>`;
  }
  return `<div class="connect-card">
    <div class="connect-link" aria-hidden="true">
      <span class="cl-node cl-us">${brandMark()}</span><span class="cl-line"><i></i><i></i><i></i></span><span class="cl-node cl-them src-${X.dest}"><i class="src-dot"></i>${d.name}</span>
    </div>
    <p class="sec-idx">Step 2 of 5</p>
    <h1 class="xp-title">Connect <em>${d.name}</em></h1>
    <p class="xp-lede">You’ll sign in on ${d.name}’s own page. We never see your password.</p>
    <div class="scopes">
      <div class="scope-col"><h3>Tangent will be able to</h3><ul role="list">
        <li>${icon('check')} Create a new playlist in your account</li>
        <li>${icon('check')} Add episodes to playlists that Tangent creates</li>
        <li>${icon('check')} See your display name</li></ul></div>
      <div class="scope-col no"><h3>Tangent won’t</h3><ul role="list">
        <li>${icon('x')} See your listening history</li>
        <li>${icon('x')} Change or delete your existing playlists</li>
        <li>${icon('x')} Post or follow anything for you</li></ul></div>
    </div>
    <div class="btn-row center"><button class="btn btn-primary btn-lg" data-connect="${X.dest}">Continue to ${d.name} ${icon('ext')}</button>
      <button class="btn btn-ghost" data-xp-go="dest">Choose another app</button></div>
  </div>`;
}

async function connectFlow(dest) {
  const w = openModal({
    eyebrow: 'Simulated sign-in', title: `${SOURCES[dest].name} authorisation`,
    body: `<div class="oauth"><div class="oauth-spin" aria-hidden="true"></div><p>Waiting for ${SOURCES[dest].name} to confirm…</p><small>In the real product this opens ${SOURCES[dest].host} in a secure window.</small></div>`,
  });
  await sleep(reducedMotion() ? 300 : 1400);
  if (!document.body.contains(w)) return; // user cancelled
  state.connected[dest] = true; persist();
  closeModal();
  toast(`${SOURCES[dest].name} connected`);
  setStep('match');
}

/* ---------- 3. matching (transfer path) ---------- */
function stepMatch(c) {
  X.plan = buildPlan(c, X.dest);
  const d = SOURCES[X.dest];
  return `
    <div class="xp-title-row">
      <p class="sec-idx">Step 3 of 5</p>
      <h1 class="xp-title">Finding each episode on <em>${d.name}</em></h1>
      <p class="xp-lede" id="match-status">Checking IDs, links, show, guest, date and length…</p>
    </div>
    <div class="transfer" id="transfer">
      <svg class="transfer-svg" aria-hidden="true"></svg>
      <ol class="tr-src" aria-label="Your collection">
        ${X.plan.map(p => { const e = EP[p.id]; return `<li class="tr-item" data-tr="${p.id}">
          <span class="tr-art">${coverImg(e, 100)}</span>
          <span class="tr-txt"><b>${esc(e.title)}</b><small>${SOURCES[e.source].name}</small></span>
          <span class="tr-state" aria-hidden="true"></span></li>`; }).join('')}
      </ol>
      <div class="tr-bins">
        <div class="bin bin-ready" data-bin="ready"><header><span>${sourceTag(X.dest, { solid: true })} Matched</span><b>0</b></header><div class="bin-chips"></div></div>
        <div class="bin bin-review" data-bin="review"><header><span>${icon('alert')} Needs your review</span><b>0</b></header><div class="bin-chips"></div></div>
        <div class="bin-row">
          <div class="bin bin-none" data-bin="none"><header><span>${icon('x')} Not on ${d.name}</span><b>0</b></header><div class="bin-chips"></div></div>
          <div class="bin bin-duplicate" data-bin="duplicate"><header><span>${icon('copy')} Duplicate</span><b>0</b></header><div class="bin-chips"></div></div>
        </div>
      </div>
    </div>
    <div class="xp-foot" id="match-foot" hidden>
      <p id="match-summary"></p>
      <button class="btn btn-primary btn-lg" data-xp-go="review">Review &amp; confirm ${icon('arrow')}</button>
    </div>`;
}

function bezierPts(a, b, n = 18) {
  const horiz = Math.abs(b.x - a.x) > 80;
  const c1 = horiz ? { x: a.x + (b.x - a.x) * .5, y: a.y } : { x: a.x, y: a.y + (b.y - a.y) * .5 };
  const c2 = horiz ? { x: a.x + (b.x - a.x) * .5, y: b.y } : { x: b.x, y: a.y + (b.y - a.y) * .5 };
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n, u = 1 - t;
    pts.push({ x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
               y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y });
  }
  return { pts, d: `M${a.x} ${a.y} C${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}` };
}

async function animateMatching() {
  const stage = $('#transfer');
  if (!stage) return;
  const svg = stage.querySelector('.transfer-svg');
  const sr = () => stage.getBoundingClientRect();
  const fast = reducedMotion();
  const labels = { ready: 'Matched', review: 'Needs review', none: 'Not found', duplicate: 'Duplicate' };
  const wide = innerWidth > 860;

  for (const p of X.plan) {
    if (!document.body.contains(stage)) return;
    const item = stage.querySelector(`[data-tr="${p.id}"]`);
    const bin = stage.querySelector(`[data-bin="${p.kind}"]`);
    item.classList.add('scanning');
    await sleep(fast ? 0 : 260);
    const S = sr(), ir = item.getBoundingClientRect(), br = bin.getBoundingClientRect();
    const a = wide ? { x: ir.right - S.left, y: ir.top - S.top + ir.height / 2 } : { x: ir.left - S.left + 40, y: ir.bottom - S.top };
    const b = wide ? { x: br.left - S.left, y: br.top - S.top + 26 } : { x: br.left - S.left + 40, y: br.top - S.top };
    svg.setAttribute('viewBox', `0 0 ${S.width} ${S.height}`);
    const { pts, d } = bezierPts(a, b);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    path.setAttribute('class', 'tr-path k-' + p.kind);
    svg.appendChild(path);

    if (!fast) {
      const len = path.getTotalLength();
      path.style.strokeDasharray = len; path.style.strokeDashoffset = len;
      path.animate([{ strokeDashoffset: len }, { strokeDashoffset: 0 }], { duration: 520, easing: 'cubic-bezier(.65,0,.35,1)', fill: 'forwards' });
      const tok = document.createElement('span');
      tok.className = 'tr-token k-' + p.kind;
      tok.innerHTML = coverImg(EP[p.id], 100);
      stage.appendChild(tok);
      await tok.animate(pts.map(pt => ({ transform: `translate(${pt.x - 14}px, ${pt.y - 14}px)` })), { duration: 560, easing: 'cubic-bezier(.65,0,.35,1)' }).finished;
      tok.remove();
    }

    item.classList.remove('scanning');
    item.classList.add('k-' + p.kind);
    item.querySelector('.tr-state').innerHTML = `${icon({ ready: 'check', review: 'alert', none: 'x', duplicate: 'copy' }[p.kind])}<span>${labels[p.kind]}${p.conf && p.kind !== 'none' && p.status !== 'native' ? ' · ' + p.conf + '%' : ''}</span>`;
    const chips = bin.querySelector('.bin-chips');
    chips.insertAdjacentHTML('beforeend', `<span class="bin-chip" title="${esc(EP[p.id].title)}">${coverImg(EP[p.id], 100)}</span>`);
    const cnt = bin.querySelector('header b');
    cnt.textContent = Number(cnt.textContent) + 1;
    bin.classList.add('hit'); setTimeout(() => bin.classList.remove('hit'), 300);
    await sleep(fast ? 0 : 90);
  }
  const k = planCounts();
  $('#match-status').textContent = 'Matching finished.';
  const foot = $('#match-foot');
  $('#match-summary').innerHTML = `<b>${k.ready}</b> matched${k.review ? ` · <b>${k.review}</b> need${k.review === 1 ? 's' : ''} your review` : ''}${k.none ? ` · <b>${k.none}</b> not on ${SOURCES[X.dest].name}` : ''}${k.dup ? ` · <b>${k.dup}</b> duplicate` : ''}`;
  foot.hidden = false;
  announce('Matching finished. ' + foot.textContent.trim());
}

/* ---------- 4. review & confirm ---------- */
function confRing(v) {
  const r = 18, C = 2 * Math.PI * r;
  return `<span class="ring" style="--v:${v}"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="${r}" class="ring-bg"/><circle cx="22" cy="22" r="${r}" class="ring-fg" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - v / 100)}"/></svg><b>${v}<small>%</small></b></span>`;
}

function evidence(ep, dest) {
  const rv = ep.review || {};
  const items = [
    ['Show', true], [ep.guest ? 'Guest' : 'Host', true],
    ['Title', !/title/i.test(rv.delta || '')], ['Release date', !rv.dateOff], ['Duration', !/duration differs/i.test(rv.delta || '')],
  ];
  return `<ul class="evidence" role="list">${items.map(([k, ok]) => `<li class="${ok ? 'ok' : 'bad'}">${icon(ok ? 'check' : 'x')}${k}</li>`).join('')}</ul>`;
}

function stepReview(c) {
  if (!X.plan) X.plan = buildPlan(c, X.dest);
  const d = SOURCES[X.dest];
  const k = planCounts();
  const reviews = X.plan.filter(p => p.kind === 'review');
  const nones = X.plan.filter(p => p.kind === 'none');
  const dups = X.plan.filter(p => p.kind === 'duplicate');
  const readies = X.plan.filter(p => p.kind === 'ready');
  return `
    <div class="xp-title-row">
      <p class="sec-idx">Step 4 of 5</p>
      <h1 class="xp-title">Check before we <em>add anything</em></h1>
      <p class="xp-lede">Nothing has been added to ${d.name} yet. Uncertain matches need your decision. We won’t guess for you.</p>
    </div>

    <div class="tally" id="tally">${tallyHTML(k)}</div>

    ${reviews.length ? `<section class="rv-sec"><h2 class="rv-h">${icon('alert')} Needs your review <span>${reviews.length}</span></h2>
      ${reviews.map(p => reviewCard(p)).join('')}</section>` : ''}

    ${nones.length ? `<section class="rv-sec"><h2 class="rv-h">${icon('x')} Not available on ${d.name} <span>${nones.length}</span></h2>
      <p class="rv-sub">We couldn’t find these on ${d.name}. They won’t be added, and won’t be counted as transferred.</p>
      ${nones.map(p => { const e = EP[p.id]; return `<div class="rv-row">
        <span class="rv-art">${coverImg(e, 100)}</span>
        <span class="rv-txt"><b>${esc(e.title)}</b><small>${sourceTag(e.source, { short: true })} ${esc(e.showName)} · probably only on ${SOURCES[e.source].name}</small></span>
        <label class="switch"><input type="checkbox" data-link-desc="${p.id}" ${X.linkInDesc[p.id] !== false ? 'checked' : ''}><span class="switch-ui"></span><span class="switch-l">Put the link in the playlist description</span></label>
      </div>`; }).join('')}</section>` : ''}

    ${dups.length ? `<section class="rv-sec"><h2 class="rv-h">${icon('copy')} Duplicates <span>${dups.length}</span></h2>
      ${dups.map(p => { const e = EP[p.id], o = EP[p.of]; return `<div class="rv-row">
        <span class="rv-art">${coverImg(e, 100)}</span>
        <span class="rv-txt"><b>${esc(e.title)}</b><small>Same episode as #${c.items.indexOf(p.of) + 1}, saved from ${SOURCES[o.source].name}. It will only be added once.</small></span>
      </div>`; }).join('')}</section>` : ''}

    <details class="rv-sec rv-ready" ${readies.length <= 3 ? 'open' : ''}>
      <summary class="rv-h">${icon('check')} Ready to add <span>${readies.length}</span>${icon('down', 'chev')}</summary>
      ${readies.map(p => { const e = EP[p.id]; return `<div class="rv-row">
        <span class="rv-art">${coverImg(e, 100)}</span>
        <span class="rv-txt"><b>${esc(e.title)}</b><small>${esc(e.showName)} · ${fmtDur(e.dur)}</small></span>
        <span class="match-pill m-${p.status}">${p.status === 'native' ? `Already on ${d.name}` : p.status === 'exact' ? 'Exact match' : 'Likely match · ' + p.conf + '%'}</span>
      </div>`; }).join('')}
    </details>

    <div class="xp-sticky">
      <label class="pl-name"><span>New playlist</span><input class="input" id="pl-name" value="${esc(c.name)}" maxlength="80"></label>
      <button class="btn btn-primary btn-lg" id="confirm-export" ${k.pending ? 'disabled' : ''} data-confirm-export>
        ${k.pending ? `Review ${k.pending} more to continue` : `Add ${k.ready} episode${k.ready === 1 ? '' : 's'} to ${d.name}`}</button>
    </div>`;
}

function tallyHTML(k) {
  return `<span class="t-ready"><b>${k.ready}</b> will be added</span>
    <span class="t-review${k.pending ? ' pulse' : ''}"><b>${k.pending}</b> to review</span>
    <span class="t-none"><b>${k.none + k.rejected}</b> skipped</span>
    <span class="t-dup"><b>${k.dup}</b> duplicate${k.dup === 1 ? '' : 's'}</span>`;
}

function reviewCard(p) {
  const e = EP[p.id], d = SOURCES[X.dest];
  const dec = X.decisions[p.id];
  const candDur = e.dur + (e.review?.durDelta || 0);
  const candDate = e.review?.dateOff ? new Date(new Date(e.date).getTime() + 2 * 864e5).toISOString().slice(0, 10) : e.date;
  return `<article class="rv-card${dec ? ' dec-' + dec : ''}" data-rv="${p.id}">
    <div class="rv-pair">
      <div class="rv-side">
        <p class="rv-k">In your collection</p>
        <div class="rv-ep"><span class="rv-art lg">${coverImg(e, 100)}</span>
          <span><b>${esc(e.title)}</b><small>${esc(e.showName)}</small><small>${fmtClock(e.dur)} · ${fmtDate(e.date)} · ${SOURCES[e.source].name}</small></span></div>
      </div>
      <div class="rv-mid">${confRing(p.conf)}<span class="rv-mid-l">confidence</span></div>
      <div class="rv-side">
        <p class="rv-k">Best match on ${d.name}</p>
        <div class="rv-ep"><span class="rv-art lg">${coverImg(e, 100)}</span>
          <span><b>${esc(e.review?.title || e.title)}</b><small>${esc(e.showName)}</small><small>${fmtClock(candDur)} · ${fmtDate(candDate)} · ${d.name}</small></span></div>
      </div>
    </div>
    <div class="rv-why">${evidence(e, X.dest)}<p>${esc(e.review?.delta || 'Some details differ.')}</p></div>
    <div class="rv-actions" role="group" aria-label="Decision for ${esc(e.title)}">
      <button class="btn btn-sm ${dec === 'accept' ? 'btn-primary' : 'btn-ghost'}" data-decide="accept" aria-pressed="${dec === 'accept'}">${icon('check')} Use this match</button>
      <button class="btn btn-sm ${dec === 'reject' ? 'btn-danger' : 'btn-ghost'}" data-decide="reject" aria-pressed="${dec === 'reject'}">${icon('x')} Skip this episode</button>
      <button class="btn btn-sm btn-text" data-open-source="${e.id}">${icon('ext')} Compare at source</button>
    </div>
  </article>`;
}

function refreshReviewChrome() {
  const k = planCounts();
  const t = $('#tally'); if (t) t.innerHTML = tallyHTML(k);
  const b = $('#confirm-export');
  if (b) {
    b.disabled = k.pending > 0;
    b.textContent = k.pending ? `Review ${k.pending} more to continue` : `Add ${k.ready} episode${k.ready === 1 ? '' : 's'} to ${SOURCES[X.dest].name}`;
  }
}

/* ---------- 5. result ---------- */
function stepResult(c) {
  const d = SOURCES[X.dest];
  return `
    <div class="result" id="result">
      <div class="result-ring" id="result-ring">
        <svg viewBox="0 0 200 200" aria-hidden="true"><circle cx="100" cy="100" r="88" class="rr-bg"/><circle cx="100" cy="100" r="88" class="rr-fg" id="rr-fg"/></svg>
        <div class="rr-center"><b id="rr-num">0</b><small id="rr-of">of 0</small></div>
      </div>
      <p class="sec-idx" id="result-k">Step 5 of 5 · Adding to ${d.name}</p>
      <h1 class="xp-title" id="result-title">Adding episodes<em>…</em></h1>
      <p class="xp-lede" id="result-lede">Creating “${esc(X.playlistName || c.name)}” on ${d.name}.</p>
      <div id="result-body"></div>
    </div>`;
}

async function runExport(c) {
  const d = SOURCES[X.dest];
  const toAdd = X.plan.filter(p => p.kind === 'ready' || (p.kind === 'review' && X.decisions[p.id] === 'accept'));
  const skipped = X.plan.filter(p => p.kind === 'none' || (p.kind === 'review' && X.decisions[p.id] === 'reject'));
  const failIdx = state.prefs.simulateFailure && toAdd.length > 2 ? toAdd.length - 2 : -1;
  const C = 2 * Math.PI * 88;
  const fg = $('#rr-fg');
  fg.style.strokeDasharray = C; fg.style.strokeDashoffset = C;
  $('#rr-of').textContent = 'of ' + toAdd.length;
  const added = [], failed = [];
  for (let i = 0; i < toAdd.length; i++) {
    if (!$('#result')) return;
    await sleep(reducedMotion() ? 20 : 240);
    (i === failIdx ? failed : added).push(toAdd[i]);
    $('#rr-num').textContent = added.length;
    fg.style.strokeDashoffset = C * (1 - (i + 1) / toAdd.length);
    $('#result-lede').textContent = `Adding ${i + 1} of ${toAdd.length}: ${EP[toAdd[i].id].title}`;
  }
  X.result = { added, failed, skipped, toAdd };
  renderResult(c);
}

function renderResult(c) {
  const d = SOURCES[X.dest];
  const { added, failed, skipped, toAdd } = X.result;
  const C = 2 * Math.PI * 88;
  const fg = $('#rr-fg');
  fg.style.strokeDashoffset = C * (1 - added.length / Math.max(1, toAdd.length));
  $('#result-ring').classList.toggle('partial', failed.length > 0);
  $('#result-ring').classList.add('done');
  $('#rr-num').textContent = added.length;
  $('#result-k').textContent = failed.length ? 'Finished, with an issue' : 'Export complete';
  $('#result-title').innerHTML = failed.length ? `${added.length} of ${toAdd.length} <em>added</em>` : `All ${added.length} <em>added</em>`;
  $('#result-lede').innerHTML = `Playlist “${esc(X.playlistName || c.name)}” is on ${d.name}.${skipped.length ? ` ${skipped.length} episode${skipped.length > 1 ? 's were' : ' was'} skipped because ${skipped.length > 1 ? 'they aren’t' : 'it isn’t'} available there.` : ''}`;
  const linkCount = skipped.filter(p => X.linkInDesc[p.id] !== false && p.kind === 'none').length;
  $('#result-body').innerHTML = `
    <div class="btn-row center">
      <button class="btn btn-primary" data-open-dest>${icon('ext')} Open in ${d.name}</button>
      <a class="btn btn-ghost" href="#/collection/${c.id}">Back to collection</a>
    </div>
    <div class="result-cols">
      ${failed.length ? `<section class="res-sec res-fail"><h2 class="rv-h">${icon('alert')} Couldn’t add <span>${failed.length}</span></h2>
        ${failed.map(p => { const e = EP[p.id]; return `<div class="rv-row">
          <span class="rv-art">${coverImg(e, 100)}</span>
          <span class="rv-txt"><b>${esc(e.title)}</b><small>${d.name} returned a temporary error (429 Too Many Requests). Nothing was lost.</small></span>
          <button class="btn btn-sm btn-primary" data-retry="${p.id}">${icon('retry')} Retry</button>
          <button class="btn btn-sm btn-ghost" data-open-source="${e.id}">${icon('ext')} Open at source</button></div>`; }).join('')}
      </section>` : ''}
      ${skipped.length ? `<section class="res-sec"><h2 class="rv-h">${icon('x')} Skipped <span>${skipped.length}</span></h2>
        ${skipped.map(p => { const e = EP[p.id]; return `<div class="rv-row">
          <span class="rv-art">${coverImg(e, 100)}</span>
          <span class="rv-txt"><b>${esc(e.title)}</b><small>${p.kind === 'none' ? `Not on ${d.name}${X.linkInDesc[p.id] !== false ? ', so the link is in the playlist description' : ''}` : 'You chose to skip this match'}</small></span>
          <button class="btn btn-sm btn-ghost" data-open-source="${e.id}">${icon('ext')} ${SOURCES[e.source].name}</button></div>`; }).join('')}
        <button class="btn btn-sm btn-text" data-copy-skipped>${icon('copy')} Copy these links</button>
      </section>` : ''}
      <section class="res-sec res-ok"><h2 class="rv-h">${icon('check')} Added <span>${added.length}</span></h2>
        <div class="added-grid">${added.map((p, i) => `<span class="added-chip" style="--i:${i}" title="${esc(EP[p.id].title)}">${coverImg(EP[p.id], 100)}</span>`).join('')}</div>
        ${linkCount ? `<p class="rv-sub">${linkCount} source link${linkCount > 1 ? 's' : ''} were added to the playlist description. These are links, not transferred episodes.</p>` : ''}
      </section>
    </div>`;
  announce($('#result-title').textContent + '. ' + $('#result-lede').textContent);
  if (!failed.length && !reducedMotion()) confetti($('#result-ring'));
}

async function retryItem(id, btn) {
  btn.disabled = true;
  btn.innerHTML = `<span class="spin" aria-hidden="true"></span> Retrying`;
  await sleep(reducedMotion() ? 200 : 1100);
  const r = X.result;
  const i = r.failed.findIndex(p => p.id === id);
  if (i < 0) return;
  r.added.push(...r.failed.splice(i, 1));
  toast('Added on retry');
  renderResult(collection(X.colId));
}

/* A brief burst on full success. Skipped when reduced motion is on. */
function confetti(anchor) {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  const colors = ['#8b6cff', '#b9a6ff', '#ffffff', '#5d3fe0'];
  for (let i = 0; i < 28; i++) {
    const p = document.createElement('i');
    p.className = 'confetti';
    p.style.background = colors[i % colors.length];
    p.style.left = r.left + r.width / 2 + 'px';
    p.style.top = r.top + r.height / 2 + scrollY + 'px';
    document.body.appendChild(p);
    const ang = Math.random() * Math.PI * 2, dist = 90 + Math.random() * 140;
    p.animate([
      { transform: 'translate(-50%,-50%) scale(1)', opacity: 1 },
      { transform: `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist + 60}px) rotate(${Math.random() * 540}deg) scale(.6)`, opacity: 0 },
    ], { duration: 900 + Math.random() * 500, easing: 'cubic-bezier(.2,.7,.3,1)' }).onfinish = () => p.remove();
  }
}

/* ---------- Apple fallback: link list, clearly not a transfer ---------- */
function stepLinks(c) {
  const lines = c.items.map((id, i) => `${i + 1}. ${EP[id].title} (${EP[id].showName})\n   ${EP[id].url}`).join('\n');
  return `<div class="connect-card">
    <div class="connect-ic warn">${icon('info')}</div>
    <p class="sec-idx">Apple Podcasts</p>
    <h1 class="xp-title">A list of links, <em>not a playlist</em></h1>
    <p class="xp-lede">Apple Podcasts doesn’t let other apps create playlists. Here are the ${c.items.length} Apple Podcasts links in order, so you can open them one by one or keep them in your notes.</p>
    <pre class="link-list" tabindex="0">${esc(lines)}</pre>
    <div class="btn-row center">
      <button class="btn btn-primary" data-copy-linklist>${icon('copy')} Copy list</button>
      <button class="btn btn-ghost" data-download-linklist>${icon('export')} Download .txt</button>
      <button class="btn btn-ghost" data-xp-go="dest">Choose another app</button>
    </div>
  </div>`;
}

/* ---------- event wiring (delegated from app.js) ---------- */
function handleExportClick(e) {
  const t = e.target;
  const dest = t.closest('[data-dest]');
  if (dest) {
    X.dest = dest.dataset.dest; X.decisions = {}; X.plan = null; X.linkInDesc = {};
    if (X.dest === 'apple') { X.step = 'links'; renderExportStep(); return true; }
    setStep(state.connected[X.dest] ? 'connect' : 'connect');
    return true;
  }
  const goEl = t.closest('[data-xp-go]');
  if (goEl) { setStep(goEl.dataset.xpGo); return true; }
  const conn = t.closest('[data-connect]');
  if (conn) { connectFlow(conn.dataset.connect); return true; }
  const disc = t.closest('[data-disconnect]');
  if (disc) {
    confirmModal({ title: `Disconnect ${SOURCES[disc.dataset.disconnect].name}?`, body: 'We’ll delete the access token straight away. Playlists you’ve already exported stay in your account.', confirm: 'Disconnect', danger: true })
      .then(ok => { if (ok) { delete state.connected[disc.dataset.disconnect]; persist(); toast('Disconnected'); renderExportStep(); } });
    return true;
  }
  const decide = t.closest('[data-decide]');
  if (decide) {
    const card = decide.closest('[data-rv]');
    const id = card.dataset.rv;
    X.decisions[id] = X.decisions[id] === decide.dataset.decide ? undefined : decide.dataset.decide;
    if (!X.decisions[id]) delete X.decisions[id];
    card.outerHTML = reviewCard(X.plan.find(p => p.id === id));
    refreshReviewChrome();
    $(`[data-rv="${id}"] [data-decide="${decide.dataset.decide}"]`)?.focus();
    return true;
  }
  if (t.closest('[data-confirm-export]')) {
    X.playlistName = $('#pl-name')?.value.trim() || collection(X.colId).name;
    setStep('result');
    return true;
  }
  const retry = t.closest('[data-retry]');
  if (retry) { retryItem(retry.dataset.retry, retry); return true; }
  if (t.closest('[data-open-dest]')) { toast(`Prototype: no real playlist was created in ${SOURCES[X.dest].name}`, { icon: 'info' }); return true; }
  if (t.closest('[data-copy-skipped]')) {
    const txt = X.result.skipped.map(p => sourceLink(EP[p.id])).join('\n');
    navigator.clipboard?.writeText(txt).catch(() => {});
    toast(`Copied ${X.result.skipped.length} links`);
    return true;
  }
  if (t.closest('[data-copy-linklist]')) {
    navigator.clipboard?.writeText($('.link-list').textContent).catch(() => {});
    toast('List copied. These are links, not a playlist');
    return true;
  }
  if (t.closest('[data-download-linklist]')) {
    const blob = new Blob([$('.link-list').textContent], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = collection(X.colId).name.replace(/[^\w]+/g, '-').toLowerCase() + '-links.txt';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    return true;
  }
  return false;
}

function handleExportChange(e) {
  const ld = e.target.closest('[data-link-desc]');
  if (ld) { X.linkInDesc[ld.dataset.linkDesc] = ld.checked; return true; }
  return false;
}
