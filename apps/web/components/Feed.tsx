'use client';

import { useInfiniteQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import type { Episode, Topic } from '@/lib/types';
import { PinCard } from './Cards';
import { Icon } from './Icon';

function columnsFor(width: number) {
  return width >= 1180 ? 5 : width >= 880 ? 4 : width >= 560 ? 3 : 2;
}

/** Deterministic "does this card show a description" so heights vary like a Pinterest board. */
const withDescription = (id: string) => [...id].reduce((a, c) => a + c.charCodeAt(0), 0) % 3 === 0;

/** Rough card height, used to place each card in the shortest column without measuring the DOM. */
function estimate(ep: Episode, colWidth: number) {
  const titleLines = Math.ceil(ep.title.length / Math.max(18, colWidth / 9));
  return colWidth + 70 + titleLines * 21 + (withDescription(ep.id) && ep.description ? 84 : 0);
}

export function ExploreFeed({ topics }: { topics: Topic[] }) {
  const [topic, setTopic] = useState<string | null>(null);
  const [width, setWidth] = useState(1200);
  const host = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const query = useInfiniteQuery({
    queryKey: ['feed', topic],
    queryFn: ({ pageParam }) => api.feed(topic, pageParam, 24),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    // A fresh database fills in the background; poll until episodes appear.
    refetchInterval: (q) => (q.state.data?.pages[0]?.warming ? 4000 : false),
  });

  useEffect(() => {
    if (!host.current) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  const { hasNextPage, isFetchingNextPage, fetchNextPage } = query;
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([e]) => {
        if (e?.isIntersecting && hasNextPage && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '900px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const n = columnsFor(width);
  const columns = useMemo(() => {
    const colWidth = width / n;
    const cols: Array<{ h: number; items: Array<{ ep: Episode; i: number }> }> = Array.from(
      { length: n },
      () => ({ h: 0, items: [] }),
    );
    items.forEach((ep, i) => {
      const target = cols.reduce((a, b) => (b.h < a.h ? b : a));
      target.items.push({ ep, i });
      target.h += estimate(ep, colWidth);
    });
    return cols;
  }, [items, n, width]);

  const warming = query.data?.pages[0]?.warming;
  const topicName = topic ? topics.find((t) => t.id === topic)?.name : null;

  return (
    <section className="sec explore-sec" aria-labelledby="explore-h" id="explore">
      <div className="wrap">
        <header className="sec-head">
          <div>
            <p className="sec-idx">Explore by idea</p>
            <h2 className="sec-title" id="explore-h">
              Follow an idea, <em>not a show.</em>
            </h2>
          </div>
        </header>
      </div>
      <div className="chip-bar">
        <div className="wrap chip-bar-inner" role="group" aria-label="Topics">
          <button
            className={`chip${topic === null ? ' on' : ''}`}
            aria-pressed={topic === null}
            onClick={() => setTopic(null)}
          >
            All
          </button>
          {topics.map((t) => (
            <button
              key={t.id}
              className={`chip${topic === t.id ? ' on' : ''}`}
              aria-pressed={topic === t.id}
              onClick={() => setTopic(t.id)}
            >
              {t.name}
            </button>
          ))}
        </div>
      </div>
      <div className="wrap">
        <div className="masonry" ref={host} style={{ ['--cols' as string]: n }} aria-busy={query.isLoading}>
          {query.isLoading || warming
            ? Array.from({ length: n }, (_, c) => (
                <div key={c} className="m-col">
                  {[0, 1].map((k) => (
                    <div key={k} className="pin skel" aria-hidden="true">
                      <div className="pin-art sk" />
                      <div className="pin-body">
                        <i className="sk sk-line w90" />
                        <i className="sk sk-line w60" />
                      </div>
                    </div>
                  ))}
                </div>
              ))
            : columns.map((col, c) => (
                <div key={c} className="m-col">
                  {col.items.map(({ ep, i }) => (
                    <PinCard key={ep.id} episode={ep} index={i} showDescription={withDescription(ep.id)} />
                  ))}
                </div>
              ))}
        </div>
        <div ref={sentinel} className="feed-sentinel" aria-hidden="true" />
        {warming && (
          <p className="feed-end">Loading the catalog for the first time. This takes about a minute…</p>
        )}
        {query.isError && (
          <div className="feed-end">
            <p>We couldn&apos;t load episodes.</p>
            <button className="btn btn-ghost btn-sm" onClick={() => void query.refetch()}>
              <Icon name="retry" /> Try again
            </button>
          </div>
        )}
        {isFetchingNextPage && <p className="feed-end">Loading more…</p>}
        {!hasNextPage && items.length > 0 && !warming && (
          <div className="feed-end">
            <span />
            <p>
              That&apos;s all {items.length} episodes{topicName ? ` in ${topicName}` : ''}.
            </p>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => document.getElementById('explore')?.scrollIntoView({ behavior: 'smooth' })}
            >
              <Icon name="up" /> Back to top
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
