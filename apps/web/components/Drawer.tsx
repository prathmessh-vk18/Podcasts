'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { clock, date, PLATFORM_NAME, popularity } from '@/lib/format';
import type { EpisodeLike } from '@/lib/types';
import { Cover } from './Cover';
import { Icon } from './Icon';
import { SaveList } from './SaveList';

const DrawerContext = createContext<(ep: EpisodeLike) => void>(() => {});
export const useOpenEpisode = () => useContext(DrawerContext);

/** Episode detail panel. One instance for the whole app; any card can open it. */
export function DrawerProvider({ children }: { children: ReactNode }) {
  const [episode, setEpisode] = useState<EpisodeLike | null>(null);
  const [visible, setVisible] = useState(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const panel = useRef<HTMLElement>(null);

  const open = useCallback((ep: EpisodeLike) => {
    returnFocus.current = document.activeElement as HTMLElement | null;
    setEpisode(ep);
    requestAnimationFrame(() => setVisible(true));
  }, []);

  const close = useCallback(() => {
    setVisible(false);
    setTimeout(() => setEpisode(null), 380);
    returnFocus.current?.focus?.();
  }, []);

  useEffect(() => {
    if (!episode) return;
    document.body.classList.add('locked');
    panel.current?.querySelector<HTMLElement>('.drawer-x')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input')];
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) {
          e.preventDefault();
          f[f.length - 1]!.focus();
        } else if (!e.shiftKey && document.activeElement === f[f.length - 1]) {
          e.preventDefault();
          f[0]!.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.body.classList.remove('locked');
      document.removeEventListener('keydown', onKey);
    };
  }, [episode, close]);

  const pop = episode ? popularity(episode.popularity) : null;

  return (
    <DrawerContext.Provider value={open}>
      {children}
      {episode && (
        <div className={`drawer-wrap${visible ? ' in' : ''}`}>
          <div className="drawer-scrim" onClick={close} />
          <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="ep-title" ref={panel}>
            <button className="icon-btn drawer-x" onClick={close} aria-label="Close episode">
              <Icon name="x" />
            </button>
            <div className="drawer-hero">
              <div className="drawer-bg">
                <Cover url={episode.artworkUrl} name={episode.show} size={100} />
              </div>
              <div className="drawer-cover">
                <Cover url={episode.artworkUrl} name={episode.show} size={600} />
              </div>
            </div>
            <div className="drawer-body">
              <div className="drawer-meta-top">
                <span className="src-tag solid">{PLATFORM_NAME[episode.platform]}</span>
              </div>
              <h2 id="ep-title" className="drawer-title">
                {episode.title}
              </h2>
              <p className="drawer-show">
                <b>{episode.show}</b>
              </p>
              {episode.description && <p className="drawer-note">{episode.description}</p>}
              <dl className="facts">
                <div>
                  <dt>Duration</dt>
                  <dd>{clock(episode.durationSec)}</dd>
                </div>
                <div>
                  <dt>Published</dt>
                  <dd>{date(episode.publishedAt) || '—'}</dd>
                </div>
                <div>
                  <dt>Source</dt>
                  <dd>{PLATFORM_NAME[episode.platform]}</dd>
                </div>
              </dl>
              {pop && (
                <section className="d-sec">
                  <h3 className="d-h">Popularity</h3>
                  <span className="metric">
                    <b>{pop.label}</b>
                    <span className="metric-src">{pop.detail} · not comparable across platforms</span>
                  </span>
                </section>
              )}
              <section className="d-sec">
                <h3 className="d-h">Source</h3>
                <div className="source-card">
                  <div>
                    <p className="source-card-k">On {PLATFORM_NAME[episode.platform]}</p>
                    <code className="source-url">{episode.url.replace(/^https?:\/\/(www\.)?/, '')}</code>
                  </div>
                  <a
                    className="btn btn-sm btn-ghost"
                    href={episode.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Icon name="ext" /> Open
                  </a>
                </div>
              </section>
              <section className="d-sec">
                <SaveList episode={episode} />
              </section>
            </div>
          </aside>
        </div>
      )}
    </DrawerContext.Provider>
  );
}
