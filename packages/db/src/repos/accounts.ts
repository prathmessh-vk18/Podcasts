import { and, eq, isNull, lt, gt, or, isNotNull, sql } from 'drizzle-orm';
import type { Platform } from '@tangent/core';
import type { Db } from '../client.js';
import { oauthStates, providerAccounts, users } from '../schema.js';

export type AccountRow = typeof providerAccounts.$inferSelect;
export type OAuthStateRow = typeof oauthStates.$inferSelect;

export function usersRepo(db: Db) {
  return {
    async create(): Promise<string> {
      const [row] = await db.insert(users).values({}).returning({ id: users.id });
      return row!.id;
    },
    async exists(id: string): Promise<boolean> {
      const rows = await db.select({ id: users.id }).from(users).where(eq(users.id, id)).limit(1);
      return rows.length > 0;
    },
  };
}

export function accountsRepo(db: Db) {
  return {
    async get(userId: string, platform: Platform): Promise<AccountRow | null> {
      const [row] = await db
        .select()
        .from(providerAccounts)
        .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.platform, platform)))
        .limit(1);
      return row ?? null;
    },

    async listForUser(userId: string): Promise<AccountRow[]> {
      return db.select().from(providerAccounts).where(eq(providerAccounts.userId, userId));
    },

    /** Connecting again replaces the previous connection for that platform. */
    async upsert(input: {
      userId: string;
      platform: Platform;
      externalId: string;
      displayName: string | null;
      accessTokenEnc: string;
      refreshTokenEnc: string | null;
      expiresAt: Date;
      scopes: string[];
    }): Promise<AccountRow> {
      const [row] = await db
        .insert(providerAccounts)
        .values({ ...input, status: 'active' })
        .onConflictDoUpdate({
          target: [providerAccounts.userId, providerAccounts.platform],
          set: {
            externalId: input.externalId,
            displayName: input.displayName,
            accessTokenEnc: input.accessTokenEnc,
            refreshTokenEnc: input.refreshTokenEnc,
            expiresAt: input.expiresAt,
            scopes: input.scopes,
            status: 'active',
            updatedAt: sql`now()`,
          },
        })
        .returning();
      return row!;
    },

    async updateTokens(
      id: string,
      t: { accessTokenEnc: string; refreshTokenEnc: string | null; expiresAt: Date; scopes?: string[] },
    ): Promise<void> {
      await db
        .update(providerAccounts)
        .set({
          ...t,
          ...(t.scopes?.length ? { scopes: t.scopes } : {}),
          status: 'active',
          updatedAt: sql`now()`,
        })
        .where(eq(providerAccounts.id, id));
    },

    async markNeedsReauth(id: string): Promise<void> {
      await db
        .update(providerAccounts)
        .set({ status: 'needs_reauth', updatedAt: sql`now()` })
        .where(eq(providerAccounts.id, id));
    },

    async delete(userId: string, platform: Platform): Promise<AccountRow | null> {
      const [row] = await db
        .delete(providerAccounts)
        .where(and(eq(providerAccounts.userId, userId), eq(providerAccounts.platform, platform)))
        .returning();
      return row ?? null;
    },
  };
}

export function oauthStatesRepo(db: Db) {
  return {
    async create(input: {
      state: string;
      userId: string;
      platform: Platform;
      codeVerifier: string;
      returnTo: string | null;
      expiresAt: Date;
    }): Promise<void> {
      await db.insert(oauthStates).values(input);
    },

    /**
     * Atomically mark a state as used. Returns null if unknown, expired, already used,
     * or belonging to another user — the callback must then be rejected (CSRF / replay).
     */
    async consume(state: string, userId: string, now: Date): Promise<OAuthStateRow | null> {
      const [row] = await db
        .update(oauthStates)
        .set({ consumedAt: now })
        .where(
          and(
            eq(oauthStates.state, state),
            eq(oauthStates.userId, userId),
            isNull(oauthStates.consumedAt),
            gt(oauthStates.expiresAt, now),
          ),
        )
        .returning();
      return row ?? null;
    },

    async purge(now: Date): Promise<number> {
      const rows = await db
        .delete(oauthStates)
        .where(or(lt(oauthStates.expiresAt, now), isNotNull(oauthStates.consumedAt)))
        .returning({ s: oauthStates.state });
      return rows.length;
    },
  };
}
