'use client';

import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { CardSkeletons, EpisodeCard } from '@/components/Cards';
import { ExploreFeed } from '@/components/Feed';
import { Hero } from '@/components/Hero';
import { Icon } from '@/components/Icon';
import { api } from '@/lib/api';
import { PLATFORM_NAME } from '@/lib/format';
import type { Platform } from '@/lib/types';

/** YouTube search costs ~1% of the daily quota per query, so it's opt-in (product decision B). */
const DEFAULT_PLATFORMS: Platform[] = ['apple', 'spotify'];

function SearchResults({ query, onClear }: { query: string; onClear: () => void }) {
  const [withYouTube, setWithYouTube] = useState(false);
  const platforms = withYouTube ? [...DEFAULT_PLATFORMS, 'youtube' as const] : DEFAULT_PLATFORMS;
  const { data: providers } = useQuery({
    queryKey: ['providers'],
    queryFn: api.providers,
    staleTime: 60_000,
  });
  const youtubeAvailable = providers?.providers.some((p) => p.platform === 'youtube' && p.catalog);
  const search = useQuery({
    queryKey: ['search', query, platforms],
    queryFn: () => api.search(query, platforms),
    staleTime: 60_000,
  });

  const results = search.data?.results ?? {};
  const items = Object.values(results).flatMap((r) => r.items);
  const errors = Object.entries(results).filter(
    ([, r]) => r.error && r.error.code !== 'provider_not_configured',
  );

  return (
    <section className="wrap results on" aria-live="polite">
      <header className="results-head">
        <div>
          <p className="sec-idx">{search.isLoading ? 'Searching…' : `${items.length} results`}</p>
          <h2 className="sec-title">“{query}”</h2>
        </div>
        <div className="btn-row">
          {youtubeAvailable && (
            <button
              className={`chip${withYouTube ? ' on' : ''}`}
              aria-pressed={withYouTube}
              onClick={() => setWithYouTube((v) => !v)}
            >
              {withYouTube ? <Icon name="check" /> : <Icon name="plus" />} Also search YouTube
            </button>
          )}
          <button className="btn btn-ghost btn-sm" onClick={onClear}>
            <Icon name="x" /> Clear
          </button>
        </div>
      </header>
      {errors.length > 0 && (
        <p className="fineprint">
          <Icon name="info" />{' '}
          {errors.map(([p, r]) => `${PLATFORM_NAME[p as Platform]}: ${r.error!.message}`).join(' · ')}
        </p>
      )}
      <div className="result-grid">
        {search.isLoading ? (
          <CardSkeletons />
        ) : (
          items.map((ep) => <EpisodeCard key={`${ep.platform}:${ep.sourceId}`} episode={ep} />)
        )}
      </div>
      {!search.isLoading && items.length === 0 && (
        <div className="empty empty-sm">
          <h3 className="empty-title">Nothing found for “{query}”</h3>
          <p>Try a broader idea{youtubeAvailable && !withYouTube ? ', or include YouTube' : ''}.</p>
        </div>
      )}
    </section>
  );
}

export default function DiscoverPage() {
  const [query, setQuery] = useState<string | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);
  const trending = useQuery({ queryKey: ['trending'], queryFn: () => api.trending(16), staleTime: 60_000 });
  const topics = useQuery({ queryKey: ['topics'], queryFn: api.topics, staleTime: 5 * 60_000 });

  const artwork = useMemo(() => {
    const fromShows = topics.data?.topics.flatMap((t) => t.shows.map((s) => s.artworkUrl)) ?? [];
    const fromTrending = trending.data?.items.map((e) => e.artworkUrl) ?? [];
    return [...new Set([...fromShows, ...fromTrending].filter((u): u is string => !!u))];
  }, [topics.data, trending.data]);
  const episodeCount = topics.data?.topics.reduce((a, t) => a + t.episodeCount, 0) ?? 0;
  const showCount = topics.data?.topics.reduce((a, t) => a + t.shows.length, 0) ?? 0;

  const railRef = useRef<HTMLDivElement>(null);
  const scrollRail = (dir: number) =>
    railRef.current?.scrollBy({ left: dir * railRef.current.clientWidth * 0.8, behavior: 'smooth' });

  return (
    <>
      <Hero
        artwork={artwork}
        episodeCount={episodeCount}
        showCount={showCount}
        onSearch={(q) => {
          setQuery(q);
          requestAnimationFrame(() =>
            resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          );
        }}
      />
      <div ref={resultsRef} className="results-anchor">
        {query && <SearchResults key={query} query={query} onClear={() => setQuery(null)} />}
      </div>

      {(trending.isLoading || (trending.data?.items.length ?? 0) > 0) && (
        <section className="wrap sec" aria-labelledby="trend-h">
          <header className="sec-head">
            <div>
              <p className="sec-idx">New this week</p>
              <h2 className="sec-title" id="trend-h">
                Fresh from the shows <em>people learn from</em>
              </h2>
            </div>
            <div className="rail-nav">
              <button className="icon-btn" onClick={() => scrollRail(-1)} aria-label="Scroll left">
                <Icon name="arrowL" />
              </button>
              <button className="icon-btn" onClick={() => scrollRail(1)} aria-label="Scroll right">
                <Icon name="arrow" />
              </button>
            </div>
          </header>
          <div className="rail" ref={railRef} tabIndex={0} aria-label="New episodes">
            {trending.isLoading ? (
              <CardSkeletons n={6} />
            ) : (
              trending.data!.items.map((ep, i) => <EpisodeCard key={ep.id} episode={ep} rank={i + 1} />)
            )}
          </div>
          <p className="fineprint">
            <Icon name="info" /> Popularity numbers come from one platform each and are never ranked against
            each other.
          </p>
        </section>
      )}

      <ExploreFeed topics={topics.data?.topics ?? []} />
    </>
  );
}
