import { and, asc, count, desc, eq, isNull, isNotNull, max, sql } from 'drizzle-orm';
import { DomainError } from '@tangent/core';
import type { Db } from '../client.js';
import { collectionItems, collections, episodes } from '../schema.js';
import type { EpisodeRow } from './catalog.js';

export type CollectionRow = typeof collections.$inferSelect;
export type CollectionItemRow = typeof collectionItems.$inferSelect;

export const MAX_ITEMS_PER_COLLECTION = 500;

export function collectionsRepo(db: Db) {
  const owned = (id: string, userId: string) =>
    and(eq(collections.id, id), eq(collections.userId, userId), isNull(collections.deletedAt));

  return {
    async create(input: { userId: string; name: string; description?: string }): Promise<CollectionRow> {
      const [row] = await db
        .insert(collections)
        .values({ userId: input.userId, name: input.name, description: input.description ?? '' })
        .returning();
      return row!;
    },

    async list(userId: string): Promise<Array<CollectionRow & { itemCount: number }>> {
      const rows = await db
        .select({ c: collections, itemCount: count(collectionItems.id) })
        .from(collections)
        .leftJoin(collectionItems, eq(collectionItems.collectionId, collections.id))
        .where(and(eq(collections.userId, userId), isNull(collections.deletedAt)))
        .groupBy(collections.id)
        .orderBy(desc(collections.updatedAt));
      return rows.map((r) => ({ ...r.c, itemCount: Number(r.itemCount) }));
    },

    /** Returns null for missing, deleted or someone else's collection (don't leak existence). */
    async get(id: string, userId: string): Promise<CollectionRow | null> {
      const [row] = await db.select().from(collections).where(owned(id, userId)).limit(1);
      return row ?? null;
    },

    async update(
      id: string,
      userId: string,
      patch: { name?: string; description?: string; privacy?: 'private' | 'link' },
    ): Promise<CollectionRow | null> {
      const [row] = await db
        .update(collections)
        .set({ ...patch, updatedAt: sql`now()` })
        .where(owned(id, userId))
        .returning();
      return row ?? null;
    },

    async softDelete(id: string, userId: string, now: Date): Promise<boolean> {
      const rows = await db
        .update(collections)
        .set({ deletedAt: now })
        .where(owned(id, userId))
        .returning({ id: collections.id });
      return rows.length > 0;
    },

    async restore(id: string, userId: string): Promise<CollectionRow | null> {
      const [row] = await db
        .update(collections)
        .set({ deletedAt: null, updatedAt: sql`now()` })
        .where(and(eq(collections.id, id), eq(collections.userId, userId), isNotNull(collections.deletedAt)))
        .returning();
      return row ?? null;
    },

    async items(collectionId: string): Promise<Array<{ item: CollectionItemRow; episode: EpisodeRow }>> {
      const rows = await db
        .select({ item: collectionItems, episode: episodes })
        .from(collectionItems)
        .innerJoin(episodes, eq(episodes.id, collectionItems.episodeId))
        .where(eq(collectionItems.collectionId, collectionId))
        .orderBy(asc(collectionItems.position), asc(collectionItems.addedAt));
      return rows;
    },

    /**
     * Append an episode. Locks the collection row so concurrent adds get distinct positions.
     * Adding an episode that is already there is a no-op (`added: false`), not an error.
     */
    async addItem(
      collectionId: string,
      episodeId: string,
    ): Promise<{ item: CollectionItemRow; added: boolean }> {
      return db.transaction(async (tx) => {
        await tx.execute(sql`select id from ${collections} where id = ${collectionId} for update`);
        const [existing] = await tx
          .select()
          .from(collectionItems)
          .where(
            and(eq(collectionItems.collectionId, collectionId), eq(collectionItems.episodeId, episodeId)),
          )
          .limit(1);
        if (existing) return { item: existing, added: false };

        const [stats] = await tx
          .select({ n: count(collectionItems.id), maxPos: max(collectionItems.position) })
          .from(collectionItems)
          .where(eq(collectionItems.collectionId, collectionId));
        if (Number(stats?.n ?? 0) >= MAX_ITEMS_PER_COLLECTION) {
          throw new DomainError(
            'validation',
            `A collection can hold at most ${MAX_ITEMS_PER_COLLECTION} episodes`,
          );
        }
        const position = stats?.maxPos === null || stats?.maxPos === undefined ? 0 : Number(stats.maxPos) + 1;
        const [item] = await tx
          .insert(collectionItems)
          .values({ collectionId, episodeId, position })
          .returning();
        await tx
          .update(collections)
          .set({ updatedAt: sql`now()` })
          .where(eq(collections.id, collectionId));
        return { item: item!, added: true };
      });
    },

    async removeItem(collectionId: string, itemId: string): Promise<boolean> {
      const rows = await db
        .delete(collectionItems)
        .where(and(eq(collectionItems.id, itemId), eq(collectionItems.collectionId, collectionId)))
        .returning({ id: collectionItems.id });
      if (rows.length)
        await db
          .update(collections)
          .set({ updatedAt: sql`now()` })
          .where(eq(collections.id, collectionId));
      return rows.length > 0;
    },

    /**
     * Replace the order with `orderedItemIds`, which must be exactly the current items.
     * Rejecting partial or stale lists prevents two tabs from silently dropping items.
     */
    async reorder(collectionId: string, orderedItemIds: string[]): Promise<void> {
      await db.transaction(async (tx) => {
        await tx.execute(sql`select id from ${collections} where id = ${collectionId} for update`);
        const current = await tx
          .select({ id: collectionItems.id })
          .from(collectionItems)
          .where(eq(collectionItems.collectionId, collectionId));
        const currentIds = new Set(current.map((r) => r.id));
        const unique = new Set(orderedItemIds);
        if (unique.size !== orderedItemIds.length)
          throw new DomainError('validation', 'The order contains the same item twice');
        if (unique.size !== currentIds.size || [...unique].some((id) => !currentIds.has(id))) {
          throw new DomainError(
            'conflict',
            'The collection changed since you loaded it. Refresh and try again.',
            {
              expected: currentIds.size,
              received: unique.size,
            },
          );
        }
        for (let i = 0; i < orderedItemIds.length; i++) {
          await tx
            .update(collectionItems)
            .set({ position: i })
            .where(eq(collectionItems.id, orderedItemIds[i]!));
        }
        await tx
          .update(collections)
          .set({ updatedAt: sql`now()` })
          .where(eq(collections.id, collectionId));
      });
    },
  };
}
