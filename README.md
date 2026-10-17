# Tangent: clickable prototype

A high-fidelity prototype of the cross-platform podcast discovery and learning library, built from the PRD (October 2026). It's meant for the week-2 usability tests.

## Open it

Double-click `index.html`. You don't need to install or build anything. Fonts load from Google Fonts, so you need to be online for the full look.

## Test journeys (from PRD §5)

1. **Discover → save:** search or browse the trending rail, open an episode, and save it to a collection.
2. **Topic → bulk add → reorder:** open a topic, tick several episodes, add them to a collection, then drag to reorder.
3. **Export:** collection → Export → Spotify → connect → watch the matching → review uncertain matches → confirm → retry the failed item.
4. **Shared collection:** share a collection from its page, preview the read-only shared page, then copy it to your library or copy the source links.

The **Prototype** button (bottom-left on desktop, top bar on phones) jumps to each journey. It also toggles reduced motion, turns the simulated export failure on or off, and resets the demo data.

## What's real and what's simulated

- **Real:** 31 learning podcasts and 298 recent episodes (titles, descriptions, durations, dates, cover art, Apple links), pulled from the public iTunes Search API into `js/catalog.js`. Cover images load from Apple's CDN, so you need to be online.
- **Simulated:** which service each episode was "found on", popularity numbers, and match results. These are generated so every state appears: exact, likely, needs review, not found and duplicate.
- **Open** buttons go to the real Apple Podcasts page, or a YouTube / Spotify search for the episode.
- Account connection and export are simulated. Nothing calls Spotify or YouTube.
- Apple Podcasts goes to the link-list fallback and is never labelled as a transfer.
- Your changes are kept in the browser's localStorage. Use **Reset demo data** to start again.

## Structure

```
index.html          shell, nav, script order
css/styles.css      tokens (colour, type, motion), components, pages, responsive
js/catalog.js       real shows + episodes (generated from the iTunes Search API)
js/data.js          topics, simulated sources/metrics/matches, seed collections
js/art.js           cover images and collection mosaics
js/core.js          state, helpers, toasts, modal, episode drawer, save popover
js/views.js         Discover (hero, trending, masonry feed), Topics, Topic, Library
js/collection.js    playlist canvas (drag sort), cover builder, share, shared page
js/export.js        export journey
js/app.js           router, hero wave field, tilt, global events
```
