'use client';

import { useEffect, useRef, useState } from 'react';
import { savedKey } from '@/lib/api';
import { duration, PLATFORM_NAME, PLATFORM_SHORT, popularity } from '@/lib/format';
import { useSaved } from '@/lib/hooks';
import type { EpisodeLike } from '@/lib/types';
import { Cover } from './Cover';
import { useOpenEpisode } from './Drawer';
import { Icon } from './Icon';
import { SaveList } from './SaveList';

/** Subtle 3D tilt that follows the pointer (fine pointers only, respects reduced motion). */
function useTilt<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (
      !el ||
      !matchMedia('(pointer: fine)').matches ||
      matchMedia('(prefers-reduced-motion: reduce)').matches
    )
      return;
    const move = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width - 0.5,
        y = (e.clientY - r.top) / r.height - 0.5;
      el.style.setProperty('--rx', `${(-y * 6).toFixed(2)}deg`);
      el.style.setProperty('--ry', `${(x * 8).toFixed(2)}deg`);
    };
    const leave = () => {
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerleave', leave);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerleave', leave);
    };
  }, []);
  return ref;
}

/** "+" button that opens a small save menu anchored to the card. */
function QuickSave({ episode }: { episode: EpisodeLike }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const saved = (useSaved().data?.saved[savedKey(episode)]?.length ?? 0) > 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="quick-save" ref={wrap}>
      <button
        className={`save-fab${saved ? ' on' : ''}`}
        aria-label={saved ? 'Saved. Change collections' : 'Save to collection'}
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <Icon name={saved ? 'check' : 'plus'} />
      </button>
      {open && (
        <div
          className="popover in"
          role="dialog"
          aria-label="Save to collection"
          onClick={(e) => e.stopPropagation()}
        >
          <SaveList episode={episode} autoFocus />
        </div>
      )}
    </div>
  );
}

export function EpisodeCard({ episode, rank }: { episode: EpisodeLike; rank?: number }) {
  const open = useOpenEpisode();
  const tilt = useTilt<HTMLElement>();
  const pop = popularity(episode.popularity);
  return (
    <article className="ep-card" data-tilt ref={tilt}>
      <button
        className="card-hit"
        onClick={() => open(episode)}
        aria-label={`${episode.title}, ${episode.show}, on ${PLATFORM_NAME[episode.platform]}`}
      />
      <div className="ep-art">
        <Cover url={episode.artworkUrl} name={episode.show} />
        {episode.durationSec ? <span className="ep-dur">{duration(episode.durationSec)}</span> : null}
      </div>
      <div className="ep-body">
        <div className="ep-top">
          <span className="src-tag">{PLATFORM_NAME[episode.platform]}</span>
          {rank ? <span className="ep-rank">{String(rank).padStart(2, '0')}</span> : null}
        </div>
        <h3 className="ep-title">{episode.title}</h3>
        <p className="ep-show">{episode.show}</p>
        {pop && (
          <div className="ep-foot">
            <span
              className={`metric${episode.popularity?.available ? '' : ' metric-none'}`}
              title={pop.detail}
            >
              <b>{pop.label}</b>
            </span>
          </div>
        )}
      </div>
      <QuickSave episode={episode} />
    </article>
  );
}

export function PinCard({
  episode,
  index,
  showDescription,
}: {
  episode: EpisodeLike;
  index: number;
  showDescription: boolean;
}) {
  const open = useOpenEpisode();
  const tilt = useTilt<HTMLElement>();
  return (
    <article className="pin" data-tilt ref={tilt} style={{ ['--i' as string]: index % 12 }}>
      <button
        className="card-hit"
        onClick={() => open(episode)}
        aria-label={`${episode.title}, ${episode.show}`}
      />
      <div className="pin-art">
        <Cover url={episode.artworkUrl} name={episode.show} />
        {episode.durationSec ? <span className="ep-dur">{duration(episode.durationSec)}</span> : null}
      </div>
      <div className="pin-body">
        <h3 className="pin-title">{episode.title}</h3>
        {showDescription && episode.description && <p className="pin-desc">{episode.description}</p>}
        <div className="pin-meta">
          <span className="pin-show">{episode.show}</span>
          <span className="src-tag">{PLATFORM_SHORT[episode.platform]}</span>
        </div>
      </div>
      <QuickSave episode={episode} />
    </article>
  );
}

export function CardSkeletons({ n = 5 }: { n?: number }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="ep-card skel" aria-hidden="true">
          <div className="ep-art sk" />
          <div className="ep-body">
            <i className="sk sk-line w40" />
            <i className="sk sk-line w90" />
            <i className="sk sk-line w60" />
          </div>
        </div>
      ))}
    </>
  );
}
