import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ExportItemError,
  ExportItemKind,
  ExportItemState,
  ExportJobStatus,
  MatchResult,
  MatchStatus,
  Platform,
  PopularityMetric,
  ReviewDecision,
  SkipReason,
} from '@tangent/core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
/** CHECK constraint for a text column holding one of a fixed set of values. */
const oneOf = (name: string, column: { name: string }, values: readonly string[]) =>
  check(name, sql.raw(`"${column.name}" in (${values.map((v) => `'${v}'`).join(', ')})`));
const PLATFORMS = ['youtube', 'spotify', 'apple'] as const;

const created = () => ts('created_at').notNull().defaultNow();
const updated = () => ts('updated_at').notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  createdAt: created(),
});

/** One connected account per user per platform. Tokens are encrypted by the app (AES-256-GCM). */
export const providerAccounts = pgTable(
  'provider_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<Platform>().notNull(),
    externalId: text('external_id').notNull(),
    displayName: text('display_name'),
    accessTokenEnc: text('access_token_enc').notNull(),
    refreshTokenEnc: text('refresh_token_enc'),
    expiresAt: ts('expires_at').notNull(),
    scopes: text('scopes')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** needs_reauth: refresh failed or access revoked; the user must connect again. */
    status: text('status').$type<'active' | 'needs_reauth'>().notNull().default('active'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('provider_accounts_user_platform').on(t.userId, t.platform),
    oneOf('provider_accounts_platform_chk', t.platform, PLATFORMS),
    oneOf('provider_accounts_status_chk', t.status, ['active', 'needs_reauth']),
  ],
);

/** Single-use OAuth state with the PKCE verifier. Expires quickly; consumed on callback. */
export const oauthStates = pgTable(
  'oauth_states',
  {
    state: text('state').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<Platform>().notNull(),
    codeVerifier: text('code_verifier').notNull(),
    returnTo: text('return_to'),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    createdAt: created(),
  },
  (t) => [
    index('oauth_states_expires').on(t.expiresAt),
    oneOf('oauth_states_platform_chk', t.platform, PLATFORMS),
  ],
);

/** PRD §8 episode record. One row per item on its source platform. */
export const episodes = pgTable(
  'episodes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sourcePlatform: text('source_platform').$type<Platform>().notNull(),
    sourceEpisodeId: text('source_episode_id').notNull(),
    canonicalUrl: text('canonical_url').notNull(),
    title: text('title').notNull(),
    showTitle: text('show_title').notNull(),
    showSourceId: text('show_source_id'),
    description: text('description'),
    publishedAt: ts('published_at'),
    durationSec: integer('duration_sec'),
    artworkUrl: text('artwork_url'),
    feedItemGuid: text('feed_item_guid'),
    enclosureUrl: text('enclosure_url'),
    people: text('people')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    topicTags: text('topic_tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    popularity: jsonb('popularity').$type<PopularityMetric | null>(),
    fetchedAt: ts('fetched_at').notNull().defaultNow(),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('episodes_source').on(t.sourcePlatform, t.sourceEpisodeId),
    index('episodes_topic_tags').using('gin', t.topicTags),
    index('episodes_published').on(t.publishedAt),
    oneOf('episodes_platform_chk', t.sourcePlatform, PLATFORMS),
    check('episodes_duration_chk', sql`duration_sec is null or duration_sec > 0`),
  ],
);

export const collections = pgTable(
  'collections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    privacy: text('privacy').$type<'private' | 'link'>().notNull().default('private'),
    /** Soft delete so "Undo" works (PRD LIB-01). Purged by a cleanup job later. */
    deletedAt: ts('deleted_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    index('collections_user').on(t.userId),
    oneOf('collections_privacy_chk', t.privacy, ['private', 'link']),
    check('collections_name_chk', sql`length(name) between 1 and 120`),
  ],
);

export const collectionItems = pgTable(
  'collection_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    collectionId: uuid('collection_id')
      .notNull()
      .references(() => collections.id, { onDelete: 'cascade' }),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    addedAt: ts('added_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('collection_items_unique').on(t.collectionId, t.episodeId),
    index('collection_items_order').on(t.collectionId, t.position),
    check('collection_items_position_chk', sql`position >= 0`),
  ],
);

/** Cached match of an episode onto a destination platform (saves API quota between exports). */
export const destinationMatches = pgTable(
  'destination_matches',
  {
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<Platform>().notNull(),
    status: text('status').$type<MatchStatus>().notNull(),
    confidence: real('confidence').notNull(),
    result: jsonb('result').$type<MatchResult>().notNull(),
    matchedAt: ts('matched_at').notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.episodeId, t.platform] }),
    oneOf('destination_matches_platform_chk', t.platform, PLATFORMS),
    oneOf('destination_matches_status_chk', t.status, ['native', 'exact', 'strong', 'review', 'none']),
    check('destination_matches_confidence_chk', sql`confidence between 0 and 1`),
  ],
);

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    collectionId: uuid('collection_id').references(() => collections.id, { onDelete: 'set null' }),
    destination: text('destination').$type<Platform>().notNull(),
    status: text('status').$type<ExportJobStatus>().notNull(),
    /** Client-supplied key: repeating the same request returns the same job instead of a new one. */
    idempotencyKey: text('idempotency_key').notNull(),
    playlistTitle: text('playlist_title'),
    playlistId: text('playlist_id'),
    playlistUrl: text('playlist_url'),
    error: jsonb('error').$type<ExportItemError | null>(),
    /** Incremented on every status change; used for compare-and-set transitions. */
    version: integer('version').notNull().default(0),
    /**
     * Worker lease. A worker owns the job until this time and extends it while working.
     * If a worker dies (serverless timeout, deploy, crash) the lease expires and any instance
     * may resume the job. Null means nobody is working on it.
     */
    leaseUntil: ts('lease_until'),
    startedAt: ts('started_at'),
    finishedAt: ts('finished_at'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('export_jobs_idempotency').on(t.userId, t.idempotencyKey),
    index('export_jobs_status').on(t.status),
    oneOf('export_jobs_destination_chk', t.destination, PLATFORMS),
    oneOf('export_jobs_status_chk', t.status, [
      'planning',
      'needs_review',
      'ready',
      'running',
      'completed',
      'partial',
      'failed',
      'cancelled',
    ]),
  ],
);

export const exportItems = pgTable(
  'export_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    jobId: uuid('job_id')
      .notNull()
      .references(() => exportJobs.id, { onDelete: 'cascade' }),
    episodeId: uuid('episode_id')
      .notNull()
      .references(() => episodes.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    kind: text('kind').$type<ExportItemKind>().notNull(),
    decision: text('decision').$type<ReviewDecision | null>(),
    duplicateOf: uuid('duplicate_of'),
    state: text('state').$type<ExportItemState>().notNull(),
    skipReason: text('skip_reason').$type<SkipReason | null>(),
    match: jsonb('match').$type<MatchResult>().notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: jsonb('last_error').$type<ExportItemError | null>(),
    destinationItemId: text('destination_item_id'),
    updatedAt: updated(),
  },
  (t) => [
    index('export_items_job').on(t.jobId, t.position),
    oneOf('export_items_kind_chk', t.kind, ['ready', 'review', 'unavailable', 'duplicate']),
    oneOf('export_items_state_chk', t.state, ['pending', 'added', 'failed', 'skipped']),
    check('export_items_decision_chk', sql`decision is null or decision in ('accept', 'reject')`),
  ],
);

/** Daily API unit usage shared by all instances (YouTube). */
export const quotaUsage = pgTable(
  'quota_usage',
  {
    key: text('key').notNull(),
    day: text('day').notNull(),
    used: integer('used').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.day] }), check('quota_usage_used_chk', sql`used >= 0`)],
);

/** Shows that feed Discover. Curated by us (see catalog-seed.ts); episodes come from Apple. */
export const catalogShows = pgTable(
  'catalog_shows',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    platform: text('platform').$type<Platform>().notNull().default('apple'),
    sourceShowId: text('source_show_id').notNull(),
    title: text('title').notNull(),
    topic: text('topic').notNull(),
    artworkUrl: text('artwork_url'),
    active: boolean('active').notNull().default(true),
    lastRefreshedAt: ts('last_refreshed_at'),
    lastError: text('last_error'),
    createdAt: created(),
    updatedAt: updated(),
  },
  (t) => [
    uniqueIndex('catalog_shows_source').on(t.platform, t.sourceShowId),
    index('catalog_shows_topic').on(t.topic),
    oneOf('catalog_shows_platform_chk', t.platform, PLATFORMS),
  ],
);
