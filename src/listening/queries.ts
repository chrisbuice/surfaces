/**
 * queries.ts — D1 query builders for the listening-history layer.
 *
 * All queries read from the `plays` table (pre-filtered to music-only).
 * Affinity formula: sum(min(minutes, 7) * exp(-years_ago / 3) * (1 + 0.5 * (reason_end = 'trackdone')))
 *
 * URI vs. song-level aggregation:
 *   User-facing queries (time_machine, lost_favorites, skip_report "most skipped")
 *   aggregate at the SONG level = (track_name, artist_name), collapsing all
 *   URIs for the same song (re-releases, deluxe editions, regional variants).
 *
 *   Internal/queue queries (getTrackAffinity, getSkipPenalizedTracks, getSkipCount)
 *   stay at URI level — the queue needs a specific URI to play, and skip-veto
 *   should apply to the exact recording that was skipped.
 *
 *   See LISTENING_HISTORY.md "URI vs. song-level queries" for the full rule.
 */

import type { TimeMachineResult, LostFavorite, AffinityRow, OnThisDayResult, DateRangeResult } from "./types";
import reflectionsData from "./data/reflections.json";

const SNAPSHOT_DATE = "2026-04-29";

function reflectionForYear(year: number): string | null {
  for (const reflection of reflectionsData) {
    if (reflection.years.includes(year)) return reflection.name;
  }
  return null;
}

function reflectionForYears(years: number[]): string | null {
  // Return the reflection that covers the majority of the given years
  const reflectionCounts: Record<string, number> = {};
  for (const y of years) {
    const e = reflectionForYear(y);
    if (e) reflectionCounts[e] = (reflectionCounts[e] ?? 0) + 1;
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [e, c] of Object.entries(reflectionCounts)) {
    if (c > bestCount) { best = e; bestCount = c; }
  }
  return best;
}

function vibeForReflection(reflectionName: string): string | null {
  const reflection = reflectionsData.find((e) => e.name === reflectionName);
  return reflection?.summary ?? null;
}

/**
 * Time-machine: top tracks and artists for a given month or year.
 */
export async function getTimeMachine(
  db: D1Database,
  year: number,
  month?: number,
  limit: number = 15,
): Promise<TimeMachineResult> {
  const yearFilter = month != null
    ? "WHERE year = ? AND month = ?"
    : "WHERE year = ?";
  const binds: number[] = month != null ? [year, month] : [year];
  const period = month != null
    ? `${year}-${String(month).padStart(2, "0")}`
    : String(year);

  // Aggregate stats — unique_tracks at song level, case-insensitive
  const statsSQL = `
    SELECT COUNT(*) as total_plays,
           SUM(minutes) as total_minutes,
           (SELECT COUNT(*) FROM (
             SELECT 1 FROM plays ${yearFilter}
             GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
           )) as unique_tracks,
           COUNT(DISTINCT artist_name) as unique_artists
    FROM plays ${yearFilter}
  `;
  // Need to bind twice for the subquery + outer query
  const statsBinds = month != null ? [year, month, year, month] : [year, year];
  const stats = await db.prepare(statsSQL).bind(...statsBinds)
    .first<{ total_plays: number; total_minutes: number; unique_tracks: number; unique_artists: number }>();

  // Top tracks — aggregate at song level across all URIs, case-insensitive
  const topTracksSQL = `
    SELECT track_name, artist_name, COUNT(*) as plays, SUM(minutes) as mins
    FROM plays ${yearFilter}
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    ORDER BY plays DESC
    LIMIT ?
  `;
  const topTracks = await db.prepare(topTracksSQL).bind(...binds, limit)
    .all<{ track_name: string; artist_name: string; plays: number; mins: number }>();

  // Top artists
  const topArtistsSQL = `
    SELECT artist_name, COUNT(*) as plays, SUM(minutes) as mins
    FROM plays ${yearFilter}
    GROUP BY artist_name
    ORDER BY plays DESC
    LIMIT ?
  `;
  const topArtists = await db.prepare(topArtistsSQL).bind(...binds, limit)
    .all<{ artist_name: string; plays: number; mins: number }>();

  const reflection = reflectionForYear(year);

  return {
    period,
    totalPlays: stats?.total_plays ?? 0,
    totalHours: Math.round(((stats?.total_minutes ?? 0) / 60) * 10) / 10,
    uniqueTracks: stats?.unique_tracks ?? 0,
    uniqueArtists: stats?.unique_artists ?? 0,
    topTracks: topTracks.results.map((t) => ({
      track: t.track_name,
      artist: t.artist_name,
      plays: t.plays,
      minutes: Math.round(t.mins * 10) / 10,
    })),
    topArtists: topArtists.results.map((a) => ({
      artist: a.artist_name,
      plays: a.plays,
      minutes: Math.round(a.mins * 10) / 10,
    })),
    reflection,
    vibe: reflection ? vibeForReflection(reflection) : null,
  };
}

/**
 * Lost favorites: tracks with >= minPlays lifetime plays,
 * not played in >= minYearsGone years.
 *
 * Aggregates at SONG level (track_name, artist_name) — not URI level.
 * A song is only "lost" if ALL of its URIs (including re-releases, deluxe
 * editions, regional variants) have been abandoned. If any URI has a recent
 * play, the song is still active.
 *
 * Returns the URI with the most lifetime plays as the canonical URI for
 * queue insertion.
 */
export async function getLostFavorites(
  db: D1Database,
  minPlays: number = 20,
  minYearsGone: number = 2,
  limit: number = 50,
  artistFilter?: string,
): Promise<LostFavorite[]> {
  // Use end-of-day for the snapshot so "2 years ago" includes all plays on the cutoff date
  const snapshotEnd = Math.floor(new Date(SNAPSHOT_DATE + "T23:59:59Z").getTime() / 1000);
  const cutoffTs = snapshotEnd - minYearsGone * 365.25 * 24 * 60 * 60;

  let artistClause = "";
  const binds: (string | number)[] = [];
  if (artistFilter) {
    artistClause = "AND artist_name = ?";
    binds.push(artistFilter);
  }

  // Step 1: Aggregate at song level across all URIs, case-insensitive.
  // MAX(ts) across ALL URIs ensures a re-release with recent plays
  // disqualifies the song from being "lost". COLLATE NOCASE collapses
  // title-string drift like "Good As Hell" vs "Good as Hell".
  const sql = `
    SELECT track_name, artist_name,
           SUM(plays) as lifetime_plays,
           MAX(last_ts) as last_heard_any_uri,
           MIN(first_year) as first_year
    FROM (
      SELECT track_name, artist_name, spotify_track_uri,
             COUNT(*) as plays,
             MAX(ts) as last_ts,
             MIN(year) as first_year
      FROM plays
      WHERE 1=1 ${artistClause}
      GROUP BY spotify_track_uri
    )
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    HAVING last_heard_any_uri < ? AND lifetime_plays >= ?
    ORDER BY lifetime_plays DESC
    LIMIT ?
  `;
  binds.push(cutoffTs, minPlays, limit);

  const rows = await db.prepare(sql).bind(...binds)
    .all<{
      track_name: string; artist_name: string;
      lifetime_plays: number; last_heard_any_uri: number; first_year: number;
    }>();

  const results: LostFavorite[] = [];
  for (const row of rows.results) {
    // Find the canonical URI (most lifetime plays) for queue insertion
    const canonicalSQL = `
      SELECT spotify_track_uri, COUNT(*) as plays
      FROM plays WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
      GROUP BY spotify_track_uri ORDER BY plays DESC LIMIT 1
    `;
    const canonical = await db.prepare(canonicalSQL).bind(row.track_name, row.artist_name)
      .first<{ spotify_track_uri: string; plays: number }>();

    // Find peak month across all URIs for this song
    const peakSQL = `
      SELECT year, month, COUNT(*) as plays
      FROM plays WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
      GROUP BY year, month
      ORDER BY plays DESC LIMIT 1
    `;
    const peak = await db.prepare(peakSQL).bind(row.track_name, row.artist_name)
      .first<{ year: number; month: number; plays: number }>();

    const lastDate = new Date(row.last_heard_any_uri * 1000);
    const reflection = reflectionForYear(row.first_year);

    results.push({
      track: row.track_name,
      artist: row.artist_name,
      uri: canonical?.spotify_track_uri ?? "",
      lifetimePlays: row.lifetime_plays,
      lastPlayed: lastDate.toISOString().split("T")[0],
      peakMonth: peak ? `${peak.year}-${String(peak.month).padStart(2, "0")}` : "unknown",
      peakPlays: peak?.plays ?? 0,
      reflection,
    });
  }

  return results;
}

/**
 * Total count of lost favorites (for response metadata).
 * Song-level: collapses URIs per (track_name, artist_name).
 */
export async function getLostFavoritesCount(
  db: D1Database,
  minPlays: number = 20,
  minYearsGone: number = 2,
): Promise<number> {
  const snapshotEnd = Math.floor(new Date(SNAPSHOT_DATE + "T23:59:59Z").getTime() / 1000);
  const cutoffTs = snapshotEnd - minYearsGone * 365.25 * 24 * 60 * 60;

  const sql = `
    SELECT COUNT(*) as cnt FROM (
      SELECT track_name, artist_name
      FROM (
        SELECT track_name, artist_name, COUNT(*) as plays, MAX(ts) as last_ts
        FROM plays GROUP BY spotify_track_uri
      )
      GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
      HAVING MAX(last_ts) < ? AND SUM(plays) >= ?
    )
  `;
  const row = await db.prepare(sql).bind(cutoffTs, minPlays)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/**
 * Artist affinity: recency-weighted score.
 * Formula: sum(min(minutes, 7) * exp(-years_ago / 3) * (1 + 0.5 * (reason_end = 'trackdone')))
 *
 * D1/SQLite doesn't have exp(), so we compute years_ago and do the math in JS.
 */
export async function getArtistAffinity(
  db: D1Database,
  limit: number = 25,
): Promise<AffinityRow[]> {
  const nowTs = Math.floor(new Date(SNAPSHOT_DATE).getTime() / 1000);
  const secondsPerYear = 365.25 * 24 * 60 * 60;

  // Pull all plays grouped by artist with enough detail to compute affinity
  // We aggregate in SQL to keep data transfer small, but need per-play info for the formula
  // Compromise: fetch artist-level aggregated stats + the full affinity computation
  const sql = `
    SELECT artist_name,
           COUNT(*) as plays,
           MAX(ts) as last_ts,
           SUM(
             CASE
               WHEN minutes < 7 THEN minutes ELSE 7
             END * (1.0 + 0.5 * (reason_end = 'trackdone'))
           ) as weighted_minutes,
           SUM(
             CASE
               WHEN minutes < 7 THEN minutes ELSE 7
             END * (1.0 + 0.5 * (reason_end = 'trackdone'))
             * (1.0 / (1.0 + (? - ts) * 1.0 / (? * 3.0)))
           ) as approx_affinity
    FROM plays
    GROUP BY artist_name
    ORDER BY approx_affinity DESC
    LIMIT ?
  `;

  // The above uses a linear approximation for exp(-x). For better accuracy,
  // let's fetch raw data for top artists and compute in JS.
  // First get top candidates by raw play count
  const candidatesSQL = `
    SELECT artist_name, COUNT(*) as plays, MAX(ts) as last_ts
    FROM plays
    GROUP BY artist_name
    ORDER BY plays DESC
    LIMIT ?
  `;
  const candidates = await db.prepare(candidatesSQL).bind(Math.max(limit * 4, 100))
    .all<{ artist_name: string; plays: number; last_ts: number }>();

  const affinities: AffinityRow[] = [];

  for (const c of candidates.results) {
    // Fetch per-play data for this artist
    const playsSQL = `
      SELECT minutes, reason_end, ts FROM plays WHERE artist_name = ?
    `;
    const plays = await db.prepare(playsSQL).bind(c.artist_name)
      .all<{ minutes: number; reason_end: string; ts: number }>();

    let affinity = 0;
    for (const p of plays.results) {
      const cappedMin = Math.min(p.minutes, 7);
      const yearsAgo = (nowTs - p.ts) / secondsPerYear;
      const completionBonus = p.reason_end === "trackdone" ? 1.5 : 1.0;
      affinity += cappedMin * Math.exp(-yearsAgo / 3) * completionBonus;
    }

    affinities.push({
      name: c.artist_name,
      plays: c.plays,
      affinity: Math.round(affinity * 100) / 100,
      lastPlayed: new Date(c.last_ts * 1000).toISOString().split("T")[0],
    });
  }

  affinities.sort((a, b) => b.affinity - a.affinity);
  return affinities.slice(0, limit);
}

/**
 * Track affinity: same formula, grouped by spotify_track_uri.
 */
export async function getTrackAffinity(
  db: D1Database,
  limit: number = 50,
): Promise<AffinityRow[]> {
  const nowTs = Math.floor(new Date(SNAPSHOT_DATE).getTime() / 1000);
  const secondsPerYear = 365.25 * 24 * 60 * 60;

  // Get top candidates by play count
  const candidatesSQL = `
    SELECT track_name, artist_name, spotify_track_uri, COUNT(*) as plays, MAX(ts) as last_ts
    FROM plays
    GROUP BY spotify_track_uri
    ORDER BY plays DESC
    LIMIT ?
  `;
  const candidates = await db.prepare(candidatesSQL).bind(Math.max(limit * 4, 200))
    .all<{ track_name: string; artist_name: string; spotify_track_uri: string; plays: number; last_ts: number }>();

  const affinities: AffinityRow[] = [];

  for (const c of candidates.results) {
    const playsSQL = `
      SELECT minutes, reason_end, ts FROM plays WHERE spotify_track_uri = ?
    `;
    const plays = await db.prepare(playsSQL).bind(c.spotify_track_uri)
      .all<{ minutes: number; reason_end: string; ts: number }>();

    let affinity = 0;
    for (const p of plays.results) {
      const cappedMin = Math.min(p.minutes, 7);
      const yearsAgo = (nowTs - p.ts) / secondsPerYear;
      const completionBonus = p.reason_end === "trackdone" ? 1.5 : 1.0;
      affinity += cappedMin * Math.exp(-yearsAgo / 3) * completionBonus;
    }

    affinities.push({
      name: c.track_name,
      uri: c.spotify_track_uri,
      plays: c.plays,
      affinity: Math.round(affinity * 100) / 100,
      lastPlayed: new Date(c.last_ts * 1000).toISOString().split("T")[0],
    });
  }

  affinities.sort((a, b) => b.affinity - a.affinity);
  return affinities.slice(0, limit);
}

/**
 * Skip history for a specific track: count of fwdbtn events in last N days.
 */
export async function getSkipCount(
  db: D1Database,
  trackUri: string,
  days: number = 30,
): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const sql = `
    SELECT COUNT(*) as cnt FROM plays
    WHERE spotify_track_uri = ? AND reason_end = 'fwdbtn' AND ts >= ?
  `;
  const row = await db.prepare(sql).bind(trackUri, cutoff).first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/**
 * Skip-penalized tracks: URIs with ≥ minSkips fwdbtn skips (within 30s = ms_played < 30000)
 * in the last N days.
 */
export async function getSkipPenalizedTracks(
  db: D1Database,
  minSkips: number = 3,
  days: number = 30,
): Promise<Set<string>> {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const sql = `
    SELECT spotify_track_uri FROM plays
    WHERE reason_end = 'fwdbtn' AND ms_played < 30000 AND ts >= ?
    GROUP BY spotify_track_uri
    HAVING COUNT(*) >= ?
  `;
  const rows = await db.prepare(sql).bind(cutoff, minSkips)
    .all<{ spotify_track_uri: string }>();
  return new Set(rows.results.map((r) => r.spotify_track_uri));
}

/**
 * Monthly top: top N tracks for a specific calendar month.
 * Song-level: collapses URIs per (track_name, artist_name).
 */
export async function getMonthlyTop(
  db: D1Database,
  year: number,
  month: number,
  limit: number = 15,
): Promise<{ track_name: string; artist_name: string; plays: number }[]> {
  const sql = `
    SELECT track_name, artist_name, COUNT(*) as plays
    FROM plays
    WHERE year = ? AND month = ?
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    ORDER BY plays DESC
    LIMIT ?
  `;
  const rows = await db.prepare(sql).bind(year, month, limit)
    .all<{ track_name: string; artist_name: string; plays: number }>();
  return rows.results;
}

/**
 * On This Day: top tracks played on a specific calendar date (MM-DD) across all years.
 *
 * Aggregates at song level (track_name COLLATE NOCASE, artist_name COLLATE NOCASE),
 * same as time_machine and lost_favorites. Returns the canonical URI (most-played
 * URI for the song) for each result.
 *
 * Day boundary uses US Eastern time: datetime(ts, 'unixepoch', '-5 hours').
 * This is a fixed UTC-5 offset — the half-hour edge case around DST transitions
 * (March/November only) is acceptable and documented. Never affects May dates.
 */
export async function getOnThisDay(
  db: D1Database,
  month: number,
  day: number,
  limit: number = 25,
): Promise<OnThisDayResult> {
  const mmdd = `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

  // Filter plays to the target MM-DD in Eastern time
  const dateFilter = `strftime('%m-%d', datetime(ts, 'unixepoch', '-5 hours')) = ?`;

  // Aggregate stats
  const statsSQL = `
    SELECT COUNT(*) as total_plays,
           SUM(minutes) as total_minutes,
           (SELECT COUNT(*) FROM (
             SELECT 1 FROM plays WHERE ${dateFilter}
             GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
           )) as unique_tracks,
           COUNT(DISTINCT artist_name) as unique_artists
    FROM plays WHERE ${dateFilter}
  `;
  const stats = await db.prepare(statsSQL).bind(mmdd, mmdd)
    .first<{ total_plays: number; total_minutes: number; unique_tracks: number; unique_artists: number }>();

  // Years covered: which years have at least one play on this date
  const yearsSQL = `
    SELECT DISTINCT CAST(strftime('%Y', datetime(ts, 'unixepoch', '-5 hours')) AS INTEGER) as y
    FROM plays WHERE ${dateFilter}
    ORDER BY y
  `;
  const yearsRows = await db.prepare(yearsSQL).bind(mmdd)
    .all<{ y: number }>();
  const yearsCovered = yearsRows.results.map(r => r.y);

  // Top tracks — song-level aggregation with per-year breakdown
  const topTracksSQL = `
    SELECT track_name, artist_name, COUNT(*) as plays
    FROM plays WHERE ${dateFilter}
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    ORDER BY plays DESC
    LIMIT ?
  `;
  const topTracks = await db.prepare(topTracksSQL).bind(mmdd, limit)
    .all<{ track_name: string; artist_name: string; plays: number }>();

  // For each top track, get canonical URI, peak year, and years played
  const enrichedTracks = await Promise.all(
    topTracks.results.map(async (t) => {
      // Canonical URI: most-played URI for this song
      const canonicalSQL = `
        SELECT spotify_track_uri, COUNT(*) as plays
        FROM plays WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
        GROUP BY spotify_track_uri ORDER BY plays DESC LIMIT 1
      `;
      const canonical = await db.prepare(canonicalSQL).bind(t.track_name, t.artist_name)
        .first<{ spotify_track_uri: string; plays: number }>();

      // Peak year and years played on this specific date
      const yearBreakdownSQL = `
        SELECT CAST(strftime('%Y', datetime(ts, 'unixepoch', '-5 hours')) AS INTEGER) as y,
               COUNT(*) as plays
        FROM plays
        WHERE ${dateFilter}
          AND track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
        GROUP BY y ORDER BY plays DESC, y DESC
      `;
      const yearBreakdown = await db.prepare(yearBreakdownSQL).bind(mmdd, t.track_name, t.artist_name)
        .all<{ y: number; plays: number }>();

      const peakRow = yearBreakdown.results[0];
      const yearsPlayed = yearBreakdown.results.map(r => r.y).sort((a, b) => a - b);

      return {
        track: t.track_name,
        artist: t.artist_name,
        uri: canonical?.spotify_track_uri ?? "",
        totalPlays: t.plays,
        peakYear: peakRow?.y ?? 0,
        peakYearPlays: peakRow?.plays ?? 0,
        yearsPlayed,
      };
    }),
  );

  return {
    source: "local_history",
    date: mmdd,
    yearsCovered,
    totalPlaysAcrossYears: stats?.total_plays ?? 0,
    totalHoursAcrossYears: Math.round(((stats?.total_minutes ?? 0) / 60) * 10) / 10,
    uniqueTracks: stats?.unique_tracks ?? 0,
    uniqueArtists: stats?.unique_artists ?? 0,
    topTracks: enrichedTracks,
  };
}

/**
 * Date range: top tracks and artists for a specific date or contiguous range of dates.
 *
 * Day boundary uses US Eastern time: datetime(ts, 'unixepoch', '-5 hours').
 * This is a fixed UTC-5 offset — the half-hour edge case around DST transitions
 * (March/November only) is acceptable and documented.
 *
 * Aggregates at song level (track_name COLLATE NOCASE, artist_name COLLATE NOCASE),
 * same as time_machine, on_this_day, and lost_favorites. Canonical URI = most-played
 * URI for the song within the requested range.
 *
 * Requested dates are clamped to the dataset bounds (earliest play → today Eastern).
 * If the entire range is outside the dataset, returns an empty result with zeroed counters.
 */
export async function getDateRange(
  db: D1Database,
  startDate: string,
  endDate: string,
  limit: number = 25,
): Promise<DateRangeResult> {
  // Validate date format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate)) throw new Error(`Invalid start_date format: "${startDate}". Expected YYYY-MM-DD.`);
  if (!dateRegex.test(endDate)) throw new Error(`Invalid end_date format: "${endDate}". Expected YYYY-MM-DD.`);

  // Validate range direction
  if (startDate > endDate) throw new Error(`start_date (${startDate}) is after end_date (${endDate}).`);

  // Find dataset bounds
  const minDateRow = await db.prepare(
    "SELECT date(datetime(MIN(ts), 'unixepoch', '-5 hours')) as min_date FROM plays"
  ).first<{ min_date: string | null }>();
  const datasetMin = minDateRow?.min_date;

  // Today in Eastern time (fixed UTC-5)
  const nowMs = Date.now();
  const todayEastern = new Date(nowMs - 5 * 60 * 60 * 1000).toISOString().split("T")[0];

  // If no data at all, or range is entirely outside dataset, return empty
  if (!datasetMin) {
    return emptyDateRangeResult(startDate, endDate);
  }

  // Clamp
  const effectiveStartDate = startDate < datasetMin ? datasetMin : startDate;
  const effectiveEndDate = endDate > todayEastern ? todayEastern : endDate;

  if (effectiveStartDate > effectiveEndDate) {
    return emptyDateRangeResult(startDate, endDate);
  }

  // Count days in range (inclusive)
  const daysInRange = daysBetween(effectiveStartDate, effectiveEndDate) + 1;

  const dateFilter = `date(datetime(ts, 'unixepoch', '-5 hours')) BETWEEN ? AND ?`;

  // Aggregate stats
  const statsSQL = `
    SELECT COUNT(*) as total_plays,
           SUM(minutes) as total_minutes,
           (SELECT COUNT(*) FROM (
             SELECT 1 FROM plays WHERE ${dateFilter}
             GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
           )) as unique_tracks,
           COUNT(DISTINCT artist_name) as unique_artists
    FROM plays WHERE ${dateFilter}
  `;
  const stats = await db.prepare(statsSQL)
    .bind(effectiveStartDate, effectiveEndDate, effectiveStartDate, effectiveEndDate)
    .first<{ total_plays: number; total_minutes: number; unique_tracks: number; unique_artists: number }>();

  // Top tracks — song-level aggregation
  const topTracksSQL = `
    SELECT track_name, artist_name, COUNT(*) as plays, SUM(minutes) as mins
    FROM plays WHERE ${dateFilter}
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    ORDER BY plays DESC
    LIMIT ?
  `;
  const topTracksRows = await db.prepare(topTracksSQL)
    .bind(effectiveStartDate, effectiveEndDate, limit)
    .all<{ track_name: string; artist_name: string; plays: number; mins: number }>();

  // Canonical URI per top track (most-played within the range)
  const topTracks = await Promise.all(
    topTracksRows.results.map(async (t) => {
      const canonicalSQL = `
        SELECT spotify_track_uri, COUNT(*) as plays
        FROM plays
        WHERE ${dateFilter}
          AND track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
        GROUP BY spotify_track_uri ORDER BY plays DESC LIMIT 1
      `;
      const canonical = await db.prepare(canonicalSQL)
        .bind(effectiveStartDate, effectiveEndDate, t.track_name, t.artist_name)
        .first<{ spotify_track_uri: string; plays: number }>();

      return {
        track: t.track_name,
        artist: t.artist_name,
        uri: canonical?.spotify_track_uri ?? "",
        plays: t.plays,
        minutes: Math.round(t.mins * 10) / 10,
      };
    }),
  );

  // Top artists
  const topArtistsSQL = `
    SELECT artist_name, COUNT(*) as plays, SUM(minutes) as mins
    FROM plays WHERE ${dateFilter}
    GROUP BY artist_name
    ORDER BY plays DESC
    LIMIT ?
  `;
  const topArtistsRows = await db.prepare(topArtistsSQL)
    .bind(effectiveStartDate, effectiveEndDate, limit)
    .all<{ artist_name: string; plays: number; mins: number }>();

  const topArtists = topArtistsRows.results.map((a) => ({
    artist: a.artist_name,
    plays: a.plays,
    minutes: Math.round(a.mins * 10) / 10,
  }));

  // Daily breakdown — per-day plays/minutes
  const dailyStatsSQL = `
    SELECT date(datetime(ts, 'unixepoch', '-5 hours')) as d,
           COUNT(*) as plays, SUM(minutes) as mins
    FROM plays
    WHERE ${dateFilter}
    GROUP BY d
  `;
  const dailyStatsRows = await db.prepare(dailyStatsSQL)
    .bind(effectiveStartDate, effectiveEndDate)
    .all<{ d: string; plays: number; mins: number }>();

  const dailyStatsMap = new Map<string, { plays: number; mins: number }>();
  for (const r of dailyStatsRows.results) {
    dailyStatsMap.set(r.d, { plays: r.plays, mins: r.mins });
  }

  // Per-day top track: single query, group by day + song, then pick top per day in JS
  const dailyTopSQL = `
    SELECT date(datetime(ts, 'unixepoch', '-5 hours')) as d,
           track_name, artist_name, COUNT(*) as plays
    FROM plays
    WHERE ${dateFilter}
    GROUP BY d, track_name COLLATE NOCASE, artist_name COLLATE NOCASE
  `;
  const dailyTopRows = await db.prepare(dailyTopSQL)
    .bind(effectiveStartDate, effectiveEndDate)
    .all<{ d: string; track_name: string; artist_name: string; plays: number }>();

  // Group by day, pick the one with most plays
  const dailyTopMap = new Map<string, { track: string; artist: string; plays: number }>();
  for (const r of dailyTopRows.results) {
    const existing = dailyTopMap.get(r.d);
    if (!existing || r.plays > existing.plays) {
      dailyTopMap.set(r.d, { track: r.track_name, artist: r.artist_name, plays: r.plays });
    }
  }

  // Build daily array, filling zero-play days
  const daily = [];
  let daysWithPlays = 0;
  const cursor = new Date(effectiveStartDate + "T00:00:00Z");
  const endDateObj = new Date(effectiveEndDate + "T00:00:00Z");
  while (cursor <= endDateObj) {
    const d = cursor.toISOString().split("T")[0];
    const dayStats = dailyStatsMap.get(d);
    const dayTop = dailyTopMap.get(d);
    if (dayStats && dayStats.plays > 0) daysWithPlays++;
    daily.push({
      date: d,
      plays: dayStats?.plays ?? 0,
      minutes: Math.round((dayStats?.mins ?? 0) * 10) / 10,
      topTrack: dayTop ?? null,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    source: "local_history",
    startDate,
    endDate,
    effectiveStartDate,
    effectiveEndDate,
    daysInRange,
    daysWithPlays,
    totalPlays: stats?.total_plays ?? 0,
    totalMinutes: Math.round((stats?.total_minutes ?? 0) * 10) / 10,
    uniqueTracks: stats?.unique_tracks ?? 0,
    uniqueArtists: stats?.unique_artists ?? 0,
    topTracks,
    topArtists,
    daily,
  };
}

function emptyDateRangeResult(startDate: string, endDate: string): DateRangeResult {
  return {
    source: "local_history",
    startDate,
    endDate,
    effectiveStartDate: startDate,
    effectiveEndDate: endDate,
    daysInRange: 0,
    daysWithPlays: 0,
    totalPlays: 0,
    totalMinutes: 0,
    uniqueTracks: 0,
    uniqueArtists: 0,
    topTracks: [],
    topArtists: [],
    daily: [],
  };
}

/** Inclusive day count between two YYYY-MM-DD strings. */
function daysBetween(a: string, b: string): number {
  const msPerDay = 86400000;
  const da = new Date(a + "T00:00:00Z").getTime();
  const db = new Date(b + "T00:00:00Z").getTime();
  return Math.round((db - da) / msPerDay);
}
