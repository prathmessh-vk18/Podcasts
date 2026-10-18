'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CollectionCover } from '@/components/Cover';
import { Icon } from '@/components/Icon';
import { useToast } from '@/components/Toasts';
import { api } from '@/lib/api';
import { errorMessage, keys, useCollections, useSaved } from '@/lib/hooks';

function NewCollection() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();

  if (!open) {
    return (
      <button className="tile-new" onClick={() => setOpen(true)}>
        <span>
          <Icon name="plus" />
        </span>
        <b>New collection</b>
        <small>Group episodes around something you want to learn</small>
      </button>
    );
  }
  return (
    <form
      className="tile-new tile-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim()) return;
        setBusy(true);
        try {
          const col = await api.createCollection(name.trim());
          await qc.invalidateQueries({ queryKey: keys.collections });
          router.push(`/collections/${col.id}`);
        } catch (err) {
          toast(errorMessage(err), { icon: 'alert' });
          setBusy(false);
        }
      }}
    >
      <b>Name your collection</b>
      <input
        className="input"
        autoFocus
        maxLength={120}
        placeholder="e.g. Thinking in probabilities"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Collection name"
      />
      <div className="btn-row center">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button className="btn btn-primary btn-sm" disabled={!name.trim() || busy}>
          {busy ? <span className="spin" /> : 'Create'}
        </button>
      </div>
    </form>
  );
}

export default function LibraryPage() {
  const { data, isLoading, isError, refetch } = useCollections();
  const saved = useSaved().data?.saved ?? {};
  const cols = data?.collections ?? [];
  const episodes = Object.keys(saved).length;

  return (
    <>
      <section className="wrap page-head lib-head">
        <div>
          <p className="sec-idx">My library</p>
          <h1 className="page-title">
            Your <em>library</em>
          </h1>
        </div>
        <dl className="lib-stats">
          <div>
            <dt>Collections</dt>
            <dd>{cols.length}</dd>
          </div>
          <div>
            <dt>Episodes</dt>
            <dd>{episodes}</dd>
          </div>
        </dl>
      </section>
      <section className="wrap sec shelf-sec" aria-label="Collections">
        {isError ? (
          <div className="empty">
            <h2 className="empty-title">We couldn&apos;t load your library</h2>
            <button className="btn btn-ghost" onClick={() => void refetch()}>
              <Icon name="retry" /> Try again
            </button>
          </div>
        ) : isLoading ? (
          <div className="shelf">
            {[0, 1, 2].map((i) => (
              <div key={i} className="tile sk" style={{ minHeight: 280 }} />
            ))}
          </div>
        ) : cols.length === 0 ? (
          <div className="empty">
            <div className="empty-art" aria-hidden="true">
              {[0, 1, 2, 3, 4].map((i) => (
                <i key={i} style={{ ['--i' as string]: i }} />
              ))}
            </div>
            <h2 className="empty-title">Your library is empty</h2>
            <p>Collections are where your learning lives. Start one, then save episodes from anywhere.</p>
            <div className="shelf shelf-solo">
              <NewCollection />
            </div>
            <Link className="btn btn-ghost" href="/">
              Discover episodes
            </Link>
          </div>
        ) : (
          <div className="shelf">
            {cols.map((c) => (
              <Link key={c.id} className="tile" href={`/collections/${c.id}`}>
                <div className="tile-cover">
                  <CollectionCover episodes={c.preview ?? []} />
                </div>
                <div className="tile-body">
                  <h3 className="tile-title">{c.name}</h3>
                  <p className="tile-meta">
                    {c.itemCount ?? 0} episode{c.itemCount === 1 ? '' : 's'}
                  </p>
                  <div className="tile-foot">
                    <span className="tile-privacy">
                      <Icon name={c.privacy === 'private' ? 'lock' : 'globe'} />
                      {c.privacy === 'private' ? 'Private' : 'Link'}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
            <NewCollection />
          </div>
        )}
      </section>
    </>
  );
}
