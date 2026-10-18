# Deploying to Vercel

Tangent runs as **two Vercel projects from this one repository**, plus a Postgres database.

| Vercel project | Root Directory | What it is                                |
| -------------- | -------------- | ----------------------------------------- |
| `tangent-web`  | `apps/web`     | The Next.js site people visit             |
| `tangent-api`  | `apps/api`     | The backend, as one serverless function   |
| (database)     | —              | Neon Postgres, connected to `tangent-api` |

The browser only ever talks to `tangent-web`. Requests to `/api/*` are proxied to `tangent-api`, so cookies and Google sign-in stay on one domain.

## One-time setup

### 1. Create the API project

1. Vercel → **Add New → Project** → import `prathmessh-vk18/Podcasts`.
2. Set **Root Directory** to `apps/api`. Leave the other build settings alone: `apps/api/vercel.json` provides them.
3. Name it `tangent-api` and click **Deploy**. This first deploy fails because there's no database yet. That's expected.

### 2. Add the database

1. Open `tangent-api` → **Storage → Create Database → Neon (Postgres)** → pick the region closest to your users → **Connect** it to `tangent-api` for all environments.
2. This adds `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` automatically.

### 3. Turn the existing project into the web project

Your first project (the one that showed errors) becomes the website:

1. Open it → **Settings → Build and Deployment → Root Directory** → `apps/web` → **Save**.
2. Make sure none of the build, install or output settings have an override turned on (`apps/web/vercel.json` provides them).
3. Optionally rename it to `tangent-web`.

### 4. Environment variables

Note both projects' URLs (for example `https://tangent-web.vercel.app` and `https://tangent-api.vercel.app`).

**`tangent-api` → Settings → Environment Variables** (tick Production and Preview):

| Name                                          | Value                                                              |
| --------------------------------------------- | ------------------------------------------------------------------ |
| `SESSION_SECRET`                              | from `vercel-secrets.local.txt` (generated on your machine)        |
| `TOKEN_ENCRYPTION_KEY`                        | from `vercel-secrets.local.txt`                                    |
| `CRON_SECRET`                                 | from `vercel-secrets.local.txt`                                    |
| `WEB_ORIGIN`                                  | `https://tangent-web.vercel.app`                                   |
| `PUBLIC_API_URL`                              | `https://tangent-web.vercel.app/api` (the **web** URL plus `/api`) |
| `YOUTUBE_API_KEY`                             | your YouTube Data API key                                          |
| `GOOGLE_CLIENT_ID`                            | your Google OAuth client ID                                        |
| `GOOGLE_CLIENT_SECRET`                        | your Google OAuth client secret                                    |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | optional; leave unset until you have Spotify Premium               |

**`tangent-web` → Settings → Environment Variables:**

| Name         | Value                            |
| ------------ | -------------------------------- |
| `API_ORIGIN` | `https://tangent-api.vercel.app` |

### 5. Google sign-in redirect

Google Cloud Console → **Clients** → your OAuth client → **Authorized redirect URIs** → add:

```
https://tangent-web.vercel.app/api/v1/connections/youtube/callback
```

Keep the `127.0.0.1` one for local development.

### 6. Deploy

Redeploy **`tangent-api` first** (Deployments → ⋯ → Redeploy). Its build runs the database migrations. Then redeploy `tangent-web`. Open the web URL: the first visit loads the podcast catalog in the background, which takes about a minute.

## How it behaves on Vercel

- **Migrations** run during the API build (`npm run vercel-build`), before new code goes live.
- **Background exports** keep running after the response (`waitUntil`, up to 300 s). If a function is stopped, the export's lease expires and the next status poll resumes it. A daily cron (`/internal/cron`) is the safety net and also refreshes the catalog.
- **Catalog** refreshes on visits (stale-while-revalidate, paced to Apple's rate limit) and daily via cron.
- **Health check:** `https://tangent-web.vercel.app/api/readyz` returns `{"ok":true}` when the API and database are reachable.

## Checklist when something fails

| Symptom                                      | Likely cause                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------- |
| API build fails with "No DATABASE_URL"       | Step 2 not done, or the database isn't connected to Preview/Production |
| `/api/readyz` returns 503 "misconfigured"    | A required variable is missing; check `tangent-api` → Logs             |
| Google says `redirect_uri_mismatch`          | Step 5: the URI must match exactly, including `/api`                   |
| Site loads but shows no episodes for minutes | `tangent-web`'s `API_ORIGIN` is wrong; check `/api/readyz`             |
| Export stops at "Adding…"                    | Wait or refresh; polling resumes it. Check `tangent-api` → Logs        |
