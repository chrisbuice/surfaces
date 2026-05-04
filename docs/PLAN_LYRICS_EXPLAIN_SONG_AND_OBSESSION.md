# Plan: explain_song currently-playing fallback + obsession-tier URI list

Two independent changes to make the lyrics-analysis transparency layer usable.

---

## 1. explain_song: optional URI with currently-playing fallback

**Change:** Make the `uri` parameter optional in the `explain_song` tool definition and handler.

**Logic when uri is absent:**
1. Create a `SpotifyClient(env)` (same pattern as `add_to_seasonal` at tools.ts line 327).
2. Call `spotify.get<{ item?: { uri: string; name: string; artists: Array<{ name: string }> } }>("/v1/me/player/currently-playing")`.
3. If `playing?.item` is null/undefined: return `{ source: 'local-history-derived', error: 'Nothing is currently playing — provide a track URI or start playback.' }`.
4. Extract `playing.item.uri` (this is already a full `spotify:track:…` URI from the Spotify API).
5. Continue with existing analysis-lookup logic using that URI.
6. Include `track_name` and `artist_name` from the Spotify response in the return payload (the caller doesn't otherwise know what track was resolved).

**Tool description update:** Add "If no URI is provided, analyzes whatever is currently playing."

**Test updates in `tests/unit/lyrics-tools.test.ts`:**
- Can't test the Spotify API call in vitest-pool-workers (no real Spotify token). But the existing tests already cover the core logic paths (analysis found, pending, etc.) with an explicit URI.
- Add one test: `explain_song` with no URI and no Spotify creds returns a clear error (the SpotifyClient will throw; we catch and return a message). This verifies the fallback path doesn't silently break.

**Files changed:**
- `src/mcp/tools.ts` — tool definition (remove `uri` from `required`), handler (add Spotify fallback)

---

## 2. Obsession-tier URI list generator

**File:** `scripts/generate-obsession-tier.ts`

**Pattern:** Matches `scripts/experiment/00-pick-candidates.ts` — dotenv, inline `queryD1`, runs via `npx tsx`.

**Env:** Reads `.env` from its own directory: `CF_API_TOKEN`, `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`. Uses dotenv with `config({ path: resolve(import.meta.dirname!, ".env") })`.

**Queries (two sources, both via D1 HTTP API):**

1. **Top 500 by taste_score:**
   ```sql
   SELECT 'spotify:track:' || track_id AS uri
   FROM track_taste
   ORDER BY taste_score DESC
   LIMIT 500
   ```
   (`track_taste.track_id` is a bare ID; prepend `spotify:track:` to produce full URIs.)

2. **Tracks with ≥10 lifetime plays:**
   ```sql
   SELECT spotify_track_uri AS uri
   FROM plays
   GROUP BY spotify_track_uri
   HAVING COUNT(*) >= 10
   ```
   (Already full URIs in `plays.spotify_track_uri`.)

**Processing:**
1. UNION the two sets (Set dedup).
2. Filter to tracks with lyrics: query `track_lyrics` for `status='ok'` URIs, intersect.
3. Write one URI per line to `stack/lyrics-analysis/obsession-tier.csv`, no header.

**Summary output:**
```
Source 1 (top 500 by taste_score): NNN
Source 2 (≥10 lifetime plays):     NNN
After dedup:                       NNN
After lyrics filter:               NNN
Final count:                       NNN
Written to stack/lyrics-analysis/obsession-tier.csv
```

**No tests needed** — this is a one-shot data generation script (same as `00-pick-candidates.ts`). The output is validated by the summary counts and by `phase-analyze.ts` which will reject any URI not in `track_lyrics`.

---

## 3. Implementation order

1. `src/mcp/tools.ts` — explain_song fallback + description update
2. `tests/unit/lyrics-tools.test.ts` — add no-URI error test
3. Run lyrics-tools tests
4. `scripts/generate-obsession-tier.ts` — the URI list generator
5. Run full test suite
