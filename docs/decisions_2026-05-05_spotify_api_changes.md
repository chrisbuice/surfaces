# Decision: Spotify Dev Mode API Changes (2026-05-05)

## Context

During Step 2 implementation of cover detection (PLAN_COVERS_2.md), Spotify's Dev Mode restrictions were found to have changed significantly from the assumptions in the plan.

## What changed

**Search endpoint (`/v1/search`):**
- `limit` parameter max is now **10** (was 50). Requesting limit > 10 returns HTTP 400 "Invalid limit."
- Default limit is 5.
- **Pagination via `offset` still works** but `total` is not accurate — it always reports the page size, not the true total. However, subsequent pages with higher offsets do return genuinely different results.
- Tested: offset=0 limit=10 and offset=10 limit=10 for "Hallelujah" returned 10 different tracks across the two pages.

**Track endpoint (`/v1/tracks/{id}`):**
- `popularity` field (integer 0-100) has been **removed** from track responses. Not present in single-track, search results, or album track listings.
- `release_date` on album objects still works.

## Impact on PLAN_COVERS_2.md

1. **Lower-bucket sort key**: The plan specified "not-in-library candidates sorted by Spotify popularity desc." With popularity gone, this is impossible.

2. **Search candidate recall**: The plan assumed top ~30 search results. With limit=10, a single search page returns at most 10 (often only 5). Pagination partially compensates — three pages (offset 0, 10, 20) can yield up to 30 results, though Dev Mode appears to cap total unique results at a lower number than the full API.

## Workaround applied

**Sort key replacement:** Not-in-library candidates are sorted by `release_date DESC` (most recent first). This is the same sort used for in-library candidates. The schema already has `candidate_release_date` and `candidate_spotify_popularity` columns; popularity is stored as NULL.

**Search pagination:** `find-covers.ts` issues 3 search pages (offset 0, 10, 20) with limit=10, deduplicating by URI across pages. This gets ~15-25 unique candidates depending on how many Spotify returns.

## What this doesn't fix

The popularity sort was intended to surface "the most well-known alternate version" first for candidates Chris has never played. Without it, a 2024 remix by an unknown artist and a 1973 Dolly Parton original are ordered only by release date. This is acceptable for v1 — the candidate pool per seed is small enough to browse — but should be revisited if the candidate count grows.

If the app transitions from Dev Mode to production Spotify API access, re-add popularity as a sort key.

---

*Documented: 2026-05-05.*
