# Plan: Add `date_range` MCP tool to Surfaces

## Context

The Surfaces MCP server already exposes `time_machine` (month/year aggregation) and `on_this_day` (MM-DD across all years). Both are implemented in `src/listening/queries.ts` and registered in `src/mcp/tools.ts`.

This task adds a third date-oriented tool: `date_range` — top tracks/artists for a specific date or contiguous range of dates, with both aggregated totals and a per-day breakdown.

A single date is expressed as `start_date == end_date`. There is no separate "specific date" tool.

## Decisions (locked)

- **D1.** One tool: `date_range`. Single-date queries are expressed as `start_date == end_date`.
- **D2.** Response includes **both** aggregated totals (top tracks, top artists, lifetime stats across the range) **and** a daily array (per-day plays/minutes/top track).
- **D3.** No length cap. Ranges silently clamp to the bounds of the dataset (earliest play timestamp → today). If the requested range is entirely outside the dataset, return an empty result with a clear message.
- **D4.** Day boundary uses **US Eastern fixed UTC-5 offset**, matching `getOnThisDay`. Half-hour DST edge case is documented and accepted.
- **D5.** Aggregation: song-level (`track_name COLLATE NOCASE, artist_name COLLATE NOCASE`), matching `time_machine` / `on_this_day` / `lost_favorites`. Canonical URI = most-played URI for the song. This is the LISTENING_HISTORY.md rule — don't deviate.
- **D6.** Date format: ISO `YYYY-MM-DD` strings for input. Reject any other format with a clear error.
- **D7.** New tool only. No changes to `time_machine` or `on_this_day`. No dashboard changes (this is a separate task).

## Files to touch

| Path | Change |
|------|--------|
| `src/listening/types.ts` | Add `DateRangeResult`, `DateRangeDay`, `DateRangeTrack`, `DateRangeArtist` types |
| `src/listening/queries.ts` | Add `getDateRange()` function |
| `src/mcp/tools.ts` | Add `date_range` to `getToolDefinitions()` and `callTool()` switch; import `getDateRange` |
| `tests/unit/queries.test.ts` | Add `describe("getDateRange")` block with seeded data |

No changes to `src/index.ts`, schema, KV, dashboard, or any other surface.

## Implementation

### 1. Types (`src/listening/types.ts`)

Append:

```ts
export interface DateRangeTrack {
  track: string;
  artist: string;
  uri: string;          // canonical (most-played) URI for the song in the range
  plays: number;
  minutes: number;
}

export interface DateRangeArtist {
  artist: string;
  plays: number;
  minutes: number;
}

export interface DateRangeDay {
  date: string;         // YYYY-MM-DD (Eastern)
  plays: number;
  minutes: number;
  topTrack: { track: string; artist: string; plays: number } | null;
}

export interface DateRangeResult {
  source: "local_history";
  startDate: string;          // requested start, echoed back as YYYY-MM-DD
  endDate: string;            // requested end, echoed back
  effectiveStartDate: string; // after clamping to dataset bounds
  effectiveEndDate: string;
  daysInRange: number;        // inclusive count of days in effective range
  daysWithPlays: number;
  totalPlays: number;
  totalMinutes: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topTracks: DateRangeTrack[];
  topArtists: DateRangeArtist[];
  daily: DateRangeDay[];      // one entry per day in effective range, including zero-play days
}
```

### 2. Query (`src/listening/queries.ts`)

Add a new exported function `getDateRange`. Structure it the way `getOnThisDay` is structured — separate SQL queries for stats, top tracks, top artists, then a per-track enrichment pass for the canonical URI. Then a daily-rollup query for the daily array.

Key SQL patterns:

```ts
// Eastern-time date filter (matches getOnThisDay's offset)
const dateFilter = `
  date(datetime(ts, 'unixepoch', '-5 hours')) BETWEEN ? AND ?
`;
```

Validation and clamping logic:

1. Parse `start_date` and `end_date` as `YYYY-MM-DD`. If the regex `^\d{4}-\d{2}-\d{2}$` doesn't match either input, throw a clear error (the MCP handler will turn this into `{ error: "..." }`).
2. If `start_date > end_date`, throw a clear error.
3. Look up the earliest play in the dataset:
   ```sql
   SELECT date(datetime(MIN(ts), 'unixepoch', '-5 hours')) as min_date FROM plays
   ```
   And use today (Eastern) as the upper bound.
4. Clamp `effectiveStartDate = max(start_date, min_date)` and `effectiveEndDate = min(end_date, today_eastern)`.
5. If `effectiveStartDate > effectiveEndDate` (entire range is outside the dataset), return an empty result with `daysInRange = 0`, empty arrays, zeroed counters, and the original `startDate` / `endDate` echoed back.

Top-tracks enrichment (canonical URI per song): mirror the pattern in `getOnThisDay` — for each top track, run a follow-up query to find the most-played URI for that `(track_name, artist_name)` pair *within the effective range*, not lifetime. Use `Promise.all` over the top-tracks array.

Daily array: one query that groups by `date(datetime(ts, 'unixepoch', '-5 hours'))` to get per-day plays/minutes, plus a per-day top-track lookup. Build the final array by iterating from effective start to effective end inclusive, filling in zero-play days with `{ plays: 0, minutes: 0, topTrack: null }`. The per-day top-track lookup can be done with a single window-function-free query:

```sql
SELECT date(datetime(ts, 'unixepoch', '-5 hours')) as d,
       track_name, artist_name, COUNT(*) as plays
FROM plays
WHERE date(datetime(ts, 'unixepoch', '-5 hours')) BETWEEN ? AND ?
GROUP BY d, track_name COLLATE NOCASE, artist_name COLLATE NOCASE
```

Then in TypeScript, group by `d` and pick the top track per day. Single round-trip, simple JS reduction.

Default `limit` for top tracks/artists: **25** (matches `on_this_day`). Accept a `limit` parameter to override.

Add a JSDoc block to the function explaining the Eastern-time boundary, the clamping behavior, and the song-level aggregation rule — match the existing comment style in this file.

### 3. MCP tool registration (`src/mcp/tools.ts`)

Add to imports:

```ts
import { ..., getDateRange } from "../listening/queries";
```

Add tool definition (place after `on_this_day` for cohesion):

```ts
{
  name: "date_range",
  description: "Top tracks and artists for a specific date or range of dates from your listening history. Use start_date == end_date for a single day. Returns aggregated totals AND a per-day breakdown. For 'this date across all years' use on_this_day instead; for a full month or year use time_machine.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: { type: "string", description: "Start of range, YYYY-MM-DD (US Eastern). Required." },
      end_date: { type: "string", description: "End of range, YYYY-MM-DD (US Eastern), inclusive. Required. Use the same value as start_date for a single day." },
      limit: { type: "number", description: "Number of top tracks/artists to return. Default 25." },
    },
    required: ["start_date", "end_date"],
  },
},
```

Add handler case (place after `on_this_day`):

```ts
case "date_range": {
  const startDate = args.start_date as string;
  const endDate = args.end_date as string;
  if (!startDate || !endDate) return { error: "start_date and end_date are required (YYYY-MM-DD)." };
  const drLimit = (args.limit as number) ?? 25;
  try {
    return await getDateRange(env.DB, startDate, endDate, drLimit);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
```

### 4. Tests (`tests/unit/queries.test.ts`)

Add a new `describe("getDateRange")` block following the structure of the existing `getOnThisDay` tests. Seed enough plays to cover at least three distinct Eastern-time dates with varied tracks and artists.

Required test cases:

- **single day** — `start == end` returns plays for only that day, with daily array length 1.
- **multi-day range** — three-day window returns aggregated totals AND a daily array of length 3.
- **zero-play day inside range** — daily array still includes that day with `plays: 0` and `topTrack: null`.
- **Eastern-time boundary** — a play at 4am UTC on July 4 (= 11pm ET July 3) is bucketed into July 3, not July 4. Use the same fixture pattern as the existing on-this-day test.
- **song-level aggregation** — multiple URIs for the same `(track, artist)` collapse into one row in `topTracks`, with `plays` summed.
- **canonical URI is most-played within range** — even if a different URI dominates lifetime plays, `topTracks[].uri` reflects the most-played URI *within the requested range*.
- **clamping below dataset** — `start_date` earlier than the earliest play returns `effectiveStartDate` set to the dataset minimum, with `startDate` echoed unchanged.
- **range entirely outside dataset** — e.g. requesting a future range returns zeroed counters, empty arrays, `daysInRange: 0`, and echoes back the original dates.
- **invalid date format** — `"2024/07/04"` or `"July 4 2024"` throws / returns an error from the SQL helper.
- **inverted range** — `start_date > end_date` throws / returns an error.
- **limit parameter** — `limit: 1` returns exactly one entry in `topTracks`.

Use the existing test database setup — don't introduce a new fixtures pattern.

## Working agreement

- **Plan-first does not apply here** — this prompt IS the plan. Implement directly.
- Run `npm test` after each of the four file changes. All existing tests must keep passing.
- Match the surrounding code style. Match the JSDoc comment style in `queries.ts`.
- Don't touch unrelated code. If you spot something off, note it at the end of your final message under "future work."
- Don't add dashboard wiring, KV caching, or new API routes — this is MCP-only.

## Smoke test (after implementation)

Run these three calls against the local dev server (or describe them in the final summary if smoke testing isn't possible):

1. `date_range { start_date: "2024-07-04", end_date: "2024-07-04" }` — single day, US holiday.
2. `date_range { start_date: "2024-12-20", end_date: "2025-01-05" }` — two-week range crossing year boundary.
3. `date_range { start_date: "1990-01-01", end_date: "1990-12-31" }` — entirely outside dataset; should return zeroed empty result.

## Definition of done

- All new tests pass; existing test suite still green.
- `tools/list` MCP response includes `date_range` between `on_this_day` and `lost_favorites`.
- New types exported from `src/listening/types.ts`.
- No changes outside the four listed files.
- Final message summarizes: what shipped, any deviations from this prompt, and any "future work" notes.

## Known follow-ups (not in scope)

- Long ranges produce chunky daily arrays (~1825 entries for 5 years). Acceptable for MCP. If wired into a UI later, consider pagination or a `daily_granularity: "day" | "week" | "month"` parameter.
