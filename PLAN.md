# Listening-History Integration Plan

## Overview

Ingest the 15-year local listening history (260,331 music plays) into D1 as a new `plays` table. Build shared helpers, four new MCP tools, three new dashboard views, and a daily live-sync cron. Add Vitest as the project's first test framework.

The existing agent is untouched — this is additive.

---

## 1. D1 Schema: `plays` table

```sql
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,                          -- unix seconds (UTC)
  platform TEXT NOT NULL,                       -- normalized: iOS, macOS, Android, Windows, Cast
  ms_played INTEGER NOT NULL,
  conn_country TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_name TEXT NOT NULL,
  spotify_track_uri TEXT NOT NULL,
  reason_start TEXT NOT NULL DEFAULT '',
  reason_end TEXT NOT NULL DEFAULT '',
  shuffle INTEGER NOT NULL DEFAULT 0,           -- boolean
  offline INTEGER NOT NULL DEFAULT 0,           -- boolean
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  hour INTEGER NOT NULL,                        -- UTC hour
  local_hour INTEGER NOT NULL,                  -- US Eastern hour
  minutes REAL NOT NULL                         -- ms_played / 60000
);

-- Query patterns: time-machine (year+month), lost-favorites (artist+track group),
-- skip analysis (reason_end), affinity (recency-weighted), live-sync dedup
CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS idx_plays_year_month ON plays(year, month);  -- composite, not two singles
CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist_name);
CREATE INDEX IF NOT EXISTS idx_plays_artist_year ON plays(artist_name, year);  -- "what X was I playing in Y"
CREATE INDEX IF NOT EXISTS idx_plays_uri ON plays(spotify_track_uri);
CREATE INDEX IF NOT EXISTS idx_plays_reason_end ON plays(reason_end);
```

**Column mapping from `streams.feather`:**
- `ts` → `datetime64[ns, UTC]` → convert to unix seconds
- `platform` → run through `normalize_platform()` before insert
- `master_metadata_track_name` → `track_name`
- `master_metadata_album_artist_name` → `artist_name`
- `master_metadata_album_album_name` → `album_name`
- `shuffle`, `offline` → cast bool → 0/1
- `skipped` column is **NOT ingested** — use `reason_end` via `is_skip()`
- `ip_addr` is **NOT ingested** — geolocation is in the static `ip_geo.json`
- `_kind`, `episode_name`, `audiobook_title` are filtered out pre-ingest (music_only)

**260,331 rows.** D1 max batch is 100 rows per `INSERT`. The ingest script will batch accordingly.

---

## 2. Ingestion Script

**File:** `scripts/ingest-plays.ts`

Reads `data/streams.feather` via a two-step process:
1. A Python pre-step (`scripts/feather-to-ndjson.py`) converts `streams.feather` → `data/plays.ndjson`, applying the `music_only` filter and `normalize_platform()` in Python where pandas is available.
2. `scripts/ingest-plays.ts` reads the NDJSON line-by-line, batches into 100-row inserts, and pushes to D1 via `wrangler d1 execute`.

Run once. The NDJSON file is a build artifact (gitignored). After ingest, only the daily cron writes to `plays`.

**Alternative if wrangler D1 bulk is too slow:** Use the D1 HTTP API directly from the script. Either way, the script is idempotent — it checks `SELECT COUNT(*) FROM plays` and refuses to run if > 0 (with a `--force` flag to truncate and re-ingest).

---

## 3. Shared Helpers Module

**Path:** `src/listening/helpers.ts`

All five helpers in one file. These are the load-bearing dataset-truth functions.

```typescript
// --- is_skip ---
// The ONLY way to determine if a play was skipped.
// streams["skipped"] is broken 2017-2022; reason_end is the truth.
export function isSkip(reasonEnd: string): boolean

// --- normalize_platform ---
// Maps raw platform strings to a stable enum.
// Contains "iOS"/"iPhone"/"iPad" → "iOS"
// Contains "OS X"/"Mac"/"osx" → "macOS"
// Contains "Android" → "Android"
// Contains "Windows" → "Windows"
// Contains "Partner"/"cast"/"Sonos"/"Echo"/"partner" → "Cast"
// Anything else → "Other"
export function normalizePlatform(raw: string): string

// --- music_only ---
// No-op at query time: the plays table is pre-filtered.
// Exists so callers can express intent and for test assertions.
// Returns the input unchanged; documents the filter contract.
export function musicOnly<T>(rows: T[]): T[]

// --- load_streams ---
// Query wrapper: fetches plays from D1 with optional filters.
// Encapsulates the column schema so callers don't write raw SQL.
export async function loadPlays(
  db: D1Database,
  filters?: {
    year?: number;
    month?: number;
    artistName?: string;
    limit?: number;
    platformFilter?: "ios_only";  // for geo queries
  }
): Promise<PlayRow[]>

// --- geolocate ---
// Looks up an IP in the static ip_geo.json cache (embedded, read-only).
// Falls back to KV (key prefix geo:ip:{ip}) for IPs added by live-sync.
// If neither has the IP, returns null. Never writes to the embedded JSON.
// The live-sync path calls geolocateAndCache() which does the API lookup
// and writes the result to KV.
export function geolocate(ip: string, cache: IpGeoCache): GeoResult | null
export async function geolocateWithKvFallback(
  ip: string, cache: IpGeoCache, kv: KVNamespace
): Promise<GeoResult | null>
export async function geolocateAndCache(
  ip: string, kv: KVNamespace
): Promise<GeoResult | null>  // looks up via API, caches in KV
```

**Types** (same file or `src/listening/types.ts`):

```typescript
export interface PlayRow {
  id: number;
  ts: number;
  platform: string;
  ms_played: number;
  conn_country: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  spotify_track_uri: string;
  reason_start: string;
  reason_end: string;
  shuffle: number;
  offline: number;
  year: number;
  month: number;
  hour: number;
  local_hour: number;
  minutes: number;
}

export interface GeoResult {
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
}

export type IpGeoCache = Record<string, GeoResult>;
```

---

## 4. Static Embedded Data

**Path:** `src/listening/data/`

Files copied (not symlinked) from `data/`:

| File | Purpose | Size |
|------|---------|------|
| `reflections.json` | 5 reflection definitions (name, years, artists, summary) | ~2 KB |
| `never_stale_core.json` | 14 artists + year counts | <1 KB |
| `companions.json` | Top-25 artist co-listening graph | ~6 KB |
| `ip_geo.json` | iOS IP → city/region/country/lat/lon cache (READ-ONLY at runtime) | ~1.7 MB |

`ip_geo.json` is the largest. At 1.7 MB it fits within Worker bundle limits (10 MB for paid plans). If it becomes a problem, move to KV.

**ip_geo.json is a read-only static asset in the Worker bundle.** It covers the 4,745 distinct iOS IPs from the historical export. The live-sync write path for NEW IPs (when the daily sync encounters an IP not already in the embedded cache) writes to **KV** under the key prefix `geo:ip:{ip}`, not back to the embedded JSON. The `geolocate()` helper checks the embedded cache first, then falls back to KV. New IP lookups use a free IP geolocation API (e.g. ip-api.com), cache the result in KV, and never store the raw IP in D1 or any external service.

The `reflections.json` (reflection definitions) and `never_stale_core.json` are new files derived from `dashboard_data.json` — extracted once, committed.

---

## 5. D1 Query Helpers (Views / Functions)

Instead of D1 views (which have limitations), these are query-builder functions in `src/listening/queries.ts`:

```typescript
// Time-machine: top tracks for a given month or year
export async function getTimeMachine(
  db: D1Database,
  year: number,
  month?: number,
  limit?: number
): Promise<TimeMachineResult>

// Lost favorites: tracks with ≥20 plays, last played 2+ years ago
export async function getLostFavorites(
  db: D1Database,
  minPlays?: number,        // default 20
  minYearsGone?: number,    // default 2
  limit?: number            // default 50
): Promise<LostFavorite[]>

// Artist affinity: recency-weighted score
// Formula: sum(min(minutes, 7) * exp(-years_ago / 3) * (1 + 0.5 * (reason_end = 'trackdone')))
export async function getArtistAffinity(
  db: D1Database,
  limit?: number
): Promise<AffinityRow[]>

// Track affinity: same formula, grouped by spotify_track_uri
export async function getTrackAffinity(
  db: D1Database,
  limit?: number
): Promise<AffinityRow[]>

// Skip history for a track: count of fwdbtn events in last N days
export async function getSkipCount(
  db: D1Database,
  trackUri: string,
  days?: number              // default 30
): Promise<number>

// Monthly top: top N tracks per calendar month (for dashboard archive)
export async function getMonthlyTop(
  db: D1Database,
  year: number,
  month: number,
  limit?: number
): Promise<{ track_name: string; artist_name: string; plays: number }[]>

// Skip-penalized tracks: URIs with ≥N fwdbtn skips (within 30s) in last M days
// Used by generate_queue to build the exclusion set
export async function getSkipPenalizedTracks(
  db: D1Database,
  minSkips?: number,        // default 3
  days?: number             // default 30
): Promise<Set<string>>     // set of spotify_track_uri
```

---

## 6. New MCP Tools (Four Capabilities)

### Tool 1: `time_machine`

"What was I listening to in [month/year]?"

```typescript
{
  name: "time_machine",
  description: "What were you listening to in a given month or year? Returns top tracks, artists, total plays, and hours listened from your 15-year listening history.",
  inputSchema: {
    type: "object",
    properties: {
      year: { type: "number", description: "Year (2011-2026). Required." },
      month: { type: "number", description: "Month (1-12). If omitted, returns the full year." },
      limit: { type: "number", description: "Number of top tracks/artists to return. Default 15." },
    },
    required: ["year"],
  },
}
```

**Response shape:**
```json
{
  "source": "local_history",
  "period": "2024-03",
  "totalPlays": 1842,
  "totalHours": 94.3,
  "uniqueTracks": 312,
  "uniqueArtists": 89,
  "topTracks": [
    { "track": "Nothing Matters", "artist": "The Last Dinner Party", "plays": 40, "minutes": 142 }
  ],
  "topArtists": [
    { "artist": "Zach Bryan", "plays": 120, "minutes": 380 }
  ],
  "reflection": "Texas country + emotional indie",
  "vibe": "... (optional 1-sentence summary if reflection data has it)"
}
```

### Tool 2: `lost_favorites`

Surfaces tracks you used to love but haven't heard in 2+ years.

```typescript
{
  name: "lost_favorites",
  description: "Tracks you played 20+ times but haven't listened to in over 2 years. A rediscovery pool of forgotten favorites from your history.",
  inputSchema: {
    type: "object",
    properties: {
      min_plays: { type: "number", description: "Minimum lifetime plays. Default 20." },
      min_years_gone: { type: "number", description: "Minimum years since last play. Default 2." },
      limit: { type: "number", description: "How many to return. Default 25." },
      artist: { type: "string", description: "Filter to a specific artist." },
      reflection: { type: "string", description: "Filter to a reflection name (e.g. 'Pop maximalism')." },
    },
  },
}
```

**Response shape:**
```json
{
  "source": "local_history",
  "totalLostFavorites": 912,
  "showing": 25,
  "tracks": [
    {
      "track": "I'm On Fire",
      "artist": "Bruce Springsteen",
      "uri": "spotify:track:...",
      "lifetimePlays": 350,
      "lastPlayed": "2023-07-15",
      "peakMonth": "2018-07",
      "peakPlays": 215,
      "reflection": "Country/Americana ascendance"
    }
  ]
}
```

### Tool 3: `skip_report`

Skip-aware feedback analysis. Shows which tracks get skipped most, and which are skip-proof.

```typescript
{
  name: "skip_report",
  description: "Analyze skip patterns from your listening history. Shows most-skipped tracks, skip rate trends, and tracks that are never skipped (completion champions).",
  inputSchema: {
    type: "object",
    properties: {
      period: { type: "string", enum: ["month", "quarter", "year", "all"], description: "Time window. Default 'quarter'." },
      artist: { type: "string", description: "Filter to a specific artist." },
      min_plays: { type: "number", description: "Minimum plays to include in analysis. Default 5." },
    },
  },
}
```

**Response shape:**
```json
{
  "source": "local_history",
  "period": "2025-Q4",
  "overallSkipRate": "29.8%",
  "totalPlays": 12345,
  "totalSkips": 3678,
  "mostSkipped": [
    { "track": "...", "artist": "...", "plays": 40, "skips": 32, "skipRate": "80%" }
  ],
  "completionChampions": [
    { "track": "...", "artist": "...", "plays": 60, "skips": 0, "skipRate": "0%" }
  ],
  "recentSkipPenalties": [
    { "track": "...", "artist": "...", "skipsLast30Days": 4, "status": "excluded_from_queues" }
  ]
}
```

### Tool 4: `generate_queue`

Smart queue generation with skip-aware feedback and never-stale-core boost. This is the tool that closes the loop — analytics (skip_report) inform it, but generate_queue is the one that actually delivers music.

```typescript
{
  name: "generate_queue",
  description: "Generate a smart queue of tracks based on your 15-year listening history. Applies recency-weighted affinity, skip penalties, never-stale-core artist boosts, and optional lost-favorites mixing. Returns candidate URIs with per-track provenance — does NOT create a playlist.",
  inputSchema: {
    type: "object",
    properties: {
      mode: {
        type: "string",
        enum: ["rediscover", "reflection", "morning", "default"],
        description: "Queue flavor. 'rediscover' mixes ~30% lost favorites. 'reflection' seeds from a named reflection. 'morning' weights by 6am-10am listening patterns. 'default' uses global affinity."
      },
      seed: {
        type: "string",
        description: "Optional seed: an artist name or spotify:track:URI. Queue builds outward from this seed using affinity and companion data."
      },
      length_min: {
        type: "number",
        description: "Target queue length in minutes. Default 60."
      },
      reflection_name: {
        type: "string",
        description: "Reflection to seed from when mode='reflection'. One of the 5 named reflections (e.g. 'Pop maximalism', 'Texas country + emotional indie')."
      },
    },
  },
}
```

**Response shape:**
```json
{
  "source": "local_history",
  "mode": "rediscover",
  "targetMinutes": 60,
  "actualMinutes": 62.4,
  "trackCount": 18,
  "tracks": [
    {
      "uri": "spotify:track:...",
      "track": "I'm On Fire",
      "artist": "Bruce Springsteen",
      "reason": "lost favorite, last heard 2023-07",
      "affinityScore": 42.3,
      "isNeverStaleCore": false
    },
    {
      "uri": "spotify:track:...",
      "track": "Dreams",
      "artist": "Fleetwood Mac",
      "reason": "never-stale core (12 yrs in top-50)",
      "affinityScore": 38.1,
      "isNeverStaleCore": true
    }
  ],
  "excluded": {
    "skipPenalized": 7,
    "reason": "≥3 fwdbtn skips in last 30 days"
  }
}
```

**Scoring algorithm:**

1. **Base score:** recency-weighted affinity per track — `sum(min(minutes, 7) × exp(-years_ago / 3) × (1 + 0.5 × (reason_end == 'trackdone')))`.
2. **Never-stale-core boost:** if the track's artist is one of the 14 evergreen artists from `never_stale_core.json`, multiply the base score by 1.15. Modest — enough to keep them surfaced when recency decay would have pruned them, not enough to dominate.
3. **Skip penalty / exclusion:** any track with ≥3 `reason_end='fwdbtn'` events (where `ms_played < 30000`, i.e. skipped within 30s) in the past 30 days is excluded from the candidate pool entirely. Exception: if the track was explicitly passed as `seed`, it's included regardless.
4. **Lost-favorites mix (mode='rediscover'):** ~30% of queue slots are filled from `getLostFavorites()`, weighted by lifetime plays. Remaining 70% from affinity-ranked candidates.
5. **Reflection filter (mode='reflection'):** candidates are restricted to tracks with plays in the reflection's year range.
6. **Morning filter (mode='morning'):** candidates are weighted by plays where `local_hour` is 6–10.
7. **Dedup:** no artist appears more than 3 times in the queue (unless seeded by that artist).

**`reason` strings per track (provenance):**
- `"high recent affinity"` — top affinity score, no special category
- `"never-stale core (N yrs in top-50)"` — boosted by the 14-artist list
- `"lost favorite, last heard YYYY-MM"` — from the lost_favorites pool
- `"reflection match: [reflection name]"` — selected because it falls in the seeded reflection
- `"seed companion"` — from the companion graph of the seeded artist
- `"morning pattern"` — weighted by morning listening history

---

## 7. Live-Sync Cron

**What:** Pull last 50 plays from Spotify's `recently-played` endpoint, normalize, dedupe by `(ts, spotify_track_uri)`, insert into `plays`.

**Where:** New function in `src/listening/sync.ts`, called from the existing `scheduled()` handler in `src/index.ts`.

**Cron:** Reuse the existing `0 5 * * *` daily trigger (5am UTC / 1am ET). Add the sync call before the taste rebuild so new plays inform affinity.

**Edge case:** If exactly 50 plays are returned, schedule a follow-up within 1 hour (set a KV flag `sync:needs_followup` checked by the `*/2 * * * *` cron).

```typescript
// src/listening/sync.ts
export async function syncRecentPlays(
  db: D1Database,
  spotify: SpotifyClient
): Promise<{ inserted: number; duplicates: number; needsFollowup: boolean }>
```

**Dedup logic:** Before inserting, check `SELECT 1 FROM plays WHERE ts = ? AND spotify_track_uri = ?`. The `(ts, spotify_track_uri)` pair is the unique key per LISTENING_HISTORY.md.

---

## 8. Dashboard Views

All three views are added to `dashboard/index.html` (single-file app). New API endpoints are added to `src/index.ts` under `/api/listening/...`.

### 8a. Calendar Heatmap

**Endpoint:** `GET /api/listening/heatmap?year=2024`

Returns daily play counts for the given year (365/366 cells). Dashboard renders a GitHub-style heatmap grid (7 rows × 52 cols). Color scale: Spotify green gradient (#1a1a1a → #1db954). Visual reference: Sonic_Life_Dashboard.html's calendar layout.

**Query:** `SELECT date(ts, 'unixepoch') as day, COUNT(*) as plays FROM plays WHERE year = ? GROUP BY day`

### 8b. Reflections Filmstrip

**Endpoint:** `GET /api/listening/reflections`

Returns the 5 reflections from the embedded `reflections.json` enriched with live stats from `plays` (total plays, unique tracks, top 3 artists by play count for each reflection's year range).

Dashboard renders a horizontal scrolling filmstrip — each reflection is a card with name, year range, top artists, and a mini spark-line of monthly plays. Clicking a reflection filters other views.

### 8c. Time-Machine Month Picker

**Endpoint:** `GET /api/listening/month?year=2024&month=3`

Returns top 15 tracks, top 5 artists, total plays, total hours for the selected month. Dashboard renders a date-picker (year slider + month grid) and a track list below.

**Source badge:** All three views show a small "From local history" tag (matching the existing `.source-tag` class).

---

## 9. Vitest Setup

### 9a. Install

```bash
npm install -D vitest @cloudflare/vitest-pool-workers
```

### 9b. Config

**File:** `vitest.config.ts`

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    globals: true,
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          d1Databases: ["DB"],
          kvNamespaces: ["KV"],
        },
      },
    },
  },
});
```

### 9c. Package.json

Add: `"test": "vitest run"`, `"test:watch": "vitest"`

### 9d. Regression Tests

**File:** `tests/regression/listening-history.test.ts`

Four regression checks, run against the D1 `plays` table (populated in a `beforeAll` from a test fixture or by running the ingest against a test DB):

1. `musicOnly` row count: `SELECT COUNT(*) FROM plays` === 260,331
2. Top artist by affinity: query `getArtistAffinity(db, 1)` → artist_name === "Zach Bryan"
3. Lost favorites count: `getLostFavorites(db)` length === 912
4. `isSkip("fwdbtn")` === true; `isSkip("trackdone")` === false

**Note on test data:** The full 260K-row ingest into a test D1 database may be slow. If it exceeds Vitest timeouts, we'll use a representative fixture (first 1000 rows + known edge cases) for unit tests, and run the full regression checks as a separate `test:regression` script against the real D1 database.

### 9e. Unit Tests

**File:** `tests/unit/helpers.test.ts`

- `normalizePlatform`: all 5 categories + edge cases
- `isSkip`: fwdbtn → true, trackdone → false, empty → false, endplay → false
- `musicOnly`: returns input unchanged (contract test)
- `geolocate`: known IP returns city, unknown IP returns null

**File:** `tests/unit/queries.test.ts`

- `getTimeMachine`: returns correct shape, respects year/month filters
- `getLostFavorites`: respects min_plays and min_years_gone
- `getSkipCount`: counts only fwdbtn events in the time window
- `getSkipPenalizedTracks`: returns URIs with ≥3 recent skips

**File:** `tests/unit/queue.test.ts`

- `generateQueue`: returns tracks with reason strings, respects length_min
- never-stale-core boost: Fleetwood Mac/Beyonce tracks score higher than equal-affinity non-core tracks
- skip exclusion: tracks with ≥3 recent fwdbtn skips are absent from output
- rediscover mode: ~30% of tracks have reason containing "lost favorite"
- artist dedup: no artist appears >3 times

---

## 10. File Inventory

### New files

| Path | Purpose |
|------|---------|
| `src/listening/helpers.ts` | Shared helpers: isSkip, normalizePlatform, musicOnly, loadPlays, geolocate |
| `src/listening/types.ts` | PlayRow, GeoResult, IpGeoCache, TimeMachineResult, LostFavorite, AffinityRow |
| `src/listening/queries.ts` | D1 query builders: getTimeMachine, getLostFavorites, getArtistAffinity, getTrackAffinity, getSkipCount, getMonthlyTop, getSkipPenalizedTracks |
| `src/listening/queue.ts` | Queue generation engine: generateQueue() — scoring, never-stale boost, skip exclusion, mode filtering |
| `src/listening/sync.ts` | Live-sync: syncRecentPlays() |
| `src/listening/data/reflections.json` | 5 reflection definitions |
| `src/listening/data/never_stale_core.json` | 14 always-boost artists |
| `src/listening/data/companions.json` | Co-listening graph |
| `src/listening/data/ip_geo.json` | iOS IP geolocation cache |
| `scripts/feather-to-ndjson.py` | One-shot: streams.feather → plays.ndjson (music_only + normalize) |
| `scripts/ingest-plays.ts` | One-shot: plays.ndjson → D1 bulk insert |
| `vitest.config.ts` | Test framework config |
| `tests/regression/listening-history.test.ts` | 4 regression checks |
| `tests/unit/helpers.test.ts` | Helper unit tests |
| `tests/unit/queries.test.ts` | Query unit tests |
| `tests/unit/queue.test.ts` | Queue generation unit tests (scoring, boost, exclusion, mode mixing) |

### Modified files

| Path | Change |
|------|--------|
| `src/db/schema.sql` | Add `CREATE TABLE plays` + indexes |
| `src/mcp/tools.ts` | Add 4 tool definitions + handlers (time_machine, lost_favorites, skip_report, generate_queue) |
| `src/index.ts` | Add 3 API routes (`/api/listening/heatmap`, `/api/listening/reflections`, `/api/listening/month`). Add sync call to `0 5 * * *` cron. |
| `dashboard/index.html` | Add calendar heatmap, reflections filmstrip, time-machine picker sections |
| `package.json` | Add vitest + pool-workers devDeps, add test scripts |
| `wrangler.toml` | No changes needed (existing D1 binding is reused) |
| `.gitignore` | Add `data/plays.ndjson` |

---

## 11. Things NOT Touched

- **Existing 8 MCP tools** (`start_session`, `current_session_status`, `end_session`, `add_to_seasonal`, `get_fresh_pool`, `mark_track`, `stats`, `current_context`) — no changes.
- **Spotify OAuth flow** (`src/auth/spotify-oauth.ts`, `src/auth/tokens.ts`) — no changes.
- **SpotifyClient** (`src/spotify/client.ts`) — reused as-is for live-sync.
- **Existing route handlers** in `src/index.ts` — not refactored. New routes are appended.
- **Existing cron handlers** — not restructured. Sync call is inserted into the daily block.
- **Taste model** (`src/taste/`) — untouched. Future work may merge affinity signals.
- **Curation agent** (`src/curation/agent.ts`) — untouched. `generate_queue` is a new, separate tool; it does not modify the existing `startSession` flow.
- **Discovery agent** (`src/discovery/`) — untouched.
- **Dashboard layout/styles** — existing cards, grids, and color scheme are preserved. New views are additive sections.

---

## 12. Implementation Order

1. **Vitest setup** — config, package.json, empty test file that passes
2. **D1 schema** — add `plays` table to `schema.sql`, run migration
3. **Shared helpers** — `src/listening/helpers.ts` + `types.ts` + unit tests
4. **Ingestion** — Python converter + Node ingest script, run once
5. **Regression tests** — verify all 4 numbers against real D1 data
6. **Query helpers** — `src/listening/queries.ts` + unit tests
7. **MCP tools** — time_machine, lost_favorites, skip_report, generate_queue + handler tests
8. **Live-sync** — `src/listening/sync.ts` + cron integration
9. **API endpoints** — 3 new routes in index.ts
10. **Dashboard views** — heatmap, reflections filmstrip, time-machine picker

Each step ships with its tests. Tests run after every commit-worthy change.

---

## Phase 3 Candidates (Future Work)

Ideas spotted during discovery, not in scope for this plan:

- **Geographic memory tool** — "What did I listen to in Buenos Aires?" Query `plays` joined with `ip_geo.json` (iOS-only). Requires ingesting a `city` column or joining at query time.
- **Obsession detector** — surface months where a single track had >50% of all plays. The `obsessions` data in `dashboard_data.json` has 38 of these.
- **Companion seeding for queues** — use `companions.json` to seed session tracks: "you're listening to Beyonce → here's Britney, Rihanna, Calvin Harris from your actual co-listening graph."
- **Workday-context queues** — weight recommendations by `local_hour` band, not just global affinity. 9am-5pm plays are a different taste profile than 10pm plays.
- **Travel mode** — detect non-Georgia city from context snapshot, switch to lifetime-favorites-heavy mix. Uses `cities_ios.csv` as the "cities I've been" reference.
- **Binge detector** — alert when a single track crosses 30 plays in a week. The `binges` data has 20 historical examples.
- **Year-in-review generator** — structured summary of any year: top tracks, new discoveries, total hours, skip rate, obsessions, reflections. Good Wrapped-style output.
- **Never-stale core in startSession** — extend the 14-artist boost (already shipping in `generate_queue`) to the existing `startSession` curation agent's track selection.

---

# Spotify Auth Health Plan (Oct 2026)

**Status: APPROVED ("go with your recommendations"). D1, D2, D3 all in scope: commit 1 = core + D1, commit 2 = D2 heartbeat, commit 3 = D3 scope trim.**

**Refinement:** alert dedupe key is `spotify:auth_alert:<kind>:<authorized_at>` (TTL ~200d) so each threshold fires once per authorization cycle and a re-login resets it. `broken`/stale alerts use a 24h TTL (repeat daily until fixed). The key is written only after a successful send.

## Why

Spotify deleted the old developer app. From then until Oct 10, 2026 the worker could not refresh its token (`invalid_client`), and nothing told anyone: `handlePoll` catches every error, logs it, and writes an empty `is_playing=0` observation each minute. The nightly email is skipped when nothing was played. Result: about three months of silent data loss.

Spotify now also expires every refresh token six months after the user first authorizes (enforced Jun 18, 2026 for new apps, Jul 20 for existing ones). Refreshing does NOT extend the window, and Spotify does not report when a token was issued, so we have to record it ourselves. Without this work the same silent outage recurs around April 2027.

## Scope

**In scope (task 7):** record authorization time; classify auth failures; stop retrying on them; email before expiry and on failure; expose status on MCP `stats` and `/api/dashboard-stats`.

**Now in scope (separate commits):** D2 heartbeat, D3 scope trim. **Still not in scope:** adaptive polling, quota (`QUOTA_EXCEEDED`) handling.

## Design

### 1. Record when the user authorized
- New KV key `spotify:authorized_at` (unix seconds), written ONLY in the `/auth/callback` success path, never in `saveTokens` (refresh calls that too, and must not reset the clock).
- Callback also deletes `spotify:auth_broken` (see 2).
- Bootstrap: the current login predates this change, so no timestamp exists. One re-login after deploy (30 seconds) seeds it.

### 2. Classify and stop on auth failures
- In `refreshAccessToken` (`src/auth/spotify-oauth.ts`): on a 400 whose body error is `invalid_grant` (token expired/revoked) or `invalid_client` (app deleted or bad credentials), do not retry. Write `spotify:auth_broken` = `{ reason, at }` and throw a new `SpotifyAuthError`.
- `SpotifyClient.request` (`src/spotify/client.ts`): before using or refreshing a token, if `spotify:auth_broken` is set, throw `SpotifyAuthError` immediately with no HTTP call. Today a dead login costs about 1,440 failing token requests per day, which risks a token-endpoint 429 and the existing 24-hour kill-switch.
- Define `SpotifyAuthError extends SpotifyDisabledError`. Nine existing catch sites (`src/index.ts` cron blocks, `src/tracker/poll.ts`) already treat that class as "skip quietly", so none of them need editing. Side effect, intended: `handlePoll` stops inserting fake `is_playing=0` rows while auth is broken, so gaps in the data are real gaps.

### 3. Alerts (new `src/auth/auth-health.ts`)
- Pure function `evaluateAuthHealth({ authorizedAt, authBroken, now })` returns `{ status, daysSinceAuth, daysUntilExpiry, alert }`.
- `AUTH_LIFETIME_DAYS = 180` (conservative; Spotify says six months).
- Statuses: `ok`, `expiring` (from day 150), `broken`, `unknown` (no timestamp yet).
- Warning emails at day 150, 165 and 175, and one when broken. Each is deduplicated with a KV key `spotify:auth_alert:<kind>` (TTL 7 days for warnings, 24 hours for broken), so the daily check cannot spam.
- Runs inside the existing `0 0 * * *` (8pm ET) cron block, next to the nightly summary. No new cron trigger, no `wrangler.toml` change.
- Email via the existing Resend path (`RESEND_API_KEY`, `NOTIFICATION_EMAIL`, sender `FROM_EMAIL`). Body: what happened, days left, and the link `https://spotify-agent.chrisbuice.workers.dev/auth/login`. Subject begins "Action needed:".
- Refactor needed: `summary.ts` has the Resend call inline. Extract a small `sendEmail(resendApiKey, to, subject, html)` and reuse it from both places (behavior-preserving).

### 4. Visibility (MCP and dashboard are both first-class)
- Add `spotify_auth: { status, authorized_at, days_until_expiry }` to the MCP `stats` tool output and to `/api/dashboard-stats`, with the existing `source` provenance convention ("From local state").
- Add `/debug/auth-health` returning the raw evaluation (the `/debug/*` routes are already behind Cloudflare Access).

## Tests (required by CLAUDE.md)
New file `tests/unit/auth-health.test.ts`, vitest + miniflare KV, matching `oauth.test.ts` style:
1. `evaluateAuthHealth`: boundaries at days 149/150/165/175/180, missing timestamp, broken flag overrides.
2. `refreshAccessToken`: 400 `invalid_grant` and 400 `invalid_client` set `auth_broken`, throw `SpotifyAuthError`, make exactly one HTTP call. A 429 still triggers the existing 24-hour cooldown. A 500 is not classified as auth.
3. `SpotifyClient`: with `auth_broken` set, makes zero fetch calls and throws `SpotifyAuthError`.
4. `/auth/callback` success writes `authorized_at` and clears `auth_broken`; a plain refresh does not touch `authorized_at`.
5. Alert dedupe: second evaluation within the TTL sends nothing.
6. `handlePoll` with `SpotifyAuthError` inserts no observation row.
Existing regression checks in `CLAUDE.md` (260,331 plays, top artist, 633 lost favorites, `is_skip`) must still pass. Run `npm run test:all` plus `npx tsc --noEmit`.

## Rollout
1. PR from a feature branch; merge to `main` (Workers Builds auto-deploys the worker; this repo does not touch chrisbuice.com).
2. Visit `/auth/login` once to seed `authorized_at`.
3. Verify `/debug/auth-health` shows `ok` with about 180 days left.
4. Chris sets a calendar reminder for about day 150 as a backup to the emails.

## Decisions needed from Chris
- **D1:** Stop writing empty `is_playing=0` observations while auth is broken (the subclass approach does this automatically). Recommended: yes.
- **D2:** Also add a general heartbeat (`spotify:last_ok_at` updated at most every 10 minutes; daily check emails if it is older than 24 hours). It would have caught this outage whatever the cause. Slightly beyond the literal task. Recommended: yes, as a separate commit in the same PR.
- **D3:** Bundle the OAuth scope trim (drop `user-read-email`, `user-library-modify`) into this deploy, so the one re-login covers both? Recommended: yes, as its own commit.

## Risks
- Spotify's exact `invalid_grant` response shape for an expired token comes from their blog post, not a live test. The classifier keys on the documented `error` field, and the unit tests use that shape.
- If Resend is down or `NOTIFICATION_EMAIL` is unset, alerts fail quietly. Mitigation: log the failure, show status on the dashboard and `/debug/auth-health`, and use the calendar reminder.

---

# Descope grimmauldplace (Oct 2026)

## Why

Chris is dropping the grimmauldplace home server. Surfaces has to run on
Cloudflare (Workers + D1) alone, with Chris's Mac or a Claude session
used only for one-off jobs. Nothing may depend on a box that is always on
at home.

## What depends on grimmauldplace today

| Dependent | What it does | Status today |
|---|---|---|
| Apple Music ingest (`scripts/ingest-apple-music.ts`) | One-shot load of ~20.5K Apple plays into `plays` | Built, never run. Needs `CF_API_TOKEN` + Spotify client creds, which only exist on the server |
| Apple match retry (`scripts/retry-apple-matches.ts`) | Monthly re-match of `unmatched`/`review` rows, ISRC via MusicBrainz | Built, never scheduled |
| Lyrics pending queue (`src/lyrics_analysis/pending.ts`) | MCP tools mark tracks `pending`; a server cron analyzes them every ~10 min | Without the server, rows stay `pending` forever |
| Lyrics bulk backfill / analysis (`stack/lyrics-backfill`, `stack/lyrics-analysis`) | One-time bulk lyrics, credits, ISRC, embeddings | Containers built; bulk-run status unknown |
| Token broker (`src/index.ts` ~line 248) | Hands Spotify tokens to server containers | Dead once the server is gone |
| Offload plan steps 1–3 (D1 backups, ETL, constellation) | Not started | Cancel |
| Outside the repo: Cloudflare Tunnel `grimmauld`, Uptime Kuma at `dobby.chrisbuice.com` | Monitoring | Chris's call; not code |

## Plan

### A. Apple Music ingest — no server, no new secrets (do first)

Split "load the plays" from "match them to Spotify". The chart only needs
`source`, `year`, `month`; matching can come later and slowly.

1. **Generate the load as a SQL file** from the export (in a Claude session
   or on the Mac). Reuses the existing parser: Option B filter, Daily
   Tracks track-ID recovery, Library Tracks artist recovery. Every row is
   inserted with `source='apple'`, `match_status='unmatched'`,
   `spotify_track_uri=''`, and `original_*` populated. Plus one
   `apple_track_matches` row per unique track (8,670) as the matching queue.
   - Add an `--emit-sql=<path>` mode to `ingest-apple-music.ts` that
     replaces D1 HTTP writes and Spotify calls. Matching flags still
     work when credentials *are* present.
2. **Apply it from the Mac** with the wrangler login Chris already has:
   `npx wrangler d1 execute spotify-agent-db --remote --file=apple-plays.sql`.
   No `CF_API_TOKEN` to mint, nothing to copy off the server.
   Precheck that migrations 015/016 are applied:
   `npx wrangler d1 execute spotify-agent-db --remote --command "SELECT name FROM pragma_table_info('plays') WHERE name='source'"`.
3. **Undo** if it goes wrong: `DELETE FROM plays WHERE source='apple'; DELETE FROM apple_track_matches;`
   (same thing `--force` does today).

### B. Apple matching moves into the Worker (replaces the monthly retry job)

A new cron branch on the existing `0 5 * * *` daily run (or hourly if
throughput is too low) processes a small batch of `apple_track_matches`
rows: iTunes Lookup → MusicBrainz ISRC (1 req/s, 30s timeouts) → Spotify
ISRC search → text fallback. Uses the Worker's existing Spotify client and
rate-guard, not a second HTTP layer. Updates `apple_track_matches` and the
matching `plays` rows. Batch size bounded by Worker CPU/subrequest limits
(~40 tracks/run → ~8,670 tracks in ~7–8 weeks daily, ~9 days hourly).
`scripts/retry-apple-matches.ts` is deleted.

### C. Lyrics pending queue

Option 1 (recommended): a Worker cron (every 10 min) processes a few
`pending` rows using the same steps the container ran (LRCLIB → analysis →
Voyage embed). Per-track work is small enough for a Worker.
Option 2: freeze — stop calling `ensureAnalysisPending`, and have the MCP
tools say "not analyzed" instead of queueing.
Bulk backfill containers are retired either way; anything unbacked-filled
gets picked up lazily by Option 1.

### D. Cleanup

- Remove the token broker route and its secret checks.
- Delete `stack/` and the `@deprecated` laptop scripts once B and C land.
- Mark Offload plan steps 1–3 cancelled in `PROJECT_STATUS.md`; update
  `decisions_apple_music_ingest.md` D14/D15 and Phase 5.
- **D1 backups** (was Offload step 1): use D1 Time Travel (built in,
  30-day point-in-time restore on paid Workers) instead of a server job.

## Tests (required by CLAUDE.md)

- `--emit-sql`: given fixture CSVs, emitted SQL inserts the expected row
  count with `source='apple'` and escapes quotes in song titles.
- Worker matcher: batch picks only `unmatched`/`review` rows, respects the
  batch cap, writes confidence/status, updates linked `plays` rows.
- Lyrics cron (if Option 1): processes at most N rows, marks failures
  with incremented `attempts`.

## Order

A (unblocks the chart today) → merge `feat/apple-music-ribbon` in both
repos → B → C → D.

## Decisions needed from Chris

1. OK to load Apple plays **unmatched first** (chart and top-artists use
   Apple's own artist spelling until matching catches up)?
2. Lyrics queue: Option 1 (Worker cron) or Option 2 (freeze)?
3. Matching cadence: daily (slow, ~2 months) or hourly (~9 days)?
