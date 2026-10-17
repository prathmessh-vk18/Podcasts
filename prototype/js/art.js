/* Artwork: real podcast covers (Apple CDN), with an initials fallback if an image fails to load. */

function artUrl(url, size = 600) {
  return (url || '').replace(/\/\d+x\d+bb\.(jpg|png|webp)$/, `/${size}x${size}bb.$1`);
}

function initials(name) {
  return (name || '?').replace(/^The\s+/i, '').split(/[\s&’']+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function coverFail(img) {
  const d = document.createElement('div');
  d.className = 'cover-fallback ' + (img.className || '');
  d.textContent = img.dataset.fallback || '';
  img.replaceWith(d);
}

/* <img> for an episode or show cover. size: 100 | 200 | 400 | 600 */
function coverImg(ep, size = 400, cls = '') {
  const name = ep.showName || ep.short || ep.name || '';
  return `<img class="cover-img ${cls}" src="${artUrl(ep.art, size)}" alt="" loading="lazy" decoding="async" draggable="false" data-fallback="${initials(name)}" onerror="coverFail(this)">`;
}

/* Collection cover built from its episodes' real artwork. */
function collectionCover(c, size = 400) {
  const eps = c.items.map(id => EP[id]).filter(Boolean);
  const seen = new Set();
  const distinct = eps.filter(e => (seen.has(e.art) ? false : seen.add(e.art)));
  const tone = c.tone === 'violet' ? ' tone-violet' : '';
  if (!eps.length) return `<div class="cc cc-empty${tone}" aria-hidden="true"><span></span></div>`;
  if (c.layout === 'single') {
    return `<div class="cc cc-single${tone}" aria-hidden="true">${coverImg(eps[0], size)}<i class="cc-shade"></i></div>`;
  }
  if (c.layout === 'stack') {
    return `<div class="cc cc-stack${tone}" aria-hidden="true">${distinct.slice(0, 3).map((e, i) => `<span style="--i:${i}">${coverImg(e, Math.round(size / 2))}</span>`).join('')}</div>`;
  }
  const four = [...distinct, ...eps, ...eps, ...eps].slice(0, 4);
  return `<div class="cc cc-mosaic${tone}" aria-hidden="true">${four.map(e => coverImg(e, Math.round(size / 2))).join('')}<i class="cc-shade"></i></div>`;
}
