'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, savedKey } from './api';
import type { CollectionDetail, EpisodeLike } from './types';

export const keys = {
  saved: ['saved'] as const,
  collections: ['collections'] as const,
  collection: (id: string) => ['collection', id] as const,
  exportJob: (id: string) => ['export', id] as const,
};

export const useSaved = () => useQuery({ queryKey: keys.saved, queryFn: api.saved, staleTime: 30_000 });
export const useCollections = () => useQuery({ queryKey: keys.collections, queryFn: api.collections });
export const useCollection = (id: string) =>
  useQuery({
    queryKey: keys.collection(id),
    queryFn: () => api.collection(id),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });

/** Add or remove an episode from a collection, keeping every cached view in sync. */
export function useToggleSave() {
  const qc = useQueryClient();
  const invalidate = (collectionId: string) => {
    void qc.invalidateQueries({ queryKey: keys.saved });
    void qc.invalidateQueries({ queryKey: keys.collections });
    void qc.invalidateQueries({ queryKey: keys.collection(collectionId) });
  };

  const add = useMutation({
    mutationFn: ({ collectionId, episode }: { collectionId: string; episode: EpisodeLike }) =>
      api.addToCollection(collectionId, episode),
    onSuccess: (_d, v) => invalidate(v.collectionId),
  });

  const remove = useMutation({
    mutationFn: async ({ collectionId, episode }: { collectionId: string; episode: EpisodeLike }) => {
      // The saved map only knows collection ids; find the item id in the collection itself.
      const detail = await qc.fetchQuery<CollectionDetail>({
        queryKey: keys.collection(collectionId),
        queryFn: () => api.collection(collectionId),
      });
      const item = detail.items.find((i) => savedKey(i.episode) === savedKey(episode));
      if (item) await api.removeFromCollection(collectionId, item.id);
    },
    onSuccess: (_d, v) => invalidate(v.collectionId),
  });

  return { add, remove };
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return 'Something went wrong. Please try again.';
}
