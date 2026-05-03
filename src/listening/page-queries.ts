/**
 * page-queries.ts — queries for the /surfaces page visuals.
 *
 * These are display-only aggregations, built nightly and cached in KV.
 * They live separately from queries.ts (which serves internal/MCP-facing
 * endpoints with different aggregation rules).
 *
 * Both functions return JSON-serializable objects matching the shapes
 * specified in surfaces-page-spec-v2.md §4.4 and §5.5.
 */

// ── Types ──

export interface ListeningByMonthResult {
  generated_at: string;
  months: Array<{ month: string; plays: number }>;
}

export interface TopArtistEntry {
  name: string;
  spotify_id: string | null;
  total_plays: number;
  adjusted_plays: number;
  plays_by_year: Array<{ year: number; plays: number }>;
  peak_year: number;
}

export interface TopArtistsResult {
  generated_at: string;
  artists: TopArtistEntry[];
}

// ── KV keys ──

export const LISTENING_BY_MONTH_KEY = "listening-by-month:latest";
export const TOP_ARTISTS_KEY = "top-artists:latest";
export const KV_TTL_SECONDS = 26 * 60 * 60; // 26 hours, same as constellation

// ── Builders ──

/**
 * Aggregate play counts per calendar month across the full history.
 * Returns ~180 rows (Dec 2011 → present).
 */
export async function buildListeningByMonth(
  db: D1Database,
): Promise<ListeningByMonthResult> {
  const sql = `
    SELECT year, month, COUNT(*) as plays
    FROM plays
    GROUP BY year, month
    ORDER BY year, month
  `;
  const rows = await db.prepare(sql)
    .all<{ year: number; month: number; plays: number }>();

  return {
    generated_at: new Date().toISOString(),
    months: rows.results.map((r) => ({
      month: `${r.year}-${String(r.month).padStart(2, "0")}`,
      plays: r.plays,
    })),
  };
}

/**
 * Top 12 artists by adjusted plays (per-year capped at 2× artist median).
 *
 * The adjustment prevents single-month obsessions from dominating the list
 * while still letting binge artists compete. The sparkline shows the *true*
 * shape (uncapped counts), so readers can see the difference.
 *
 * Spotify IDs come from artist_taste. Artists without a match get null.
 *
 * Per decision D5: every sparkline covers the full year range (min year in
 * data → current year), with zeros for years before the artist appeared.
 */
export async function buildTopArtists(
  db: D1Database,
): Promise<TopArtistsResult> {
  // Step 1: per-artist per-year play counts, case-insensitive grouping.
  // Take the most-recent spelling as canonical display name (decision D8).
  const sql = `
    SELECT
      artist_name,
      year,
      COUNT(*) as plays,
      MAX(ts) as latest_ts
    FROM plays
    GROUP BY artist_name COLLATE NOCASE, year
    ORDER BY artist_name COLLATE NOCASE, year
  `;
  const rows = await db.prepare(sql)
    .all<{ artist_name: string; year: number; plays: number; latest_ts: number }>();

  // Group by artist (case-insensitive)
  const artistMap = new Map<string, {
    canonicalName: string;
    latestTs: number;
    yearPlays: Map<number, number>;
  }>();

  for (const row of rows.results) {
    const key = row.artist_name.toLowerCase();
    let entry = artistMap.get(key);
    if (!entry) {
      entry = { canonicalName: row.artist_name, latestTs: row.latest_ts, yearPlays: new Map() };
      artistMap.set(key, entry);
    }
    // Keep the most-recent spelling
    if (row.latest_ts > entry.latestTs) {
      entry.canonicalName = row.artist_name;
      entry.latestTs = row.latest_ts;
    }
    entry.yearPlays.set(row.year, (entry.yearPlays.get(row.year) ?? 0) + row.plays);
  }

  // Step 2: compute adjusted plays for ranking
  const ranked: Array<{
    key: string;
    name: string;
    totalPlays: number;
    adjustedPlays: number;
    yearPlays: Map<number, number>;
    peakYear: number;
  }> = [];

  for (const [key, entry] of artistMap) {
    const yearCounts = [...entry.yearPlays.values()].sort((a, b) => a - b);
    const median = yearCounts[Math.floor(yearCounts.length / 2)];
    const cap = 2 * median;

    let adjustedPlays = 0;
    let totalPlays = 0;
    let peakYear = 0;
    let peakPlays = 0;

    for (const [year, plays] of entry.yearPlays) {
      totalPlays += plays;
      adjustedPlays += Math.min(plays, cap);
      if (plays > peakPlays) {
        peakPlays = plays;
        peakYear = year;
      }
    }

    ranked.push({
      key,
      name: entry.canonicalName,
      totalPlays,
      adjustedPlays,
      yearPlays: entry.yearPlays,
      peakYear,
    });
  }

  // Step 3: sort by adjusted plays, take top 12
  ranked.sort((a, b) => b.adjustedPlays - a.adjustedPlays);
  const top12 = ranked.slice(0, 12);

  // Step 4: determine the full year range for sparklines (decision D5)
  const allYears = rows.results.map((r) => r.year);
  const minYear = Math.min(...allYears);
  const maxYear = Math.max(...allYears);

  // Step 5: look up Spotify IDs from artist_taste (decision D13)
  const artistNames = top12.map((a) => a.name);
  let spotifyIds = new Map<string, string>();
  if (artistNames.length > 0) {
    const placeholders = artistNames.map(() => "?").join(", ");
    const idRows = await db.prepare(
      `SELECT artist_name, artist_id FROM artist_taste
       WHERE artist_name COLLATE NOCASE IN (${placeholders})`,
    ).bind(...artistNames)
      .all<{ artist_name: string; artist_id: string }>();
    for (const row of idRows.results) {
      spotifyIds.set(row.artist_name.toLowerCase(), row.artist_id);
    }
  }

  // Step 6: build the response
  const artists: TopArtistEntry[] = top12.map((a) => {
    const playsByYear: Array<{ year: number; plays: number }> = [];
    for (let y = minYear; y <= maxYear; y++) {
      playsByYear.push({ year: y, plays: a.yearPlays.get(y) ?? 0 });
    }
    return {
      name: a.name,
      spotify_id: spotifyIds.get(a.key) ?? null,
      total_plays: a.totalPlays,
      adjusted_plays: a.adjustedPlays,
      plays_by_year: playsByYear,
      peak_year: a.peakYear,
    };
  });

  return {
    generated_at: new Date().toISOString(),
    artists,
  };
}
