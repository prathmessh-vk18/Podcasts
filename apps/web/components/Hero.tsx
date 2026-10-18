'use client';

import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { art } from '@/lib/format';
import { Icon } from './Icon';

const SUGGESTIONS = ['Decisions', 'Sleep', 'Investing', 'AI', 'Founders'];

/** Two walls of real covers receding to a vanishing point behind the headline. */
function Tunnel({ artwork }: { artwork: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const lanes = useMemo(() => {
    if (artwork.length === 0) return null;
    return [0, 1].map((side) =>
      Array.from({ length: 4 }, (_, l) => {
        const start = (side * 4 + l) * 7;
        return Array.from({ length: 11 }, (_, k) => artwork[(start + k) % artwork.length]!);
      }),
    );
  }, [artwork]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const hero = el.parentElement!;
    const io = new IntersectionObserver(([e]) => el.classList.toggle('paused', !e?.isIntersecting));
    io.observe(hero);
    if (!matchMedia('(pointer: fine)').matches || matchMedia('(prefers-reduced-motion: reduce)').matches)
      return () => io.disconnect();
    const move = (e: PointerEvent) => {
      const r = hero.getBoundingClientRect();
      el.style.perspectiveOrigin = `${50 + ((e.clientX - r.left) / r.width - 0.5) * 14}% ${46 + ((e.clientY - r.top) / r.height - 0.5) * 12}%`;
    };
    hero.addEventListener('pointermove', move);
    return () => {
      io.disconnect();
      hero.removeEventListener('pointermove', move);
    };
  }, []);

  return (
    <div className="tunnel" aria-hidden="true" ref={ref}>
      {lanes?.map((side, s) => (
        <div key={s} className={`wall ${s === 0 ? 'wall-l' : 'wall-r'}`}>
          {side.map((covers, l) => (
            <div key={l} className="lane" style={{ ['--dur' as string]: `${70 + ((l * 17 + s * 9) % 40)}s` }}>
              <div className="lane-track">
                {[...covers, ...covers].map((src, k) => (
                  <span key={k} className="tl-card">
                    {/* eslint-disable-next-line @next/next/no-img-element -- decorative remote artwork */}
                    <img
                      className="cover-img"
                      src={art(src, 200) ?? ''}
                      alt=""
                      loading="lazy"
                      decoding="async"
                    />
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function Hero({
  artwork,
  episodeCount,
  showCount,
  onSearch,
}: {
  artwork: string[];
  episodeCount: number;
  showCount: number;
  onSearch: (q: string) => void;
}) {
  const [q, setQ] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (q.trim()) onSearch(q.trim());
  };

  // "/" focuses search, as most search-first products do.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !/input|textarea/i.test((document.activeElement as HTMLElement)?.tagName)) {
        e.preventDefault();
        document.getElementById('q')?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <section className="hero" aria-labelledby="hero-title" id="search">
      <Tunnel artwork={artwork} />
      <div className="hero-fog" aria-hidden="true" />
      <div className="wrap hero-inner">
        {episodeCount > 0 && (
          <p className="hero-eyebrow">
            <span className="live-dot" />
            {episodeCount.toLocaleString()} episodes from {showCount} shows
          </p>
        )}
        <h1 className="hero-title" id="hero-title">
          <span className="ln">
            <span>Find your next</span>
          </span>
          <span className="ln">
            <span>big idea</span>
          </span>
        </h1>
        <p className="hero-sub">
          Discover episodes across YouTube, Spotify and Apple Podcasts. Save them once, listen anywhere.
        </p>
        <form className="search" role="search" onSubmit={submit}>
          <Icon name="search" className="search-ic" />
          <label className="sr-only" htmlFor="q">
            Search episodes, shows, people
          </label>
          <input
            id="q"
            type="search"
            autoComplete="off"
            placeholder="How to make better decisions"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={200}
          />
          <button className={`search-go${q.trim() ? ' ready' : ''}`} type="submit" aria-label="Search">
            <Icon name="arrowUp" />
          </button>
        </form>
        <div className="suggest" aria-label="Suggested searches">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              className="chip"
              onClick={() => {
                setQ(s);
                onSearch(s);
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
