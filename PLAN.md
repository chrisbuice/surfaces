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
| `eras.json` | 5 era definitions (name, years, artists, summary) | ~2 KB |
| `never_stale_core.json` | 14 artists + year counts | <1 KB |
| `companions.json` | Top-25 artist co-listening graph | ~6 KB |
| `ip_geo.json` | iOS IP → city/region/country/lat/lon cache (READ-ONLY at runtime) | ~1.7 MB |

`ip_geo.json` is the largest. At 1.7 MB it fits within Worker bundle limits (10 MB for paid plans). If it becomes a problem, move to KV.

**ip_geo.json is a read-only static asset in the Worker bundle.** It covers the 4,745 distinct iOS IPs from the historical export. The live-sync write path for NEW IPs (when the daily sync encounters an IP not already in the embedded cache) writes to **KV** under the key prefix `geo:ip:{ip}`, not back to the embedded JSON. The `geolocate()` helper checks the embedded cache first, then falls back to KV. New IP lookups use a free IP geolocation API (e.g. ip-api.com), cache the result in KV, and never store the raw IP in D1 or any external service.

The `eras.json` and `never_stale_core.json` are new files derived from `dashboard_data.json` — extracted once, committed.

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
  "era": "Texas country + emotional indie",
  "vibe": "... (optional 1-sentence summary if era data has it)"
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
      era: { type: "string", description: "Filter to an era name (e.g. 'Pop maximalism')." },
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
      "era": "Country/Americana ascendance"
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
        enum: ["rediscover", "era", "morning", "default"],
        description: "Queue flavor. 'rediscover' mixes ~30% lost favorites. 'era' seeds from a named era. 'morning' weights by 6am-10am listening patterns. 'default' uses global affinity."
      },
      seed: {
        type: "string",
        description: "Optional seed: an artist name or spotify:track:URI. Queue builds outward from this seed using affinity and companion data."
      },
      length_min: {
        type: "number",
        description: "Target queue length in minutes. Default 60."
      },
      era_name: {
        type: "string",
        description: "Era to seed from when mode='era'. One of the 5 named eras (e.g. 'Pop maximalism', 'Texas country + emotional indie')."
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
5. **Era filter (mode='era'):** candidates are restricted to tracks with plays in the era's year range.
6. **Morning filter (mode='morning'):** candidates are weighted by plays where `local_hour` is 6–10.
7. **Dedup:** no artist appears more than 3 times in the queue (unless seeded by that artist).

**`reason` strings per track (provenance):**
- `"high recent affinity"` — top affinity score, no special category
- `"never-stale core (N yrs in top-50)"` — boosted by the 14-artist list
- `"lost favorite, last heard YYYY-MM"` — from the lost_favorites pool
- `"era match: [era name]"` — selected because it falls in the seeded era
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

### 8b. Eras Filmstrip

**Endpoint:** `GET /api/listening/eras`

Returns the 5 eras from the embedded `eras.json` enriched with live stats from `plays` (total plays, unique tracks, top 3 artists by play count for each era's year range).

Dashboard renders a horizontal scrolling filmstrip — each era is a card with name, year range, top artists, and a mini spark-line of monthly plays. Clicking an era filters other views.

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
| `src/listening/data/eras.json` | 5 era definitions |
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
| `src/index.ts` | Add 3 API routes (`/api/listening/heatmap`, `/api/listening/eras`, `/api/listening/month`). Add sync call to `0 5 * * *` cron. |
| `dashboard/index.html` | Add calendar heatmap, eras filmstrip, time-machine picker sections |
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
10. **Dashboard views** — heatmap, eras filmstrip, time-machine picker

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
- **Year-in-review generator** — structured summary of any year: top tracks, new discoveries, total hours, skip rate, obsessions, eras. Good Wrapped-style output.
- **Never-stale core in startSession** — extend the 14-artist boost (already shipping in `generate_queue`) to the existing `startSession` curation agent's track selection.
