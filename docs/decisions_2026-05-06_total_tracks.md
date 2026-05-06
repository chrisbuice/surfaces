# Decision: Add `total_tracks` to constellation stats

**Date:** 2026-05-06

## Context

The constellation API's `stats` object serves three values displayed on the `chrisbuice.com/surfaces` page. The `total_seasons` field references "seasonal playlists" — a concept not surfaced anywhere else on the page, making it opaque to readers.

## Decision

Add a `total_tracks` field (`COUNT(DISTINCT spotify_track_uri) FROM plays`) to the `stats` object. The frontend will replace `total_seasons` with this new field in a separate change.

`total_seasons` is **not removed** from the response to keep the API backwards-compatible for other consumers (Siri shortcuts, MCP server).

## Implementation

- New SQL query added sequentially alongside the existing stats queries in `buildStats()` (`src/constellation/queries.ts`).
- Field added to `ConstellationStats` type (`src/constellation/types.ts`).
- No changes to cache key, TTL, or write path — the field rides the existing nightly KV blob.
