# Tangent

Cross-platform podcast discovery and learning library: find episodes on any service, organise them into collections, and export those collections to the app you listen in.

## Repository

| Path                 | What it is                                                               |
| -------------------- | ------------------------------------------------------------------------ |
| `apps/web`           | Next.js web app (what users see)                                         |
| `apps/api`           | Fastify API: providers, matching, OAuth, exports, Discover catalog       |
| `packages/core`      | Pure domain logic: matching engine, export rules, episode model          |
| `packages/providers` | Apple, Spotify, YouTube and RSS adapters                                 |
| `packages/db`        | Postgres schema, migrations and data access (Drizzle)                    |
| `prototype/`         | The original design prototype (static, for reference only; not deployed) |

## Run locally

Requires Node.js 22.12 or later. No database needed: the API uses embedded Postgres (PGlite) when `DATABASE_URL` is empty.

```bash
npm install
cp .env.example .env     # add YouTube / Spotify keys to enable those platforms
npm run dev              # API on http://127.0.0.1:4000
npm run dev:web          # web app on http://127.0.0.1:3000 (second terminal)
```

Open **http://127.0.0.1:3000**. On the first visit the catalog loads from Apple in the background (about a minute).

## Scripts

| Command                           | Does                                                         |
| --------------------------------- | ------------------------------------------------------------ |
| `npm run dev` / `npm run dev:web` | API / web app with reload                                    |
| `npm test`                        | All tests (domain, adapters, database, API end-to-end)       |
| `npm run check`                   | Typecheck, lint, format check and tests (run before pushing) |
| `npm run build`                   | Production builds of the API and web app                     |
| `npm run db:generate`             | New SQL migration after editing `packages/db/src/schema.ts`  |
| `npm run db:migrate`              | Apply migrations to `DATABASE_URL`                           |
| `npm run catalog:refresh`         | Pull fresh episodes for all curated shows now                |

## Documentation

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): deploying to Vercel, step by step.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the system works, the edge cases it handles, and the API reference.
- [docs/PLATFORM_NOTES.md](docs/PLATFORM_NOTES.md): what each platform allows and what we verified live.
