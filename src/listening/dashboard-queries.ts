/**
 * dashboard-queries.ts — Query helpers for dashboard API endpoints.
 *
 * All user-facing queries aggregate at SONG level (track_name COLLATE NOCASE,
 * artist_name COLLATE NOCASE) per LISTENING_HISTORY.md.
 */

import type { LostFavorite } from "./types";
import { getLostFavorites } from "./queries";
import erasData from "./data/eras.json";
import neverStaleCoreData from "./data/never_stale_core.json";
import companionsData from "./data/companions.json";

const NEVER_STALE_SET = new Set(neverStaleCoreData.map((a) => a.artist));
const NEVER_STALE_MAP = new Map(neverStaleCoreData.map((a) => [a.artist, a.years_in_top50]));

// ── Search ──────────────────────────────────────────────────

export interface SearchResult {
  type: "track" | "artist";
  name: string;
  artist?: string;
  plays: number;
}

export async function search(
  db: D1Database,
  query: string,
  limit: number = 10,
): Promise<SearchResult[]> {
  const pattern = `%${query}%`;

  // Track matches — song-level
  const trackSQL = `
    SELECT track_name as name, artist_name as artist, COUNT(*) as plays
    FROM plays
    WHERE track_name LIKE ? COLLATE NOCASE
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    ORDER BY plays DESC
    LIMIT ?
  `;
  const tracks = await db.prepare(trackSQL).bind(pattern, limit)
    .all<{ name: string; artist: string; plays: number }>();

  // Artist matches
  const artistSQL = `
    SELECT artist_name as name, COUNT(*) as plays
    FROM plays
    WHERE artist_name LIKE ? COLLATE NOCASE
    GROUP BY artist_name COLLATE NOCASE
    ORDER BY plays DESC
    LIMIT ?
  `;
  const artists = await db.prepare(artistSQL).bind(pattern, limit)
    .all<{ name: string; plays: number }>();

  // Merge and rank by plays, interleave types
  const results: SearchResult[] = [
    ...tracks.results.map((t) => ({ type: "track" as const, name: t.name, artist: t.artist, plays: t.plays })),
    ...artists.results.map((a) => ({ type: "artist" as const, name: a.name, plays: a.plays })),
  ];
  results.sort((a, b) => b.plays - a.plays);
  return results.slice(0, limit);
}

// ── Track Detail ────────────────────────────────────────────

export interface TrackDetail {
  track: string;
  artist: string;
  canonicalUri: string;
  totalPlays: number;
  totalMinutes: number;
  firstPlayed: string;
  lastPlayed: string;
  peakMonth: string;
  peakPlays: number;
  skipRate: number;
  completionRate: number;
  avgSkipRate: number;
  avgCompletionRate: number;
  era: string | null;
  monthlyPlays: { month: string; plays: number }[];
}

export async function getTrackDetail(
  db: D1Database,
  trackName: string,
  artistName: string,
): Promise<TrackDetail | null> {
  // Stats — song-level
  const statsSQL = `
    SELECT COUNT(*) as total_plays,
           SUM(minutes) as total_minutes,
           MIN(ts) as first_ts,
           MAX(ts) as last_ts,
           SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) as skips,
           SUM(CASE WHEN reason_end = 'trackdone' THEN 1 ELSE 0 END) as completions,
           MIN(year) as first_year
    FROM plays
    WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
  `;
  const stats = await db.prepare(statsSQL).bind(trackName, artistName)
    .first<{
      total_plays: number; total_minutes: number; first_ts: number; last_ts: number;
      skips: number; completions: number; first_year: number;
    }>();

  if (!stats || stats.total_plays === 0) return null;

  // Canonical URI (most lifetime plays)
  const canonSQL = `
    SELECT spotify_track_uri, COUNT(*) as plays
    FROM plays WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
    GROUP BY spotify_track_uri ORDER BY plays DESC LIMIT 1
  `;
  const canon = await db.prepare(canonSQL).bind(trackName, artistName)
    .first<{ spotify_track_uri: string }>();

  // Peak month
  const peakSQL = `
    SELECT year, month, COUNT(*) as plays
    FROM plays WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
    GROUP BY year, month ORDER BY plays DESC LIMIT 1
  `;
  const peak = await db.prepare(peakSQL).bind(trackName, artistName)
    .first<{ year: number; month: number; plays: number }>();

  // Monthly play counts for sparkline
  const monthlySQL = `
    SELECT year, month, COUNT(*) as plays
    FROM plays WHERE track_name = ? COLLATE NOCASE AND artist_name = ? COLLATE NOCASE
    GROUP BY year, month ORDER BY year, month
  `;
  const monthly = await db.prepare(monthlySQL).bind(trackName, artistName)
    .all<{ year: number; month: number; plays: number }>();

  // Dataset-wide averages for reference
  const avgSQL = `
    SELECT
      CAST(SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as avg_skip,
      CAST(SUM(CASE WHEN reason_end = 'trackdone' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as avg_completion
    FROM plays
  `;
  const avg = await db.prepare(avgSQL).first<{ avg_skip: number; avg_completion: number }>();

  // Era
  const era = erasData.find((e) => e.years.includes(stats.first_year));

  return {
    track: trackName,
    artist: artistName,
    canonicalUri: canon?.spotify_track_uri ?? "",
    totalPlays: stats.total_plays,
    totalMinutes: Math.round(stats.total_minutes * 10) / 10,
    firstPlayed: new Date(stats.first_ts * 1000).toISOString().split("T")[0],
    lastPlayed: new Date(stats.last_ts * 1000).toISOString().split("T")[0],
    peakMonth: peak ? `${peak.year}-${String(peak.month).padStart(2, "0")}` : "unknown",
    peakPlays: peak?.plays ?? 0,
    skipRate: Math.round((stats.skips / stats.total_plays) * 1000) / 10,
    completionRate: Math.round((stats.completions / stats.total_plays) * 1000) / 10,
    avgSkipRate: Math.round((avg?.avg_skip ?? 0) * 1000) / 10,
    avgCompletionRate: Math.round((avg?.avg_completion ?? 0) * 1000) / 10,
    era: era?.name ?? null,
    monthlyPlays: monthly.results.map((m) => ({
      month: `${m.year}-${String(m.month).padStart(2, "0")}`,
      plays: m.plays,
    })),
  };
}

// ── Artist Detail ───────────────────────────────────────────

export interface ArtistDetail {
  artist: string;
  totalPlays: number;
  totalHours: number;
  distinctTracks: number;
  distinctAlbums: number;
  firstPlayed: string;
  lastPlayed: string;
  yearsInTop50: number;
  isNeverStaleCore: boolean;
  yearlyPlays: { year: number; plays: number }[];
  topTracks: { track: string; plays: number; lastPlayed: string }[];
  companions: { artist: string; count: number }[];
}

export async function getArtistDetail(
  db: D1Database,
  artistName: string,
): Promise<ArtistDetail | null> {
  const statsSQL = `
    SELECT COUNT(*) as total_plays,
           SUM(minutes) as total_minutes,
           MIN(ts) as first_ts,
           MAX(ts) as last_ts
    FROM plays
    WHERE artist_name = ? COLLATE NOCASE
  `;
  const stats = await db.prepare(statsSQL).bind(artistName)
    .first<{ total_plays: number; total_minutes: number; first_ts: number; last_ts: number }>();

  if (!stats || stats.total_plays === 0) return null;

  // Distinct tracks and albums — song-level
  const distinctSQL = `
    SELECT
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM plays WHERE artist_name = ? COLLATE NOCASE
        GROUP BY track_name COLLATE NOCASE
      )) as distinct_tracks,
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM plays WHERE artist_name = ? COLLATE NOCASE
        GROUP BY album_name COLLATE NOCASE
      )) as distinct_albums
  `;
  const distinct = await db.prepare(distinctSQL).bind(artistName, artistName)
    .first<{ distinct_tracks: number; distinct_albums: number }>();

  // Yearly play counts
  const yearlySQL = `
    SELECT year, COUNT(*) as plays
    FROM plays WHERE artist_name = ? COLLATE NOCASE
    GROUP BY year ORDER BY year
  `;
  const yearly = await db.prepare(yearlySQL).bind(artistName)
    .all<{ year: number; plays: number }>();

  // Top 10 tracks — song-level
  const topTracksSQL = `
    SELECT track_name, COUNT(*) as plays, MAX(ts) as last_ts
    FROM plays WHERE artist_name = ? COLLATE NOCASE
    GROUP BY track_name COLLATE NOCASE
    ORDER BY plays DESC LIMIT 10
  `;
  const topTracks = await db.prepare(topTracksSQL).bind(artistName)
    .all<{ track_name: string; plays: number; last_ts: number }>();

  // Companions from embedded JSON. The static companions.json type widens
  // to (string|number)[][] under the JSON resolver; cast through unknown
  // to match the structural shape we know it has.
  const companionMap = companionsData as unknown as Record<string, [string, number][]>;
  const companions: { artist: string; count: number }[] = [];
  // Check case-insensitive
  for (const [key, value] of Object.entries(companionMap)) {
    if (key.toLowerCase() === artistName.toLowerCase()) {
      for (const [name, count] of value) {
        companions.push({ artist: name, count });
      }
      break;
    }
  }

  // Never-stale core check
  const isCore = NEVER_STALE_SET.has(artistName) ||
    [...NEVER_STALE_SET].some((a) => a.toLowerCase() === artistName.toLowerCase());
  const yearsInTop50 = NEVER_STALE_MAP.get(artistName) ??
    [...NEVER_STALE_MAP.entries()].find(([a]) => a.toLowerCase() === artistName.toLowerCase())?.[1] ?? 0;

  return {
    artist: artistName,
    totalPlays: stats.total_plays,
    totalHours: Math.round((stats.total_minutes / 60) * 10) / 10,
    distinctTracks: distinct?.distinct_tracks ?? 0,
    distinctAlbums: distinct?.distinct_albums ?? 0,
    firstPlayed: new Date(stats.first_ts * 1000).toISOString().split("T")[0],
    lastPlayed: new Date(stats.last_ts * 1000).toISOString().split("T")[0],
    yearsInTop50,
    isNeverStaleCore: isCore,
    yearlyPlays: yearly.results,
    topTracks: topTracks.results.map((t) => ({
      track: t.track_name,
      plays: t.plays,
      lastPlayed: new Date(t.last_ts * 1000).toISOString().split("T")[0],
    })),
    companions,
  };
}

// ── Pulse ───────────────────────────────────────────────────

export interface PulseData {
  lifetime: { plays: number; hours: number; tracks: number; artists: number };
  week: { topTracks: { track: string; artist: string; plays: number; skipRate: number }[] };
  month: { topArtists: { artist: string; hours: number; delta: number }[] };
  rising: { artist: string; plays: number; delta: number }[];
  falling: { artist: string; plays: number; delta: number }[];
  newEntries: { track: string; artist: string; plays: number }[];
  skipRate: { thisWeek: number; lastWeek: number };
  lostFavorites: LostFavorite[];
}

export async function getPulseData(db: D1Database): Promise<PulseData> {
  const now = Math.floor(Date.now() / 1000);
  const weekAgo = now - 7 * 86400;
  const twoWeeksAgo = now - 14 * 86400;
  const monthAgo = now - 30 * 86400;
  const twoMonthsAgo = now - 60 * 86400;

  // Lifetime totals — fast version: skip COLLATE NOCASE for counts
  // (COUNT DISTINCT on raw values is close enough for display)
  const lifetimeSQL = `
    SELECT COUNT(*) as plays, ROUND(SUM(minutes) / 60.0, 1) as hours,
           COUNT(DISTINCT spotify_track_uri) as tracks,
           COUNT(DISTINCT artist_name) as artists
    FROM plays
  `;
  const lifetime = await db.prepare(lifetimeSQL)
    .first<{ plays: number; hours: number; tracks: number; artists: number }>();

  // This week top 5 tracks — limited to recent rows, fast
  const weekTracksSQL = `
    SELECT track_name, artist_name, COUNT(*) as plays,
           CAST(SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as skip_rate
    FROM plays WHERE ts >= ?
    GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    ORDER BY plays DESC LIMIT 5
  `;
  const weekTracks = await db.prepare(weekTracksSQL).bind(weekAgo)
    .all<{ track_name: string; artist_name: string; plays: number; skip_rate: number }>();

  // This month top artists + rising/falling — single scan of 30-day + prior 30-day data
  const monthArtistsSQL = `
    SELECT artist_name, SUM(minutes) as mins
    FROM plays WHERE ts >= ?
    GROUP BY artist_name COLLATE NOCASE
    ORDER BY mins DESC LIMIT 10
  `;
  const currentMonth = await db.prepare(monthArtistsSQL).bind(monthAgo)
    .all<{ artist_name: string; mins: number }>();

  const priorMonthSQL = `
    SELECT artist_name, SUM(minutes) as mins, COUNT(*) as plays
    FROM plays WHERE ts >= ? AND ts < ?
    GROUP BY artist_name COLLATE NOCASE
  `;
  const priorMonth = await db.prepare(priorMonthSQL).bind(twoMonthsAgo, monthAgo)
    .all<{ artist_name: string; mins: number; plays: number }>();

  const priorMap = new Map(priorMonth.results.map((a) => [a.artist_name.toLowerCase(), a]));
  const monthArtists = currentMonth.results.slice(0, 5).map((a) => {
    const prior = priorMap.get(a.artist_name.toLowerCase());
    return {
      artist: a.artist_name,
      hours: Math.round((a.mins / 60) * 10) / 10,
      delta: Math.round(((a.mins - (prior?.mins ?? 0)) / 60) * 10) / 10,
    };
  });

  // Rising/falling from current 30-day plays
  const currentPlaysSQL = `
    SELECT artist_name, COUNT(*) as plays
    FROM plays WHERE ts >= ?
    GROUP BY artist_name COLLATE NOCASE
    ORDER BY plays DESC LIMIT 50
  `;
  const currentPlays = await db.prepare(currentPlaysSQL).bind(monthAgo)
    .all<{ artist_name: string; plays: number }>();

  const priorPlaysMap = new Map(priorMonth.results.map((a) => [a.artist_name.toLowerCase(), a.plays]));
  const deltas = currentPlays.results.map((a) => {
    const prior = priorPlaysMap.get(a.artist_name.toLowerCase()) ?? 0;
    return { artist: a.artist_name, plays: a.plays, delta: a.plays - prior };
  });
  const rising = deltas.filter((d) => d.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);
  const falling = deltas.filter((d) => d.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);

  // New entries this calendar month — fast: check year/month of MIN(ts)
  const nowDate = new Date(now * 1000);
  const currentYear = nowDate.getUTCFullYear();
  const currentMonthNum = nowDate.getUTCMonth() + 1;
  const newEntriesSQL = `
    SELECT track_name, artist_name, cnt as plays FROM (
      SELECT track_name, artist_name,
             COUNT(CASE WHEN year = ?1 AND month = ?2 THEN 1 END) as cnt,
             MIN(year * 100 + month) as first_ym
      FROM plays
      GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
      HAVING first_ym = ?1 * 100 + ?2 AND cnt > 0
    )
    ORDER BY plays DESC LIMIT 10
  `;
  const newEntries = await db.prepare(newEntriesSQL)
    .bind(currentYear, currentMonthNum)
    .all<{ track_name: string; artist_name: string; plays: number }>();

  // Skip rate: this week vs last week — two fast indexed queries
  const skipThisWeek = await db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) as skips FROM plays WHERE ts >= ?"
  ).bind(weekAgo).first<{ total: number; skips: number }>();
  const skipLastWeek = await db.prepare(
    "SELECT COUNT(*) as total, SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) as skips FROM plays WHERE ts >= ? AND ts < ?"
  ).bind(twoWeeksAgo, weekAgo).first<{ total: number; skips: number }>();

  const thisWeekRate = (skipThisWeek?.total ?? 0) > 0
    ? Math.round(((skipThisWeek?.skips ?? 0) / skipThisWeek!.total) * 1000) / 10 : 0;
  const lastWeekRate = (skipLastWeek?.total ?? 0) > 0
    ? Math.round(((skipLastWeek?.skips ?? 0) / skipLastWeek!.total) * 1000) / 10 : 0;

  // Lost favorites (top 5)
  const lostFavs = await getLostFavorites(db, 20, 2, 5);

  return {
    lifetime: {
      plays: lifetime?.plays ?? 0,
      hours: lifetime?.hours ?? 0,
      tracks: lifetime?.tracks ?? 0,
      artists: lifetime?.artists ?? 0,
    },
    week: {
      topTracks: weekTracks.results.map((t) => ({
        track: t.track_name,
        artist: t.artist_name,
        plays: t.plays,
        skipRate: Math.round(t.skip_rate * 100),
      })),
    },
    month: { topArtists: monthArtists },
    rising,
    falling,
    newEntries: newEntries.results.map((t) => ({
      track: t.track_name,
      artist: t.artist_name,
      plays: t.plays,
    })),
    skipRate: { thisWeek: thisWeekRate, lastWeek: lastWeekRate },
    lostFavorites: lostFavs,
  };
}

// ── Trends ──────────────────────────────────────────────────

export interface TrendsData {
  skipRateByQuarter: { quarter: string; rate: number }[];
  discoveryByYear: { year: number; newTracks: number }[];
  concentrationByYear: { year: number; top100Share: number }[];
  hourlyDistribution: { hour: number; plays: number }[];
}

export async function getTrendsData(db: D1Database): Promise<TrendsData> {
  // Skip rate by quarter
  const skipSQL = `
    SELECT year, ((month - 1) / 3 + 1) as q,
           CAST(SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) AS REAL) / COUNT(*) as rate
    FROM plays
    GROUP BY year, q
    ORDER BY year, q
  `;
  const skipRows = await db.prepare(skipSQL)
    .all<{ year: number; q: number; rate: number }>();

  // Discovery by year: tracks first played that year
  const discoverySQL = `
    SELECT first_year as year, COUNT(*) as new_tracks FROM (
      SELECT MIN(year) as first_year
      FROM plays
      GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
    )
    GROUP BY first_year ORDER BY first_year
  `;
  const discoveryRows = await db.prepare(discoverySQL)
    .all<{ year: number; new_tracks: number }>();

  // Top-100 concentration by year
  const concentrationSQL = `
    SELECT year, COUNT(*) as total_plays FROM plays GROUP BY year ORDER BY year
  `;
  const yearTotals = await db.prepare(concentrationSQL)
    .all<{ year: number; total_plays: number }>();

  const concentration: { year: number; top100Share: number }[] = [];
  for (const yt of yearTotals.results) {
    const top100SQL = `
      SELECT SUM(plays) as top100_plays FROM (
        SELECT COUNT(*) as plays
        FROM plays WHERE year = ?
        GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
        ORDER BY plays DESC LIMIT 100
      )
    `;
    const top100 = await db.prepare(top100SQL).bind(yt.year)
      .first<{ top100_plays: number }>();
    concentration.push({
      year: yt.year,
      top100Share: yt.total_plays > 0
        ? Math.round(((top100?.top100_plays ?? 0) / yt.total_plays) * 1000) / 10
        : 0,
    });
  }

  // Hourly distribution (local_hour)
  const hourlySQL = `
    SELECT local_hour as hour, COUNT(*) as plays
    FROM plays GROUP BY local_hour ORDER BY local_hour
  `;
  const hourlyRows = await db.prepare(hourlySQL)
    .all<{ hour: number; plays: number }>();

  return {
    skipRateByQuarter: skipRows.results.map((r) => ({
      quarter: `${r.year}-Q${r.q}`,
      rate: Math.round(r.rate * 1000) / 10,
    })),
    discoveryByYear: discoveryRows.results.map((r) => ({ year: r.year, newTracks: r.new_tracks })),
    concentrationByYear: concentration,
    hourlyDistribution: hourlyRows.results,
  };
}

// ── Hero rolling windows ────────────────────────────────────

export interface RollingWindow {
  plays: number;
  priorPlays: number;
  deltaPct: number;
}

export async function getRollingWindows(db: D1Database): Promise<{ week: RollingWindow; month: RollingWindow }> {
  const now = Math.floor(Date.now() / 1000);

  const windowSQL = `
    SELECT COUNT(*) as plays FROM plays WHERE ts >= ? AND ts < ?
  `;

  const weekCurrent = await db.prepare(windowSQL).bind(now - 7 * 86400, now).first<{ plays: number }>();
  const weekPrior = await db.prepare(windowSQL).bind(now - 14 * 86400, now - 7 * 86400).first<{ plays: number }>();
  const monthCurrent = await db.prepare(windowSQL).bind(now - 30 * 86400, now).first<{ plays: number }>();
  const monthPrior = await db.prepare(windowSQL).bind(now - 60 * 86400, now - 30 * 86400).first<{ plays: number }>();

  const pct = (curr: number, prior: number) =>
    prior > 0 ? Math.round(((curr - prior) / prior) * 100) : curr > 0 ? 100 : 0;

  return {
    week: {
      plays: weekCurrent?.plays ?? 0,
      priorPlays: weekPrior?.plays ?? 0,
      deltaPct: pct(weekCurrent?.plays ?? 0, weekPrior?.plays ?? 0),
    },
    month: {
      plays: monthCurrent?.plays ?? 0,
      priorPlays: monthPrior?.plays ?? 0,
      deltaPct: pct(monthCurrent?.plays ?? 0, monthPrior?.plays ?? 0),
    },
  };
}
