'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api, savedKey } from '@/lib/api';
import { errorMessage, keys, useCollections, useSaved, useToggleSave } from '@/lib/hooks';
import type { EpisodeLike } from '@/lib/types';
import { Icon } from './Icon';
import { useToast } from './Toasts';

/** "Save to collection" list used in the drawer and the quick-save popover. */
export function SaveList({ episode, autoFocus = false }: { episode: EpisodeLike; autoFocus?: boolean }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: cols, isLoading } = useCollections();
  const { data: saved } = useSaved();
  const { add, remove } = useToggleSave();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const inCollections = new Set(saved?.saved[savedKey(episode)] ?? []);

  const toggle = async (collectionId: string, collectionName: string) => {
    setBusy(collectionId);
    try {
      if (inCollections.has(collectionId)) {
        await remove.mutateAsync({ collectionId, episode });
        toast(`Removed from ${collectionName}`, {
          icon: 'x',
          action: { label: 'Undo', run: () => void add.mutateAsync({ collectionId, episode }) },
        });
      } else {
        await add.mutateAsync({ collectionId, episode });
        toast(`Saved to ${collectionName}`);
      }
    } catch (err) {
      toast(errorMessage(err), { icon: 'alert' });
    } finally {
      setBusy(null);
    }
  };

  const create = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy('new');
    try {
      const col = await api.createCollection(n);
      await add.mutateAsync({ collectionId: col.id, episode });
      void qc.invalidateQueries({ queryKey: keys.collections });
      toast(`Saved to new collection ${col.name}`);
      setCreating(false);
      setName('');
    } catch (err) {
      toast(errorMessage(err), { icon: 'alert' });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="save-list">
      <p className="save-list-head">Save to collection</p>
      {isLoading ? (
        <ul role="list">
          {[0, 1].map((i) => (
            <li key={i}>
              <div className="save-row sk" style={{ height: 58 }} />
            </li>
          ))}
        </ul>
      ) : (
        <ul role="list">
          {cols?.collections.map((c, i) => {
            const on = inCollections.has(c.id);
            return (
              <li key={c.id}>
                <button
                  className={`save-row${on ? ' on' : ''}`}
                  aria-pressed={on}
                  disabled={busy !== null}
                  autoFocus={autoFocus && i === 0}
                  onClick={() => toggle(c.id, c.name)}
                >
                  <span className="save-name">
                    {c.name}
                    <small>
                      {c.itemCount ?? 0} episode{c.itemCount === 1 ? '' : 's'}
                    </small>
                  </span>
                  <span className="save-check">
                    {busy === c.id ? <span className="spin" /> : <Icon name={on ? 'check' : 'plus'} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {creating ? (
        <form
          className="save-create"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <input
            className="input"
            autoFocus
            maxLength={120}
            placeholder="Collection name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="New collection name"
          />
          <button className="btn btn-primary btn-sm" disabled={!name.trim() || busy !== null}>
            {busy === 'new' ? <span className="spin" /> : 'Create'}
          </button>
        </form>
      ) : (
        <button
          className="save-new"
          onClick={() => setCreating(true)}
          autoFocus={autoFocus && !cols?.collections.length}
        >
          <Icon name="plus" /> New collection
        </button>
      )}
    </div>
  );
}
