# Apple Music Listening History Ingest — Plan & Decisions

**Repo:** `spotifygenie` (Worker backend) and `chrisbuice-site` (Astro frontend)
**Status:** Plan-ready, not yet implemented
**Author of plan:** Claude (conversational), drafted 2026-05-06, revised after verification pass

---

## Context

Chris has used Apple Music intermittently from 2015 through April 2026, with heavy listening windows: 2019-Q3, 2021-Q3 through 2023-Q2, and a 2025-Q2 spike. The Apple data export contains ~44.6K event-level play rows; under the chosen filter (Option B: Play Duration ≥ 30s OR `End Reason = NATURAL_END_OF_TRACK`), this reduces to ~20.5K play events that count as real listens.

Goal: ingest these into the existing `plays` table in D1 so they roll into Surfaces alongside Spotify data, with a visible source distinction in the listening-over-time ribbon. Each Apple play should be linked to a Spotify track when possible; unmatched Apple plays still get stored with their Apple metadata.

---

## D1. Source files used (and not used)

| File | Used? | Role |
|---|---|---|
| `Apple Music Play Activity.csv` | **Primary timestamps** | Event stream. ~44.6K rows; ~20.5K after Option B filter. Source of timestamp, duration, source/device, end reason. **Has no usable track ID.** |
| `Apple Music - Play History Daily Tracks.csv` | **Track ID source** | Daily aggregates with `Track Identifier` (real Apple track IDs) and `Track Description` ("Artist - Song"). 11,742 unique track IDs, all populated. |
| `Apple Music - Track Play History.csv` | Used | Secondary artist-recovery lookup. |
| `Apple Music Library Tracks.json` | Used | Disambiguates `(song, album) → artist` for ambiguous cases. ~2,027 records. |
| `Identifier Information.json` | Used | `(track_id → title)` map; helps validate track-ID merges. |
| `iTunes_Match_Re-download_History.csv` | Not used | Re-downloads, not plays. |
| `iTunes_and_App-Book_Re-download_and_Update_History.csv` | Not used | Re-downloads, not plays. |
| Other Apple files in the export | Not used | Unrelated (Apple TV, payments, app data). |

## D2. ISRC availability — none in the export, retrievable via MusicBrainz

Verified by inspection. Apple's export and Apple's public iTunes Lookup API both omit ISRC. MusicBrainz returns ISRCs when given a clean `(artist, track)` pair, but rate-limits to 1 req/sec unauthenticated.

**Implication:** ISRC-based matching is *possible but expensive* (~2.7 hours for 10K tracks at 1 req/sec). See D7 for the matching cascade that uses it as a high-confidence path when available.

## D3. Play threshold — Option B (30s OR natural end)

Count an Apple event as a play if:
```
event_type == 'PLAY_END'
  AND media_type == 'AUDIO'
  AND (play_duration_ms >= 30000 OR end_reason_type == 'NATURAL_END_OF_TRACK')
```

Yields ~20.5K plays from Play Activity.

## D4. No deduplication against Spotify

Chris does not run two music apps simultaneously, and never used a scrobbler that could have logged plays to both services. Same-track-same-time overlap is impossible.

## D5. Schema layout — single table with `source` column

Apple plays go into the existing `plays` table with `source = 'apple'`. Existing rows get `source = 'spotify'` via the column default. The column is designed for future values (`'lastfm'`, `'manual'`, etc.) — see D9 for the visual treatment.

## D6. Apple track ID recovery via Daily Tracks merge

**Original assumption (wrong):** `Sales Order Vendor ID` in Play Activity is the Apple track ID. **Verified false** — that field is populated only 6.6% of the time and contains 64 unique vendor IDs, not track IDs. Zero overlap with the Library Tracks ID space.

**Actual approach:** Play Activity has no track ID, but `Apple Music - Play History Daily Tracks.csv` does — its IDs match the same Apple catalog ID space as `Identifier Information.json` and Library Tracks' `Purchased Track Identifier`. Recover Apple track IDs by joining Play Activity to Daily Tracks on `(date, song_name_lower)`:

```
For each Play Activity row R:
  date = R.event_end_timestamp[:10]   # YYYY-MM-DD
  song = R.song_name.lower().strip()
  candidates = daily_tracks_by_(date, song)[date, song]
  if 1 unique track_id in candidates: assign
  if 2+ track_ids: disambiguate by album, else queue ambiguous
  if no match: try +/- 1 day window (timezone shifts)
  if still no match: track_id remains null
```

**Verified coverage:**
- 92.7% same-day exact match (18,584 unique + 426 album-disambiguated)
- +0.3% from ±1-day widening
- **~93% Apple track ID recovery on the Option-B filtered set**

The remaining 7% are mostly pre-2019-06 plays (Daily Tracks doesn't cover that window). Those rows get ingested with `apple_track_id = NULL` and fall through to text-based Spotify matching.

## D7. Match confidence cascade

Three-stage matching, in order, stop at first success:

### Stage 1: ISRC match via iTunes Lookup → MusicBrainz → Spotify (highest confidence)
For tracks with `apple_track_id` recovered:
1. Hit iTunes Lookup `https://itunes.apple.com/lookup?id={apple_track_id}` to get clean `(artistName, trackName, collectionName, trackTimeMillis)`. Free, no auth, ~20 req/sec safe.
2. Hit MusicBrainz `https://musicbrainz.org/ws/2/recording?query=recording:"X" AND artist:"Y"` at 1 req/sec. Pull `isrcs` from top result.
3. If MusicBrainz returns an ISRC, query Spotify `search?q=isrc:{ISRC}&type=track`. Spotify supports ISRC queries directly.
4. ISRC match → confidence = 1.00 (exact recording).

**Verified:** All three tested API calls work. MusicBrainz returned ISRCs for all three test tracks.

**Cost:** ~10K iTunes Lookup calls (~10 min) + ~10K MusicBrainz calls (~2.7 hours). Run once on grimmauldplace, cache results.

### Stage 2: Text match via Spotify search (medium confidence)
If Stage 1 returns no result:
1. Use the iTunes Lookup result's `(artistName, trackName, collectionName)` if available, otherwise fall back to parsed `(song, artist, album)` from cross-reference logic.
2. Query Spotify `search?q=track:"X" artist:"Y" album:"Z"&type=track`.
3. Score via `confidence = 0.6 × title_ratio + 0.3 × artist_ratio + 0.1 × duration_score` where ratios are `rapidfuzz.token_sort_ratio / 100`.

### Stage 3: Bucketize
| Confidence | Action |
|---|---|
| ≥ 0.90 (or ISRC match) | Auto-match (`match_status = 'matched'`) |
| 0.70 – 0.90 | Review queue (`match_status = 'review'`) |
| < 0.70 | Unmatched (`match_status = 'unmatched'`), retry monthly |

**Expected outcome:**
- ISRC matches via Stage 1: ~50–65% of unique tracks
- Text matches at ≥ 0.90 via Stage 2: another 25–35%
- Review queue: ~5–10%
- Unmatched: ~3–5%

Net: ~85–95% auto-matched. Significantly better than the original text-only estimate.

## D8. Match cache by `apple_track_id`

Spotify search runs once per unique `apple_track_id` (~10K calls), not once per play event (~20.5K). For the ~7% with no track ID, matches cache by synthetic key `text:` + sha1(song|artist|album).

## D9. Source taxonomy — `source` column, visual is "spotify vs other"

Schema uses literal source string (`'apple'`, future `'lastfm'`, `'manual'`). The visual on `/surfaces` collapses everything-non-Spotify into a single "other" bucket colored gold. Dashboard at `/app` may show source-specific labels since it's the operator surface.

## D10. Admin review UI placement — dashboard, not public site

Match review queue lives at `spotify-agent.chrisbuice.workers.dev/app` as a new "Apple" tab. Auto-hidden when queue is empty. No urgency target — Chris is comfortable letting matches sit; monthly retry handles drift.

## D11. Bar color — `--accent3` (gold) for non-Spotify

Existing palette:
```
--accent:  #1db954  Spotify green       ← Spotify plays
--accent2: #ff6b9d  pink                 (negative deltas, etc.)
--accent3: #ffb84d  gold                ← all non-Spotify plays
--accent4: #5dd4ff  blue                 (neutral)
--accent5: #b794f6  purple               (discovery, reflections)
```

Current ribbon uses `var(--text)` at 0.7 opacity (neutral). Stacked bars keep that neutral for Spotify and add gold for the "other" portion on top. Dashboard ribbon at `/app` uses the same colors.

## D12. Caption strategy on `/surfaces`

The ribbon's meta-line caption gets a small color legend appended:

```
PLAYS PER MONTH · DECEMBER 2011 TO TODAY
■ SPOTIFY    ■ OTHER
```

Implementation: existing eyebrow line stays, second line is two color swatches (small filled squares) with tracked-uppercase labels. Quiet, editorial-register.

## D13. One-shot ingest

Apple Music subscription has lapsed. Ingest runs once. `--reingest-from <date>` flag handles future incremental imports if Chris re-subscribes.

## D14. Run location

Ingest runs from grimmauldplace. Multi-hour runtime (mostly MusicBrainz throttling) exceeds Worker CPU limits. Writes to D1 via the HTTP API pattern.

---

## Schema migration (migration 011)

```sql
-- Migration 011: Apple Music listening history support
-- Adds source tagging and Apple-specific columns to plays table.
-- Creates apple_track_matches as the per-track Spotify-match cache.

-- 1. Add columns to existing plays table
ALTER TABLE plays ADD COLUMN source TEXT NOT NULL DEFAULT 'spotify';
ALTER TABLE plays ADD COLUMN apple_track_id TEXT;
ALTER TABLE plays ADD COLUMN match_confidence REAL;
ALTER TABLE plays ADD COLUMN match_status TEXT;
ALTER TABLE plays ADD COLUMN original_song_name TEXT;
ALTER TABLE plays ADD COLUMN original_album_name TEXT;
ALTER TABLE plays ADD COLUMN original_artist_name TEXT;

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_plays_source ON plays(source);
CREATE INDEX IF NOT EXISTS idx_plays_source_year_month ON plays(source, year, month);
CREATE INDEX IF NOT EXISTS idx_plays_apple_track_id ON plays(apple_track_id);
CREATE INDEX IF NOT EXISTS idx_plays_match_status ON plays(match_status);

-- 3. Match cache
CREATE TABLE IF NOT EXISTS apple_track_matches (
  cache_key TEXT PRIMARY KEY,
  apple_track_id TEXT,
  spotify_track_uri TEXT,
  spotify_track_name TEXT,
  spotify_artist_name TEXT,
  spotify_album_name TEXT,
  spotify_duration_ms INTEGER,
  match_confidence REAL,
  match_method TEXT,                     -- 'isrc' | 'text' | 'manual'
  match_status TEXT NOT NULL,
  itunes_artist_name TEXT,
  itunes_track_name TEXT,
  itunes_album_name TEXT,
  itunes_duration_ms INTEGER,
  itunes_release_date TEXT,
  itunes_genre TEXT,
  musicbrainz_isrc TEXT,
  original_song_name TEXT NOT NULL,
  original_album_name TEXT,
  original_artist_name TEXT,
  first_seen_at INTEGER NOT NULL,
  last_match_attempt_at INTEGER NOT NULL,
  match_attempts INTEGER NOT NULL DEFAULT 1,
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_atm_status ON apple_track_matches(match_status);
CREATE INDEX IF NOT EXISTS idx_atm_spotify_uri ON apple_track_matches(spotify_track_uri);
CREATE INDEX IF NOT EXISTS idx_atm_apple_id ON apple_track_matches(apple_track_id);
```

## Column semantics for Apple rows

When `source = 'apple'`:
- `track_name`, `artist_name`, `album_name`, `spotify_track_uri` — populated from matched Spotify track when matched; mirrors `original_*` and uses `''` for URI when unmatched.
- `apple_track_id` — populated for ~93% of rows; NULL for plays before 2019-06 or otherwise missing from Daily Tracks.
- `original_song_name`, `original_album_name`, `original_artist_name` — always populated.
- `match_confidence`, `match_status` — per the cascade in D7.
- `reason_start` — Apple's `Source Type` lowercased.
- `reason_end` — Apple's `End Reason Type` lowercased.
- `platform` — normalized: `'apple_iphone'`, `'apple_homepod'`, `'apple_macos'`, `'apple_appletv'`, `'apple_ipad'`, etc.
- `shuffle`, `offline` — derived from Apple's `Shuffle Play` and `Offline` fields.

---

## Updated ingest pipeline (Phase 2)

**File:** `scripts/ingest-apple-music.ts` in `spotifygenie`

```
Step 1: Parse Daily Tracks → build (date, song_lower) → [(track_id, artist, plays)] map
Step 2: Parse Track Play History + Library Tracks → build artist-recovery lookup
Step 3: Parse Play Activity, applying Option B filter
Step 4: For each Play Activity row R:
  - Compute (date, song_lower) key
  - Look up in Daily Tracks map; assign apple_track_id if unique
  - On ambiguity, disambiguate via album lookup in Library Tracks
  - On miss, try +/- 1 day window
  - If still no match, leave apple_track_id null
Step 5: Group rows by cache_key (apple_track_id or text-hash fallback)
Step 6: For each unique cache_key (≈10K):
  6a. iTunes Lookup (if apple_track_id present)
  6b. MusicBrainz search by (artist, track)
  6c. Spotify ISRC search if ISRC found
  6d. Else Spotify text search (track, artist, album)
  6e. Bucketize and write to apple_track_matches
Step 7: For each play event, look up cache_key in apple_track_matches and INSERT into plays
Step 8: Print summary
```

**Rate limits:**
- iTunes Lookup: 15 req/sec (under documented soft cap of ~20/sec)
- MusicBrainz: 1 req/sec (their hard limit)
- Spotify search: 25 req/sec (with 429 backoff)

**Total runtime estimate:** ~10 minutes with `--skip-musicbrainz` (text-only). Full cascade with MusicBrainz: ~3 hours at 1 req/sec, but prone to hung TCP connections (see D15).

**Idempotency:** `--force` truncates only Apple rows. `--skip-musicbrainz` lets you ship a faster initial pass that goes straight to text matching, then upgrade later.

## D15. Revised ingest strategy — text-first, ISRC via retry (2026-05-07)

**Problem:** The full ISRC cascade (iTunes Lookup → MusicBrainz → Spotify ISRC search) hung after ~500 tracks during the first production run. Root cause: MusicBrainz occasionally leaves TCP connections half-open. Node's `fetch` has no default timeout, so a single hung connection blocks the entire script indefinitely.

**Fix applied:** 30-second `AbortController` timeouts on all fetch calls in `itunes-lookup.ts`, `musicbrainz-isrc.ts`, and `spotify-matcher.ts`. Timeout triggers AbortError, caught by existing retry logic.

**Revised strategy:**
1. **Initial ingest:** Run with `--skip-musicbrainz` for a fast text-only pass (~10 minutes). Text matching at ≥0.90 confidence auto-matches ~60-65% of tracks. Remainder goes to `unmatched` or `review`.
2. **ISRC enrichment:** The Phase 5 monthly retry job (`scripts/retry-apple-matches.ts`) runs the full cascade — with timeouts — against `unmatched` and `review` rows. This spreads MusicBrainz load across months instead of concentrating it in one 3-hour window, and naturally recovers from transient failures.
3. **Net effect:** Same final match rate (85-95%), but the initial ingest completes in minutes instead of hours, and the ISRC pass is resilient to MB flakiness.

**Limitation:** The retry script does not validate or refresh already-matched rows. If Spotify de-lists a track post-match, the play row will reference a stale URI. This is a known limitation; a separate match-validation job is future work.

---

## Implementation phases

### Phase 1 — Schema migration
Write `src/db/migrations/011_apple_music_source.sql`. Apply to D1. Verify counts.

### Phase 2 — Ingest pipeline
New script + helper modules per the pipeline above. Run once from grimmauldplace. Summary report committed to `docs/apple-music-ingest-results.md`.

### Phase 3 — Admin review UI ("Apple" tab in dashboard)
- Tab nav addition in `dashboard/index.html`
- 3 new API endpoints under `/api/listening/apple-matches/...`
- Per-card UI showing Apple's parsed data + iTunes Lookup data + Spotify candidates with embed previews

### Phase 4 — Visual integration on `/surfaces`
- `Ribbon.ts` becomes a stacked-bar renderer
- `getListeningByMonth` in `page-queries.ts` returns `{plays_spotify, plays_other}` per month
- Caption gets the two-swatch legend (D12)

### Phase 5 — Periodic retry job (now load-bearing)
- Monthly cron on grimmauldplace: re-runs full cascade (iTunes → MB → Spotify ISRC, then text fallback) for `match_status IN ('unmatched', 'review')` rows older than 30 days
- Uses 30s fetch timeouts so it can't hang
- Tracks `musicbrainz_attempts` per match to skip tracks that have already failed MB lookup N times
- After 3 total failed match attempts, mark `permanently_unmatched`
- This is the primary path for ISRC enrichment (see D15)

---

## Helper update (ships with Phase 2)

`src/listening/helpers.ts`'s `isSkip()` must recognize Apple skip reasons:

```typescript
const APPLE_SKIP_REASONS = [
  'track_skipped_forwards',
  'track_skipped_backwards',
];
```

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Daily Tracks merge loses precision (multiple tracks share date+title) | Low — 426 ambiguous out of 19K | Disambiguate by album via Library Tracks; remaining ambiguity → review queue |
| MusicBrainz returns ISRC that doesn't exist in Spotify | Medium for older/obscure | Fall through to Stage 2 |
| iTunes Lookup occasionally rate-limits or returns 404 | Low | Skip iTunes Lookup, use parsed metadata; not blocking |
| Match confidence formula too generous | Medium | 0.90 floor is conservative; spot-check first 50 auto-matches |
| Some Apple tracks aren't in Spotify catalog | Certain | Periodic retry; permanent unmatched is acceptable |
| 2025-Q2 spike represents a different account/profile | Low | Skim device IDs for that window before ingesting |
| Pre-2019-06 plays (no apple_track_id) get poor match rates | Medium | Fall through to text-only matching; expect higher review-queue rate for that subset |

---

## Open questions remaining

1. **Spot-check the 2025-Q2 device IDs.** Quick sanity check that this isn't a different Apple account or accidentally captured listening. (My responsibility, not yours; I'll do this as part of Phase 1 prep.)

2. **iTunes Lookup vs cross-reference for canonical (artist, track) tuples.** When iTunes Lookup *and* the cross-reference disagree on the artist (e.g., Lookup says "Brandi Carlile", cross-ref parsed "Brandi Carlile feat. The Seattle Symphony"), iTunes Lookup wins. Confirming this is your preference.

3. **MusicBrainz contact string.** MB requires real contact in User-Agent. Want me to use `surfaces/1.0 ( https://chrisbuice.com )` or do you prefer an email format?

---

## What gets committed where

**`spotifygenie` repo:**
- `src/db/migrations/011_apple_music_source.sql`
- `src/db/schema.sql` (updated)
- `scripts/ingest-apple-music.ts`
- `scripts/lib/apple-csv-parser.ts`
- `scripts/lib/itunes-lookup.ts`
- `scripts/lib/musicbrainz-isrc.ts`
- `scripts/lib/spotify-matcher.ts`
- `src/listening/helpers.ts` (skip-reason update)
- `src/listening/page-queries.ts` (update `getListeningByMonth`)
- `src/index.ts` (3 new API endpoints)
- `dashboard/index.html` + `src/dashboard-html.ts` (new Apple tab)
- `OFFLOAD_PLAN.md` (note ingest job in deferred-but-eventual list)
- `docs/apple-music-ingest-results.md` (committed post-ingest)

**`chrisbuice-site` repo:**
- `src/components/Ribbon.ts` (stacked-bar render)
- `src/pages/surfaces.astro` (caption legend)

Both repos must be connected to any Claude project doing this work.

---

## What does NOT change

Spotify ingest pipeline, OAuth flow, MCP server tools (one helper update only), per-minute polling, nightly email, discovery agent, constellation graph rendering, all existing dashboard tabs except the new Apple tab.
