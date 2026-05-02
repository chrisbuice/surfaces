# Lyrics + Songwriter Credits Backfill

Add lyrics and songwriter credits to the Surfaces database, keyed on `spotify_track_uri`. Source-of-record is LRCLIB for lyrics and MusicBrainz for credits, with structured fallbacks. Backfill is a one-shot local script; ongoing capture is a small hook into the existing per-minute poll.

This is additive — nothing in the existing tracker, taste model, or curation code changes.

---

## 1. Sources

### Lyrics: LRCLIB (`lrclib.net`)
- Free, unauthenticated, no API key, no rate limit specified — we self-pace at 5 req/sec
- Returns both plain and synced (LRC-format) lyrics when available
- Signature match endpoint: `GET /api/get?track_name=&artist_name=&album_name=&duration=`
- Fallback search endpoint: `GET /api/search?track_name=&artist_name=`
- Has an `instrumental` boolean on every record — store it; instrumentals are not "missing data"
- Coverage expectation: 70–85% of a personal library; better on popular catalog, worse on deep cuts and very recent releases
- License/ToS posture: user-contributed, takedown-on-request — fine for personal use

### Credits: MusicBrainz (`musicbrainz.org/ws/2`)
- Free, no API key, JSON API
- **Strict 1 req/sec rate limit** for unauthenticated public use; custom `User-Agent` header required (format: `Surfaces/0.1 (your-email@example.com)`)
- Two-step lookup:
  1. Find the recording by ISRC (preferred) or by `recording?query=...` Lucene search
  2. Look up the recording with `?inc=work-rels+work-level-rels+artist-rels` to get linked work and writer relationships
- Credits live on the `work` entity, not the `recording`. A recording without a linked work has no credits to surface — record this as "MB recording found, no work linked" rather than as a generic miss
- Coverage expectation: 60–80% — strong on major-label catalog 1990–2020, spotty on indie/recent/electronic/rap
- ISRCs come from Spotify's track endpoint at `external_ids.isrc` — fetch alongside as the cleanest join key

### Spotify ISRC fetch
- `GET /v1/tracks/{id}` returns `external_ids.isrc` — use the existing `SpotifyClient` wrapper
- Batch endpoint `GET /v1/tracks?ids=...` accepts up to 50 IDs per request — use this; ISRC fetch is the bottleneck otherwise

---

## 2. Schema

Two new tables. Lyrics get one row per track; credits are normalized so a single human can be queried across the whole library.

```sql
-- Migration 005_lyrics_and_credits.sql

CREATE TABLE IF NOT EXISTS track_lyrics (
  spotify_track_uri TEXT PRIMARY KEY,
  track_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_name TEXT,
  duration_ms INTEGER,
  isrc TEXT,
  lyrics_plain TEXT,                    -- nullable; null + status='ok' means instrumental
  lyrics_synced TEXT,                   -- LRC format, nullable
  instrumental INTEGER NOT NULL DEFAULT 0,
  lyrics_length INTEGER,                -- char count of plain; sanity-check signal
  status TEXT NOT NULL,                 -- 'ok' | 'not_found' | 'error' | 'pending'
  source TEXT NOT NULL DEFAULT 'lrclib',
  match_method TEXT,                    -- 'signature' | 'search' | null
  fetched_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_status ON track_lyrics(status);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_artist ON track_lyrics(artist_name);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_isrc ON track_lyrics(isrc);

CREATE TABLE IF NOT EXISTS track_credits (
  id INTEGER PRIMARY KEY,
  spotify_track_uri TEXT NOT NULL,
  person_name TEXT NOT NULL,
  role TEXT NOT NULL,                   -- 'composer' | 'lyricist' | 'writer' | 'producer' | 'arranger' | 'other'
  role_raw TEXT,                        -- the raw MB relationship type, for traceability
  source TEXT NOT NULL,                 -- 'musicbrainz'
  mb_artist_id TEXT,
  mb_work_id TEXT,
  mb_recording_id TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credits_uri ON track_credits(spotify_track_uri);
CREATE INDEX IF NOT EXISTS idx_credits_person ON track_credits(person_name);
CREATE INDEX IF NOT EXISTS idx_credits_role ON track_credits(role);

-- Track-level fetch status for credits (separate from lyrics so we can re-run independently)
CREATE TABLE IF NOT EXISTS track_credits_status (
  spotify_track_uri TEXT PRIMARY KEY,
  isrc TEXT,
  mb_recording_id TEXT,
  mb_work_id TEXT,
  status TEXT NOT NULL,                 -- 'ok' | 'no_recording' | 'no_work' | 'error' | 'pending'
  fetched_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_credits_status ON track_credits_status(status);
```

**Why three-state status, not nullable rows:**
A row with `status='not_found'` is meaningfully different from no row at all. The fetcher needs to distinguish "never tried" from "tried and confirmed unavailable" so it doesn't re-hammer LRCLIB or MusicBrainz on every backfill rerun.

**Why credits are normalized:**
Querying "all songs in my library written by Jeff Tweedy" or "top 10 humans whose pens I've listened to most across all artists" is the high-value question and is impossible against a JSON-array column without table scans. The denormalization tax is paid once at write time.

**Why `track_credits_status` is separate:**
Many tracks will have a MusicBrainz recording but no linked work (so no credits possible) — we want to record that we tried and not retry. Keeping this on its own row instead of stuffing it into `track_lyrics` keeps the two backfills independent.

---

## 3. Files to create

```
scripts/
  backfill-lyrics.ts          # local one-shot, walks unique URIs from `plays`
  backfill-credits.ts         # local one-shot, walks unique URIs from `plays`
  fetch-isrcs.ts              # local one-shot, populates ISRCs into a working table

src/
  lyrics/
    lrclib.ts                 # client + fetch logic (plain + synced)
    types.ts
  credits/
    musicbrainz.ts            # client + recording lookup + work-rels parsing
    types.ts
  db/
    migrations/
      005_lyrics_and_credits.sql

src/index.ts                  # add a small hook in handlePoll for new-track lyrics enqueue (optional, see §6)
```

Keep `src/lyrics/` and `src/credits/` parallel to the existing `src/audio/` and `src/discovery/` folders — same shape as the ReccoBeats and Last.fm clients.

---

## 4. Backfill flow

The backfill is three phases. Each is restartable; each writes to D1 directly via the wrangler CLI (matching the pattern in `scripts/ingest-plays.ts`).

### Phase 1: ISRC backfill
- Read `SELECT DISTINCT spotify_track_uri FROM plays` → roughly 15–30K URIs
- Strip `spotify:track:` prefix to get raw IDs
- Batch into groups of 50, call Spotify's `/v1/tracks?ids=...`
- Write `(spotify_track_uri, isrc, duration_ms, album_name)` into a temp working table
- Parallelism: 1 (Spotify rate limits already, no need to push)
- Time estimate: ~10–15 min for 25K tracks

### Phase 2: Lyrics backfill (LRCLIB)
- For each URI not already in `track_lyrics` with `status='ok'`:
  - Try signature match: `(track_name, artist_name, album_name, duration_ms / 1000)`
  - On miss, try search fallback: `(track_name, artist_name)`, take the highest-confidence result if duration is within ±3 seconds
  - On success, write `track_lyrics` row with `status='ok'`, both plain and synced lyrics, `instrumental` flag
  - On miss, write `track_lyrics` row with `status='not_found'` so we don't retry
- Pacing: 5 req/sec (one request per track usually; sometimes two)
- Time estimate: ~1–2 hours for 25K tracks
- Output a coverage report at the end: `total / ok / not_found / instrumental / error`

### Phase 3: Credits backfill (MusicBrainz)
- For each URI not already in `track_credits_status`:
  - If ISRC available: `GET /ws/2/recording?query=isrc:{isrc}&fmt=json` → take top result for `mb_recording_id`
  - If no ISRC or ISRC search empty: `GET /ws/2/recording?query=recording:"{name}" AND artist:"{artist}"&fmt=json` → take top result if score ≥ 90
  - If still no recording: write `track_credits_status` with `status='no_recording'`
  - Else: `GET /ws/2/recording/{mb_recording_id}?inc=work-rels+work-level-rels+artist-rels&fmt=json`
  - Parse `relations[]` for `target-type='work'`; for each work, walk its `relations[]` for `target-type='artist'` with `type` in (composer, lyricist, writer, producer, arranger)
  - Write one row per (person, role) into `track_credits`; one row into `track_credits_status` with `status='ok'` or `'no_work'`
- Pacing: **1 req/sec hard limit**; custom `User-Agent`
- Time estimate: with 2 requests/track average, ~14 hours for 25K tracks. Run overnight, possibly across multiple sessions
- Restart-safe: skips any URI already in `track_credits_status`

---

## 5. Match quality safeguards

Things that will silently corrupt the data if we don't guard against them:

1. **LRCLIB returning the wrong recording.** If `duration_ms` is more than 3 seconds off the Spotify value, treat as a non-match and try the search fallback. If search also returns only off-duration matches, write `status='not_found'` rather than store wrong lyrics.

2. **MusicBrainz fuzzy search returning a different song with the same title.** Require `score >= 90` on the recording search fallback. Below that, treat as no match. ISRC matches don't need a score check.

3. **Featured artists confusing the artist match.** Strip everything in parentheses and after `feat.` / `ft.` / `featuring` from the artist string before searching either source. Store the cleaned form as well as the original for debugging.

4. **Cover versions with different writers.** Not actually a problem — the work-level credit is the same for the original and the cover, which is what we want.

5. **Backfill running twice.** All three phases check for existing rows before writing. Use `--force` to re-fetch a specific URI if needed (TBD: not in v1).

---

## 6. Going forward (optional, post-backfill)

A small hook in `src/tracker/poll.ts` so new tracks entering listening history get fetched without a manual rerun. Two options:

**Option A — Synchronous in poll:** Add a check in `handlePoll`: if the current `track_id` isn't in `track_lyrics`, kick off a fetch in the same Worker invocation. Bad idea — eats Worker CPU budget on every poll for the rare case of a new track.

**Option B — Cron-driven catch-up:** Add a new cron `*/15 * * * *` that runs `SELECT DISTINCT spotify_track_uri FROM poll_observations WHERE track_id NOT IN (SELECT ... FROM track_lyrics)` and fetches up to 20 tracks per run. Stays well inside CPU budget, picks up new tracks within 15 min of first play.

**Recommendation:** Skip the hook in v1. Run the backfill manually once. Add the catch-up cron in a follow-up once the schema and client code are battle-tested.

---

## 7. Out of scope for this build

- Genius scraping fallback for credits gaps. Add later if MusicBrainz coverage of your top tracks is unacceptable. Defer until coverage report exists.
- Lyrics analysis (theme detection, TF-IDF, embeddings clustering). Separate project once the data is in place.
- Dashboard surfacing of lyrics. Separate build — schema and backfill first.
- Cleanup of corrupted/wrong matches discovered later. Plan to add a manual `--rematch` mode in v2.

---

## 8. Coverage targets and what counts as success

After backfill completes:
- **Lyrics:** ≥75% of unique URIs have `status='ok'`. Spot-check 20 random tracks for match correctness (right song, lyrics actually match the audio you remember).
- **Credits:** ≥60% of unique URIs have `track_credits_status.status='ok'` with at least one row in `track_credits`. Spot-check that top-played tracks have plausible writer credits.
- **No false matches:** zero of 20 spot-checked tracks should have wrong lyrics or wrong writers. False misses are acceptable; false matches poison every downstream analysis.

If lyrics coverage is below 60% or credits coverage is below 40%, stop and reassess sources before building any UI on top.
