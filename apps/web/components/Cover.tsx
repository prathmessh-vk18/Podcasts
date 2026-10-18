'use client';

import { useState } from 'react';
import { art, initials } from '@/lib/format';

/** Real podcast artwork with an initials fallback if the image fails to load. */
export function Cover({
  url,
  name,
  size = 400,
  className = '',
}: {
  url: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const src = art(url, size);
  if (!src || failed) return <div className={`cover-fallback ${className}`}>{initials(name)}</div>;
  return (
    // Remote artwork from Apple/YouTube CDNs: Next's optimizer would add cost for no gain here.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className={`cover-img ${className}`}
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

/** Collection cover: a mosaic of its first episodes' artwork. */
export function CollectionCover({
  episodes,
  size = 400,
}: {
  episodes: Array<{ artworkUrl: string | null; show: string }>;
  size?: number;
}) {
  const seen = new Set<string>();
  const distinct = episodes.filter((e) =>
    e.artworkUrl && !seen.has(e.artworkUrl) ? (seen.add(e.artworkUrl), true) : false,
  );
  if (episodes.length === 0) {
    return (
      <div className="cc cc-empty" aria-hidden="true">
        <span />
      </div>
    );
  }
  if (distinct.length < 4) {
    const e = distinct[0] ?? episodes[0]!;
    return (
      <div className="cc cc-single" aria-hidden="true">
        <Cover url={e.artworkUrl} name={e.show} size={size} />
        <i className="cc-shade" />
      </div>
    );
  }
  return (
    <div className="cc cc-mosaic" aria-hidden="true">
      {distinct.slice(0, 4).map((e) => (
        <Cover key={e.artworkUrl} url={e.artworkUrl} name={e.show} size={Math.round(size / 2)} />
      ))}
      <i className="cc-shade" />
    </div>
  );
}
