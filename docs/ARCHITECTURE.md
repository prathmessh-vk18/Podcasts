# Architecture

Written for engineers joining the project. It covers the structure, the rules the code enforces, and the failure cases it handles.

## Layout

```
packages/core        Pure domain logic. No I/O. Episode model, text normalisation,
                     matching engine, export plan state machine, duplicate detection.
packages/providers   One adapter per platform behind three interfaces:
                       CatalogProvider      search, getEpisode, findCandidates
                       OAuthProvider        authorize URL, code exchange, refresh, revoke
                       PlaylistDestination  createPlaylist, addItems, listItemIds
                     Plus a shared HTTP client, rate limiter, quota budget and RSS parser.
packages/db          Postgres schema (Drizzle), migrations, repositories.
apps/api             Fastify HTTP API, services, background job runner, Discover catalog.
apps/web             Next.js web app. Talks only to /api/* on its own origin (proxied to the API).
```

Dependencies only point downwards: `api → db, providers → core`. `core` has no dependencies, so the matching and planning rules are tested without a network or database.

## Request flow

```
route (zod validation) → service (business rules) → repository (SQL) / provider (HTTP)
```

- **Routes** parse input with zod and call one service method. No logic lives in them.
- **Services** (`apps/api/src/services`) own the use cases: `LibraryService`, `ConnectionService`, `ExportService`.
- **Errors** are typed: `DomainError` for our own rules and `ProviderError` for platform failures. One handler maps them to the response `{ error: { code, message, retryable, details? } }`.

## Matching (PRD §8 "deterministic first")

`packages/core/src/matching.ts`

1. Same platform → `native`.
2. Shared identity → `exact`: the same RSS GUID _within the same show_ (GUIDs like "1" collide across shows), or the same audio file (enclosure URL, ignoring tracking query strings).
3. Otherwise a weighted score: show 25%, title 40%, duration 20%, release date 15%. Each missing signal costs a little confidence.

Rules that keep it honest:

| Rule                                                                                     | Why                                              |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------ |
| A different show or a clearly different title caps confidence below the review threshold | Other signals can't rescue a wrong show          |
| Any conflicting signal (duration or date mismatch) → `review`, never auto-selected       | An edited cut or a clip looks identical by title |
| Title and show alone can't reach `strong`; duration or date must agree                   | Reruns and "best of" re-releases share titles    |
| Two candidates within 0.05 of each other → `review` (ambiguous)                          | No silent coin-flips (PRD XFER-02)               |

Titles are normalised for episode-number prefixes (`#879:`, `Ep. 12 -`), format suffixes (`(Audio)`, `| Full Episode`), HTML entities, curly quotes and US/UK spelling.

## Export lifecycle

`packages/core/src/export-plan.ts` (rules) and `apps/api/src/services/exports.ts` (engine)

```
planning → needs_review ⇄ ready → running → completed
                                      ├→ partial  ─(retry)→ running
                                      └→ failed   ─(retry)→ running   (or → planning if planning failed)
any state except running/completed → cancelled
```

Planning and running happen in the background. API calls return `202` straight away and clients poll `GET /v1/exports/:id`.

### Background work on servers and on serverless

`apps/api/src/jobs/runner.ts` picks where work runs: a bounded in-process queue on a normal server, or Vercel's `waitUntil` on serverless (the work continues after the response, up to the function's max duration).

Either way, **a job's state lives in Postgres and is protected by a lease** (`export_jobs.lease_until`):

- A worker claims the lease atomically before touching a job and renews it after each batch.
- If the worker dies (timeout, deploy, crash), the lease expires and **the next status poll or cron tick resumes the job**.
- Two instances can never process the same job at once.

## Discover catalog

Discover is fed by a hand-curated list of shows (`packages/db/src/catalog-seed.ts`, PRD §14 "curated seed catalog"). Their episodes come from Apple and are tagged with the show's topic.

- The feed is keyset-paginated (`/v1/discover/feed?topic=&cursor=`), so infinite scroll stays fast at any size.
- Refresh is stale-while-revalidate. Visits trigger a background refresh of stale shows (at most every 10 minutes per instance), paced to leave Apple's ~20 requests/minute for visitors' searches. There's also a daily cron, and a 30-minute interval on long-running servers.
- An empty database warms itself on the first visit; the feed returns `warming: true` until episodes arrive.

### Edge cases handled

| Situation                                                   | Behaviour                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The same request is sent twice (double click, client retry) | `idempotencyKey` is unique per user, so you get the same job back                                                                                                                                                                                             |
| Two "execute" calls race                                    | A compare-and-set status transition means exactly one runs; the other gets 409                                                                                                                                                                                |
| Server crashes or redeploys mid-export                      | On boot, jobs in `planning`/`running` are re-queued. Before adding, the engine lists the playlist and skips items already there                                                                                                                               |
| Provider accepted an item but the response timed out        | Marked failed; on retry, reconciliation finds it in the playlist and doesn't add it twice                                                                                                                                                                     |
| One bad item in a Spotify batch of 100                      | The batch is split in half repeatedly to isolate it; the other 99 still go in                                                                                                                                                                                 |
| YouTube daily quota                                         | Every call reserves units first (shared across instances, in Postgres). Exports that can't finish are refused up front with the units needed and remaining. If quota runs out mid-run, the rest are failed as "retry after reset" without spending more calls |
| User deleted the playlist between runs                      | Detected; a new playlist is created and everything is re-added                                                                                                                                                                                                |
| Access token expired                                        | Refreshed automatically (one refresh per account at a time) and retried once                                                                                                                                                                                  |
| Refresh token revoked                                       | Account marked `needs_reauth`; items fail with `reconnect_required`                                                                                                                                                                                           |
| Spotify Development Mode user not allowlisted               | Reported as `provider_not_allowlisted` with a plain explanation                                                                                                                                                                                               |
| Google account without a YouTube channel                    | Clear message at connect time                                                                                                                                                                                                                                 |
| Same episode saved from two sources                         | Grouped as duplicates; added once                                                                                                                                                                                                                             |
| Destination unreachable during planning                     | Job fails as retryable; retry plans again                                                                                                                                                                                                                     |
| Apple as destination                                        | Refused with a pointer to the link-list endpoint. Never labelled a transfer                                                                                                                                                                                   |

## Account connection (OAuth 2.0 + PKCE)

- `state` is single-use, expires after 10 minutes and is bound to the user who started the flow. This blocks CSRF and replayed callbacks.
- The PKCE verifier never leaves the server.
- Tokens are encrypted with AES-256-GCM. The ciphertext is bound to `userId:platform`, so a token copied into another row won't decrypt. Key rotation is supported through `TOKEN_ENCRYPTION_KEYS_OLD`.
- `returnTo` only accepts same-site relative paths, which prevents open redirects.
- OAuth `code`/`state` query values are redacted from logs.

## Security baseline

- **Identity (step 1):** an anonymous user per browser, held in a signed httpOnly `SameSite=Lax` cookie. Real sign-in plugs into `lib/session.ts` without route changes.
- **CSRF:** every write must carry `x-tangent-csrf: 1`. Browsers only send custom headers cross-origin after a CORS preflight, which is limited to `WEB_ORIGIN`.
- **Hardening:** Helmet headers, per-IP rate limits (global, plus tighter limits on search and export creation) and a 100 KB body limit.
- **RSS fetching:** blocks private and loopback addresses (SSRF), limits size to 15 MB and rejects external XML entities (XXE).
- **Client-sent metadata is never trusted:** adding an episode sends only `{platform, sourceId}` plus lookup hints; the server fetches the details from the platform.
- **Database constraints:** CHECK constraints on every enum-like column, so the database rejects invalid states as well as the app.

## Data model

See `packages/db/src/schema.ts`. Main tables: `episodes` (PRD §8 record, unique per source item), `collections` (soft delete, so Undo works) and `collection_items` (ordered). For exports: `export_jobs` and `export_items`. Matches are cached in `destination_matches` (7 days; "not found" results expire after 1 day). Also `provider_accounts`, `oauth_states` and `quota_usage`.

## API reference

All `/v1` routes use the session cookie. Writes need `x-tangent-csrf: 1`.

| Method           | Path                                                   | Notes                                                                                         |
| ---------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| GET              | `/healthz`, `/readyz`                                  | Liveness; readiness checks the DB                                                             |
| GET              | `/v1/providers`                                        | What each platform supports here, plus YouTube quota left                                     |
| GET              | `/v1/search?q=&platforms=apple,spotify,youtube&limit=` | Per-platform results and errors; YouTube is opt-in (100 units per search)                     |
| POST             | `/v1/episodes/resolve`                                 | `{platform, sourceId, showId?, title?}`. Apple needs `showId` or `title`                      |
| GET              | `/v1/episodes/:id`                                     |                                                                                               |
| GET/POST         | `/v1/collections`                                      |                                                                                               |
| GET/PATCH/DELETE | `/v1/collections/:id`                                  | DELETE is soft                                                                                |
| POST             | `/v1/collections/:id/restore`                          | Undo delete                                                                                   |
| POST             | `/v1/collections/:id/items`                            | 201 added, 200 already there                                                                  |
| DELETE           | `/v1/collections/:id/items/:itemId`                    |                                                                                               |
| PUT              | `/v1/collections/:id/order`                            | `{itemIds}`: must be the full current set, else 409                                           |
| GET              | `/v1/collections/:id/links`                            | Link-list fallback                                                                            |
| GET              | `/v1/connections`                                      |                                                                                               |
| GET              | `/v1/connections/:platform/start?returnTo=`            | Redirects to the provider                                                                     |
| GET              | `/v1/connections/:platform/callback`                   | Redirects to `WEB_ORIGIN + returnTo?connect=<outcome>`                                        |
| DELETE           | `/v1/connections/:platform`                            | Deletes tokens, then revokes (best effort)                                                    |
| POST             | `/v1/exports`                                          | `{collectionId, destination, idempotencyKey, playlistTitle?}` → 202                           |
| GET              | `/v1/exports/:id`                                      | Job, items, matches with evidence, summary                                                    |
| POST             | `/v1/exports/:id/decisions`                            | `{decisions: [{itemId, decision: accept\|reject\|null}]}`                                     |
| POST             | `/v1/exports/:id/execute`                              | 202. 409 if reviews are pending or it's already running. 429 if YouTube quota is insufficient |
| POST             | `/v1/exports/:id/retry`                                | Partial or failed jobs                                                                        |
| POST             | `/v1/exports/:id/cancel`                               |                                                                                               |

## Scaling notes

- **Already multi-instance safe:** job leases, the YouTube quota (`quota_usage`), idempotency keys, and compare-and-set job transitions.
- **Rate limits** are per instance (in memory). Move them to Redis (e.g. Upstash) when abuse becomes a concern.
- **Token refresh** de-duplicates per instance. Two instances may refresh the same account at once, which providers tolerate. Add a row lock if that changes.
- **Very large exports** (hundreds of YouTube items) outlast one serverless invocation; leases make that safe (the next poll continues), but a dedicated worker or queue service would be smoother.
