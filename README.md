# Tangent

Cross-platform podcast discovery and learning library: find episodes on any service, organise them into collections, and export those collections to a supported listening app.

This repository has two parts:

| Path                     | What it is                                                                                                |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `apps/api`, `packages/*` | **The production backend (step 1).** Real provider integrations, matching, account connection and export. |
| `prototype/`             | The clickable design prototype. Static HTML: open `prototype/index.html`.                                 |

## Quick start

Requires Node.js 22.12 or later. No database or Docker needed locally: the API uses embedded Postgres (PGlite) when `DATABASE_URL` is empty.

```bash
npm install
cp .env.example .env      # optional: add Spotify / YouTube credentials to enable them
npm run dev               # API on http://localhost:4000
```

Apple Podcasts search works with no credentials. Spotify and YouTube switch on when you add their keys to `.env`; without them, those platforms report `provider_not_configured` and everything else keeps working.

```bash
curl "http://localhost:4000/v1/search?q=hidden%20brain&platforms=apple"
```

## Scripts

| Command                              | Does                                                        |
| ------------------------------------ | ----------------------------------------------------------- |
| `npm run dev`                        | API with reload                                             |
| `npm test`                           | All tests (unit, adapter, database, API end-to-end)         |
| `npm run typecheck` / `npm run lint` | Static checks                                               |
| `npm run check`                      | Typecheck, lint and test (run before pushing)               |
| `npm run build` then `npm start`     | Production bundle in `apps/api/dist`                        |
| `npm run db:generate`                | New SQL migration after editing `packages/db/src/schema.ts` |

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how the system fits together, the edge cases it handles, and the API reference.
- [docs/PLATFORM_NOTES.md](docs/PLATFORM_NOTES.md): what each platform allows, what we verified, and what's still open.
