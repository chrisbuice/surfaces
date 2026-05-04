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

import type { TimeMachineResult, LostFavorite, AffinityRow } from "./types";
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
