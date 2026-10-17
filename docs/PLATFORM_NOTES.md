# Platform notes

What each platform allows, what we've verified, and what's still open. Last updated 17 Oct 2026. Re-check before relying on any limit.

## Apple Podcasts (iTunes Search API)

- **Read only.** There's no playlist API, so export is a link list and is never called a transfer.
- **Verified against the live API (Oct 2026):** `lookup?id=<episodeId>` returns **nothing**. Episodes can only be fetched through their show (`lookup?id=<showId>&entity=podcastEpisode`, latest ~200) or found by search. So clients send `showId` (or `title`) with Apple episode references. The server uses these only as lookup hints and still verifies the episode against Apple's data.
- Results include `episodeGuid` (the RSS GUID) and `episodeUrl` (the audio file). These give us deterministic cross-platform matching.
- Throttling is undocumented (about 20 requests/min per IP). We rate-limit client-side and treat 403/429 as throttling.

## Spotify (Web API)

- Search, episode lookup, show episodes, and creating playlists and adding **episodes** to them (`spotify:episode:` URIs, 100 per request) are documented.
- **Development Mode (Feb 2026):** at most 5 allowlisted users, and the app owner needs Premium. **Extended quota** requires a registered business and 250k monthly active users. We can test with 5 people but can't launch Spotify export publicly until then.
- Search results omit the show for episodes, so matching is **show-first**: find the show, then walk its episodes within a ±30-day window, with episode search as a fallback.
- There's no token revocation endpoint. Disconnecting deletes our tokens, and users can also remove access at spotify.com/account/apps.
- **To verify in the live spike:** endpoint paths changed in the Feb 2026 migration (some sources mention `/playlists/{id}/items` instead of `/tracks`). All paths are in `ENDPOINTS` in `packages/providers/src/spotify.ts`, so it's a one-line change.

## YouTube (Data API v3)

- Default quota is 10,000 units/day, reset at midnight Pacific. Search 100, videos.list 1, playlists.insert 50, playlistItems.insert 50.
  - Matching one episode costs about 101 units, and adding one costs 50. That's roughly 60 episodes matched and exported per day until Google approves more quota.
- The OAuth scope `youtube` is sensitive: Google must verify the app before public users can connect. Up to 100 test users can connect before verification.
- A Google account without a YouTube channel can't own playlists; we detect this at connect time.
- Search uses a ±30-day window around the episode date, then retries without it.

## Open questions (from PRD §14)

- Choose the first public export destination. The current recommendation is YouTube, after Google verification and a quota increase.
- Match-confidence thresholds (strong 0.90, review 0.60) are first guesses. Measure them against the PRD's test set (target: at least 90% correct, with false matches tracked separately).
- Real sign-in to replace anonymous sessions.

## Next steps

1. Create the Spotify and Google developer apps and put the credentials in `.env`.
2. Run the live spike with real test accounts: connect, match a 20-episode test set, export, and record match accuracy, quota used and failures.
3. Build the production web app on this API (port the prototype's UI).
