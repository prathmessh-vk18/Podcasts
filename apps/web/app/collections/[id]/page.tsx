'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CollectionCover, Cover } from '@/components/Cover';
import { useOpenEpisode } from '@/components/Drawer';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toasts';
import { api } from '@/lib/api';
import { duration, PLATFORM_NAME } from '@/lib/format';
import { errorMessage, keys, useCollection } from '@/lib/hooks';
import type { CollectionItem } from '@/lib/types';

/** Ordered list with drag (mouse/touch) and keyboard (↑/↓ on the handle) reordering. */
function Sequence({ collectionId, items }: { collectionId: string; items: CollectionItem[] }) {
  const [order, setOrder] = useState(items);
  const [dragId, setDragId] = useState<string | null>(null);
  const drag = useRef<{
    id: string;
    startY: number;
    startIdx: number;
    idx: number;
    step: number;
    moved: boolean;
  } | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const open = useOpenEpisode();

  useEffect(() => setOrder(items), [items]);

  const persist = async (next: CollectionItem[], prev: CollectionItem[]) => {
    setOrder(next);
    try {
      await api.reorder(
        collectionId,
        next.map((i) => i.id),
      );
      void qc.invalidateQueries({ queryKey: keys.collection(collectionId) });
    } catch (err) {
      setOrder(prev);
      toast(errorMessage(err), { icon: 'alert' });
      void qc.invalidateQueries({ queryKey: keys.collection(collectionId) });
    }
  };

  const move = (from: number, to: number, focus = false) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    void persist(next, order);
    if (focus)
      requestAnimationFrame(() => listRef.current?.querySelectorAll<HTMLElement>('[data-grip]')[to]?.focus());
  };

  const remove = async (item: CollectionItem) => {
    const prev = order;
    setOrder(order.filter((i) => i.id !== item.id));
    try {
      await api.removeFromCollection(collectionId, item.id);
      void qc.invalidateQueries({ queryKey: keys.saved });
      void qc.invalidateQueries({ queryKey: keys.collections });
      void qc.invalidateQueries({ queryKey: keys.collection(collectionId) });
      toast(`Removed “${item.episode.title}”`, {
        icon: 'x',
        action: {
          label: 'Undo',
          run: async () => {
            // Re-adding appends to the end with a new item id; put it back where it was.
            const { item: restored } = await api.addToCollection(collectionId, item.episode);
            const ids = prev.map((p) => (p.id === item.id ? restored.id : p.id));
            await api.reorder(collectionId, ids).catch(() => {});
            void qc.invalidateQueries({ queryKey: keys.collection(collectionId) });
            void qc.invalidateQueries({ queryKey: keys.collections });
            void qc.invalidateQueries({ queryKey: keys.saved });
          },
        },
      });
    } catch (err) {
      setOrder(prev);
      toast(errorMessage(err), { icon: 'alert' });
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button > 0) return;
    const li = (e.currentTarget as HTMLElement).closest('li')!;
    const rows = [...listRef.current!.children] as HTMLElement[];
    const startIdx = rows.indexOf(li);
    const gap =
      rows.length > 1 ? rows[1]!.getBoundingClientRect().top - rows[0]!.getBoundingClientRect().bottom : 10;
    drag.current = {
      id,
      startY: e.clientY,
      startIdx,
      idx: startIdx,
      step: li.getBoundingClientRect().height + gap,
      moved: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.abs(dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      setDragId(d.id);
    }
    const idx = Math.max(0, Math.min(order.length - 1, d.startIdx + Math.round(dy / d.step)));
    d.idx = idx;
    const rows = [...listRef.current!.children] as HTMLElement[];
    rows.forEach((row, i) => {
      if (i === d.startIdx) row.style.transform = `translateY(${dy}px) scale(1.02)`;
      else {
        const shift =
          d.startIdx < idx && i > d.startIdx && i <= idx
            ? -d.step
            : d.startIdx > idx && i >= idx && i < d.startIdx
              ? d.step
              : 0;
        row.style.transform = shift ? `translateY(${shift}px)` : '';
      }
    });
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    [...listRef.current!.children].forEach((row) => ((row as HTMLElement).style.transform = ''));
    setDragId(null);
    move(d.startIdx, d.idx);
  };

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      move(idx, idx - 1, true);
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      move(idx, idx + 1, true);
    }
  };

  if (order.length === 0) {
    return (
      <ol className="seq">
        <li className="empty empty-seq">
          <h3 className="empty-title">An empty canvas</h3>
          <p>Save episodes from Discover and they&apos;ll appear here, ready to put in order.</p>
          <Link className="btn btn-primary" href="/">
            <Icon name="search" /> Find episodes
          </Link>
        </li>
      </ol>
    );
  }

  return (
    <ol className={`seq${dragId ? ' sorting' : ''}`} ref={listRef} aria-describedby="seq-help">
      {order.map((item, i) => (
        <li key={item.id} className={`seq-item${dragId === item.id ? ' dragging' : ''}`}>
          <button
            className="seq-grip"
            data-grip
            aria-label={`Reorder ${item.episode.title}, position ${i + 1} of ${order.length}`}
            onPointerDown={(e) => onPointerDown(e, item.id)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={(e) => onKey(e, i)}
          >
            <Icon name="grip" />
          </button>
          <span className="seq-n">{String(i + 1).padStart(2, '0')}</span>
          <button className="seq-main" onClick={() => open(item.episode)}>
            <span className="seq-art">
              <Cover url={item.episode.artworkUrl} name={item.episode.show} size={100} />
            </span>
            <span className="seq-txt">
              <b>{item.episode.title}</b>
              <small>
                {item.episode.show} · {duration(item.episode.durationSec)}
              </small>
            </span>
          </button>
          <span className="seq-src">
            <span className="src-tag">{PLATFORM_NAME[item.episode.platform]}</span>
          </span>
          <span className="seq-ctl">
            <button
              className="icon-btn icon-btn-sm"
              aria-label="Move up"
              disabled={i === 0}
              onClick={() => move(i, i - 1)}
            >
              <Icon name="up" />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="Move down"
              disabled={i === order.length - 1}
              onClick={() => move(i, i + 1)}
            >
              <Icon name="down" />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              aria-label="Remove from collection"
              onClick={() => void remove(item)}
            >
              <Icon name="x" />
            </button>
          </span>
        </li>
      ))}
    </ol>
  );
}

export default function CollectionPage() {
  const { id } = useParams<{ id: string }>();
  const { data: col, isLoading, error } = useCollection(id);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');

  useEffect(() => {
    if (col) setName(col.name);
  }, [col]);

  if (isLoading)
    return (
      <section className="wrap page-head">
        <div className="sk" style={{ height: 360, borderRadius: 30 }} />
      </section>
    );
  if (error || !col) {
    return (
      <section className="wrap page-head">
        <p className="sec-idx">Not found</p>
        <h1 className="page-title">
          Lost the <em>thread.</em>
        </h1>
        <p className="page-lede">This collection doesn&apos;t exist, or it was deleted.</p>
        <Link className="btn btn-primary" href="/library">
          Back to library
        </Link>
      </section>
    );
  }

  const rename = async () => {
    const v = name.trim();
    if (!v || v === col.name) return setName(col.name);
    try {
      await api.updateCollection(col.id, { name: v });
      void qc.invalidateQueries({ queryKey: keys.collection(col.id) });
      void qc.invalidateQueries({ queryKey: keys.collections });
      toast('Renamed collection');
    } catch (err) {
      setName(col.name);
      toast(errorMessage(err), { icon: 'alert' });
    }
  };

  const remove = async () => {
    try {
      await api.deleteCollection(col.id);
      void qc.invalidateQueries({ queryKey: keys.collections });
      void qc.invalidateQueries({ queryKey: keys.saved });
      router.push('/library');
      toast(`Deleted ${col.name}`, {
        icon: 'trash',
        action: {
          label: 'Undo',
          run: async () => {
            await api.restoreCollection(col.id);
            void qc.invalidateQueries({ queryKey: keys.collections });
            void qc.invalidateQueries({ queryKey: keys.saved });
            router.push(`/collections/${col.id}`);
          },
        },
      });
    } catch (err) {
      toast(errorMessage(err), { icon: 'alert' });
    }
  };

  return (
    <section className="col-page">
      <div className="col-bg" aria-hidden="true">
        {col.items[0] && (
          <Cover url={col.items[0].episode.artworkUrl} name={col.items[0].episode.show} size={100} />
        )}
      </div>
      <div className="wrap col-grid">
        <aside className="col-side">
          <Link className="back-link" href="/library">
            <Icon name="arrowL" /> Library
          </Link>
          <div className="col-cover">
            <CollectionCover episodes={col.items.map((i) => i.episode)} size={600} />
          </div>
          <div className="col-info">
            <label className="sr-only" htmlFor="col-name">
              Collection name
            </label>
            <input
              className="col-name"
              id="col-name"
              value={name}
              maxLength={120}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => void rename()}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            />
            <p className="col-stats">
              <span>
                <b>{col.items.length}</b> episodes
              </span>
              <span>
                <b>{duration(col.items.reduce((a, i) => a + (i.episode.durationSec ?? 0), 0))}</b>
              </span>
            </p>
            <div className="col-actions">
              {col.items.length > 0 ? (
                <Link className="btn btn-primary btn-block" href={`/collections/${col.id}/export`}>
                  <Icon name="export" /> Export to a listening app
                </Link>
              ) : (
                <button className="btn btn-primary btn-block" disabled>
                  <Icon name="export" /> Export to a listening app
                </button>
              )}
              <div className="btn-row">
                <button className="icon-btn" onClick={() => void remove()} aria-label="Delete collection">
                  <Icon name="trash" />
                </button>
              </div>
            </div>
          </div>
        </aside>
        <section className="col-main" aria-labelledby="seq-h">
          <header className="seq-head">
            <div>
              <p className="sec-idx">Listening order</p>
              <h2 className="sec-title" id="seq-h">
                Arrange your <em>sequence</em>
              </h2>
            </div>
            <p className="seq-hint">
              <Icon name="grip" /> Drag to reorder, or focus a handle and use ↑ ↓
            </p>
          </header>
          <Sequence collectionId={col.id} items={col.items} />
          <p id="seq-help" className="sr-only">
            Each episode has a reorder handle. Focus it and press arrow up or arrow down to move the episode.
          </p>
        </section>
      </div>
    </section>
  );
}
