/**
 * queries.ts — SQL query helpers for the nightly constellation cron.
 *
 * Three phases per spec §7.1:
 *   1. buildNodes        — artists with ≥10 plays; total/peak_year/years_active
 *   2. buildEdges        — pair-level session + playlist co-occurrence + weight
 *   3. computeEraBuckets — five data-driven quintiles by peak_year
 *
 * The edges query is the expensive one. To stay inside D1's 30-second wall-
 * clock per query, it is chained year-by-year — each year holds ~17K plays,
 * the within-30-min self-join is bounded, and counts accumulate in a JS Map.
 *
 * Edge weight (spec §5.3):
 *   weight_raw = log(session_co) + 2 * log(playlist_co_weighted + 1)
 *   where playlist_co_weighted = seasonal_co * 1.5 + non_seasonal_co
 *
 * Threshold: pairs with session_co < 3 are dropped (the noise filter).
 *
 * All artist identity is on artist_name (the only signal in `plays`); a
 * separate join against artist_taste resolves Spotify URIs where possible.
 */

import type { NodeRow, EdgeRow, ArtistIdResolution } from "./types";

// Tunables — see spec §5.3 / §5.2. Bump SESSION_THRESHOLD if the graph
// reads as noisy; drop to 2 if it reads as too sparse. Start at 3.
export const MIN_PLAYS = 300;
export const SESSION_WINDOW_SECONDS = 30 * 60;
export const SESSION_THRESHOLD = 3;
export const SEASONAL_PLAYLIST_BONUS = 1.5;
export const PLAYLIST_WEIGHT = 2;

// ──────────────────────────────────────────────────────────────────────
// Phase 1 — nodes
// ──────────────────────────────────────────────────────────────────────

/**
 * Build the node list: every artist with ≥10 plays since 2011, with
 * total_plays, peak_year (calendar year of peak playcount, ties broken
 * by most-recent year), and years_active (count of distinct years with
 * ≥5 plays).
 *
 * Implementation: ONE simple `GROUP BY (artist_name, year)` scan that
 * fits well inside D1's per-statement CPU budget; all the aggregation
 * (totals, peak detection, years_active counting, ≥10-play filter) is
 * done in JS over the small (~5–10K row) result set.
 *
 * Why not push more into SQL: a previous version used four CTEs + a
 * window function + an IN-subquery and tripped D1's per-statement CPU
 * limit on the 260K-row `plays` table. JS aggregation over the
 * already-grouped rows is trivially cheap.
 *
 * Then attaches `artist_id` resolution from artist_taste (resolved /
 * ambiguous / unresolved per spec §5.10).
 */
export async function buildNodes(db: D1Database): Promise<NodeRow[]> {
  const sql = `
    SELECT artist_name, year, COUNT(*) AS plays_in_year
    FROM plays
    GROUP BY artist_name, year
  `;
  const result = await db.prepare(sql)
    .all<{ artist_name: string; year: number; plays_in_year: number }>();
  const rows = result.results ?? [];

  // Aggregate per artist in JS.
  interface Acc {
    total: number;
    peak_plays: number;
    peak_year: number;
    years_active: number;
  }
  const byArtist = new Map<string, Acc>();
  for (const r of rows) {
    let acc = byArtist.get(r.artist_name);
    if (!acc) {
      acc = { total: 0, peak_plays: 0, peak_year: r.year, years_active: 0 };
      byArtist.set(r.artist_name, acc);
    }
    acc.total += r.plays_in_year;
    // Peak: max plays_in_year, ties broken by most-recent year (matches
    // the previous SQL window function's ORDER BY plays_in_year DESC, year DESC).
    if (
      r.plays_in_year > acc.peak_plays ||
      (r.plays_in_year === acc.peak_plays && r.year > acc.peak_year)
    ) {
      acc.peak_plays = r.plays_in_year;
      acc.peak_year = r.year;
    }
    if (r.plays_in_year >= 5) acc.years_active++;
  }

  // Filter to ≥10 plays, sort desc by total_plays (matches old shape).
  const baseRows: Array<{
    artist_name: string;
    total_plays: number;
    peak_year: number;
    years_active: number;
  }> = [];
  for (const [artist_name, acc] of byArtist) {
    if (acc.total >= MIN_PLAYS) {
      baseRows.push({
        artist_name,
        total_plays: acc.total,
        peak_year: acc.peak_year,
        years_active: acc.years_active,
      });
    }
  }
  baseRows.sort((a, b) => b.total_plays - a.total_plays);

  // Resolve artist IDs (resolved / ambiguous / unresolved per spec §5.10).
  const idMap = await loadArtistIdMap(db);
  return baseRows.map(r => ({
    artist_name: r.artist_name,
    artist_id: idMap.get(r.artist_name) ?? { kind: "unresolved" as const },
    total_plays: r.total_plays,
    peak_year: r.peak_year,
    years_active: r.years_active,
  }));
}

/**
 * Load a name → resolution-state map from artist_taste.
 * - kind "resolved" — exactly one matching id_count
 * - kind "ambiguous" — multiple distinct ids share this display name
 * Names not present in artist_taste are absent from the map; callers
 * default to { kind: "unresolved" }.
 */
async function loadArtistIdMap(db: D1Database): Promise<Map<string, ArtistIdResolution>> {
  const sql = `
    SELECT artist_name,
      MIN(artist_id) AS any_id,
      COUNT(DISTINCT artist_id) AS id_count
    FROM artist_taste
    GROUP BY artist_name COLLATE NOCASE
  `;
  let rows: Array<{ artist_name: string; any_id: string; id_count: number }> = [];
  try {
    const r = await db.prepare(sql).all<{ artist_name: string; any_id: string; id_count: number }>();
    rows = r.results ?? [];
  } catch {
    // artist_taste may be empty in fresh installs / tests; not fatal.
    return new Map();
  }
  const map = new Map<string, ArtistIdResolution>();
  for (const r of rows) {
    if (r.id_count === 1) {
      map.set(r.artist_name, { kind: "resolved", id: r.any_id });
    } else {
      map.set(r.artist_name, { kind: "ambiguous" });
    }
  }
  return map;
}

// ──────────────────────────────────────────────────────────────────────
// Phase 2 — edges
// ──────────────────────────────────────────────────────────────────────

/** A pair of co-occurring artists at the session level. */
interface SessionPairCount {
  artist_a: string;
  artist_b: string;
  session_co: number;
}

/** A pair of co-occurring artists at the playlist level. */
interface PlaylistPairCount {
  artist_a: string;
  artist_b: string;
  total_playlist_co: number;
  seasonal_playlist_co: number;
}

/**
 * List the distinct years present in plays — used to chunk the edges
 * self-join across the 30-second wall-clock budget.
 */
export async function listPlayYears(db: D1Database): Promise<number[]> {
  const sql = `SELECT DISTINCT year FROM plays ORDER BY year ASC`;
  const r = await db.prepare(sql).all<{ year: number }>();
  return (r.results ?? []).map(row => row.year);
}

/**
 * Compute session co-occurrence counts for a single calendar year.
 *
 * Two plays "co-occur" when they happen within 30 minutes of each
 * other (spec §5.3). The pair enumeration is done in JS via a
 * sliding window over plays sorted by ts.
 *
 * Why: the previous version did a SQL self-join which tripped D1's
 * per-statement CPU limit even when restricted to one year. Pulling
 * (artist_name, ts) for the year and walking it in JS is cheaper for
 * D1 (sequential index scan, no join product) and trivially fast in
 * Workers' JS runtime — typical year has ~25K plays, average 1-2
 * within-window neighbors per row, so ~50K JS ops per year.
 */
export async function buildSessionCoForYear(
  db: D1Database,
  year: number,
  nodeArtists: Set<string>,
): Promise<SessionPairCount[]> {
  const sql = `SELECT artist_name, ts FROM plays WHERE year = ? ORDER BY ts ASC`;
  const r = await db.prepare(sql).bind(year)
    .all<{ artist_name: string; ts: number }>();
  const rows = r.results ?? [];

  const pairCounts = new Map<string, number>();
  let windowStart = 0;
  for (let j = 0; j < rows.length; j++) {
    const rj = rows[j];
    // Slide the window: drop rows older than rj.ts - SESSION_WINDOW_SECONDS.
    while (windowStart < j && rows[windowStart].ts < rj.ts - SESSION_WINDOW_SECONDS) {
      windowStart++;
    }
    // Pair rj with every row in [windowStart, j) that has a different
    // artist and that we care about (both endpoints in the node list).
    if (!nodeArtists.has(rj.artist_name)) continue;
    for (let k = windowStart; k < j; k++) {
      const rk = rows[k];
      if (rk.artist_name === rj.artist_name) continue;
      if (!nodeArtists.has(rk.artist_name)) continue;
      const key = pairKey(rk.artist_name, rj.artist_name);
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
  }

  const out: SessionPairCount[] = [];
  for (const [key, count] of pairCounts) {
    const [artist_a, artist_b] = key.split("||");
    out.push({ artist_a, artist_b, session_co: count });
  }
  return out;
}

/**
 * Compute playlist co-occurrence counts across all of the user's
 * playlists, separating the seasonal subset so the 1.5× bonus
 * (spec §5.3) can be applied at edge-weight time.
 *
 * Table is small (39 seasonal + assorted other playlists × ~50 tracks
 * ≈ a few thousand rows), so a single self-join is fine.
 */
export async function buildPlaylistCo(
  db: D1Database,
  nodeArtists: Set<string>,
): Promise<PlaylistPairCount[]> {
  const sql = `
    SELECT
      CASE WHEN a.artist_name < b.artist_name THEN a.artist_name ELSE b.artist_name END AS artist_a,
      CASE WHEN a.artist_name < b.artist_name THEN b.artist_name ELSE a.artist_name END AS artist_b,
      SUM(CASE WHEN sp.spotify_playlist_id IS NOT NULL THEN 1 ELSE 0 END) AS seasonal_playlist_co,
      COUNT(*) AS total_playlist_co
    FROM playlist_tracks a
    JOIN playlist_tracks b ON
      a.playlist_id = b.playlist_id
      AND a.artist_name <> b.artist_name
      AND a.track_id < b.track_id
    LEFT JOIN seasonal_playlists sp ON sp.spotify_playlist_id = a.playlist_id
    GROUP BY artist_a, artist_b
  `;
  let rows: Array<{
    artist_a: string;
    artist_b: string;
    total_playlist_co: number;
    seasonal_playlist_co: number;
  }> = [];
  try {
    const r = await db.prepare(sql).all<{
      artist_a: string;
      artist_b: string;
      total_playlist_co: number;
      seasonal_playlist_co: number;
    }>();
    rows = r.results ?? [];
  } catch {
    // playlist_tracks may not yet be populated; treat as zero playlist signal.
    return [];
  }
  return rows.filter(p => nodeArtists.has(p.artist_a) && nodeArtists.has(p.artist_b));
}

/**
 * Apply the edge-weight formula and the ≥3-session noise threshold
 * to merged session + playlist counts. Pure function; tested directly.
 */
export function computeEdgeWeights(
  sessionCounts: Map<string, number>,            // key = "a||b" (canonical)
  playlistCounts: Map<string, { total: number; seasonal: number }>,
): EdgeRow[] {
  const out: EdgeRow[] = [];
  for (const [key, sessionCo] of sessionCounts) {
    if (sessionCo < SESSION_THRESHOLD) continue;
    const [artist_a, artist_b] = key.split("||");
    const pl = playlistCounts.get(key);
    const total = pl?.total ?? 0;
    const seasonal = pl?.seasonal ?? 0;
    // playlist_co_weighted: seasonal counts as 1.5, non-seasonal as 1.
    const playlist_co_weighted = seasonal * SEASONAL_PLAYLIST_BONUS + (total - seasonal);
    const weight = Math.log(sessionCo) + PLAYLIST_WEIGHT * Math.log(playlist_co_weighted + 1);
    out.push({
      artist_a,
      artist_b,
      session_co: sessionCo,
      playlist_co: playlist_co_weighted,
      weight,
    });
  }
  // Sort by weight desc — convenient for the top-3-per-node rendering rule.
  out.sort((a, b) => b.weight - a.weight);
  return out;
}

/** Canonical pair key — artist_a < artist_b always. */
export function pairKey(artistA: string, artistB: string): string {
  return artistA < artistB ? `${artistA}||${artistB}` : `${artistB}||${artistA}`;
}

/**
 * Top-level edges builder: chains buildSessionCoForYear across all
 * years, accumulates counts, joins playlist co-occurrence, applies
 * the weight formula. Each year query is well within the 30s budget.
 */
export async function buildEdges(
  db: D1Database,
  nodeArtists: Set<string>,
): Promise<EdgeRow[]> {
  const years = await listPlayYears(db);
  const sessionCounts = new Map<string, number>();

  for (const year of years) {
    const yearPairs = await buildSessionCoForYear(db, year, nodeArtists);
    for (const p of yearPairs) {
      const k = pairKey(p.artist_a, p.artist_b);
      sessionCounts.set(k, (sessionCounts.get(k) ?? 0) + p.session_co);
    }
  }

  const playlistRows = await buildPlaylistCo(db, nodeArtists);
  const playlistCounts = new Map<string, { total: number; seasonal: number }>();
  for (const p of playlistRows) {
    playlistCounts.set(pairKey(p.artist_a, p.artist_b), {
      total: p.total_playlist_co,
      seasonal: p.seasonal_playlist_co,
    });
  }

  return computeEdgeWeights(sessionCounts, playlistCounts);
}

// ──────────────────────────────────────────────────────────────────────
// Phase 3 — era buckets
// ──────────────────────────────────────────────────────────────────────

/**
 * Compute five data-driven era boundaries from a list of peak years
 * (one per node). Each bucket holds roughly 20% of nodes; cuts are
 * chosen so populations balance, not by fixed calendar windows.
 *
 * Pure function — runs against the in-memory node list, no DB call.
 *
 * Returns an array of 5 ascending year ranges. Boundaries are inclusive
 * on the lower end and inclusive on the upper end (each year belongs
 * to exactly one bucket).
 */
export function computeEraBuckets(peakYears: number[]): Array<{ start_year: number; end_year: number }> {
  if (peakYears.length === 0) return [];
  const sorted = [...peakYears].sort((a, b) => a - b);
  const n = sorted.length;
  const cuts: number[] = [];
  // Quintile cut indices at 20%, 40%, 60%, 80%.
  for (let i = 1; i <= 4; i++) {
    cuts.push(sorted[Math.floor((n * i) / 5)]);
  }

  const minYear = sorted[0];
  const maxYear = sorted[n - 1];

  // Build buckets so each year belongs to exactly one. Adjacent buckets
  // touch but don't overlap; if two cuts collapse to the same year, we
  // bump the next one up by 1 so populations still split.
  const boundaries: Array<{ start_year: number; end_year: number }> = [];
  let lo = minYear;
  for (let i = 0; i < 4; i++) {
    let hi = cuts[i];
    if (hi < lo) hi = lo;                   // monotonic guard
    boundaries.push({ start_year: lo, end_year: hi });
    lo = hi + 1;
  }
  boundaries.push({ start_year: lo, end_year: Math.max(lo, maxYear) });
  return boundaries;
}

/** Index of which era bucket a given year falls in (0..4), or 0 if none match. */
export function eraIndexFor(year: number, buckets: Array<{ start_year: number; end_year: number }>): number {
  for (let i = 0; i < buckets.length; i++) {
    if (year >= buckets[i].start_year && year <= buckets[i].end_year) return i;
  }
  // If the year is outside every bucket (shouldn't happen given how
  // buckets are derived), clamp to the nearest end.
  if (year < buckets[0].start_year) return 0;
  return buckets.length - 1;
}

/** Render a bucket like {start:2011,end:2014} as the human-readable label "2011–2014". */
export function eraLabel(b: { start_year: number; end_year: number }, isLatest: boolean): string {
  if (isLatest) return `${b.start_year}–now`;
  if (b.start_year === b.end_year) return `${b.start_year}`;
  return `${b.start_year}–${b.end_year}`;
}

// ──────────────────────────────────────────────────────────────────────
// Stats
// ──────────────────────────────────────────────────────────────────────

/**
 * One-shot stats query for the JSON `stats` object.
 * Numbers are derived from the same source tables as the rest of the
 * pipeline; no caching layer between this and the final blob.
 */
export async function buildStats(db: D1Database): Promise<{
  total_plays: number;
  total_artists: number;
  total_seasons: number;
  data_starts: string;
}> {
  const playsRow = await db.prepare(
    `SELECT COUNT(*) AS total_plays, MIN(ts) AS earliest_ts FROM plays`
  ).first<{ total_plays: number; earliest_ts: number }>();

  const artistsRow = await db.prepare(
    `SELECT COUNT(DISTINCT artist_name) AS total_artists FROM plays`
  ).first<{ total_artists: number }>();

  let total_seasons = 0;
  try {
    const r = await db.prepare(
      `SELECT COUNT(*) AS n FROM seasonal_playlists`
    ).first<{ n: number }>();
    total_seasons = r?.n ?? 0;
  } catch { /* fresh installs */ }

  const data_starts = playsRow?.earliest_ts
    ? new Date(playsRow.earliest_ts * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  return {
    total_plays: playsRow?.total_plays ?? 0,
    total_artists: artistsRow?.total_artists ?? 0,
    total_seasons,
    data_starts,
  };
}
