/**
 * seasonal.ts — detect and sync seasonal playlists.
 *
 * The user's seasonal playlists always contain a season name (spring, summer,
 * fall, winter) in the title. They sometimes include a year. When a year is
 * present in the name we use it as a hint; otherwise we infer the year/season
 * from when tracks were added to the playlist.
 */

import { SpotifyClient } from "../spotify/client";
import { getUserPlaylists, getPlaylistTracks } from "../spotify/library";

const SEASON_PATTERNS: Array<{ season: string; regex: RegExp; months: number[] }> = [
  { season: "winter", regex: /\bwinter\b/i, months: [12, 1, 2] },
  { season: "spring", regex: /\bspring\b/i, months: [3, 4, 5] },
  { season: "summer", regex: /\bsummer\b/i, months: [6, 7, 8] },
  { season: "fall",   regex: /\b(?:fall|autumn)\b/i, months: [9, 10, 11] },
];

const YEAR_REGEX = /\b(20\d{2})\b/;

interface SeasonalPlaylistInfo {
  spotifyPlaylistId: string;
  name: string;
  season: string;
  year: number;
}

/** Scan user's playlists and return ones that look seasonal */
export async function detectSeasonalPlaylists(spotify: SpotifyClient): Promise<SeasonalPlaylistInfo[]> {
  const playlists = await getUserPlaylists(spotify);
  const results: SeasonalPlaylistInfo[] = [];

  for (const pl of playlists) {
    // Check if the name contains a season
    const matchedSeason = SEASON_PATTERNS.find(sp => sp.regex.test(pl.name));
    if (!matchedSeason) continue;

    // Try to extract year from name
    const yearMatch = pl.name.match(YEAR_REGEX);
    let year: number;

    try {
      if (yearMatch) {
        year = parseInt(yearMatch[1], 10);
      } else {
        // Infer year from track add dates — fetch a sample of tracks
        year = await inferYearFromTracks(spotify, pl.id, matchedSeason.months);
      }
    } catch (err) {
      // Some playlists may be inaccessible (403) — skip them
      console.warn(`Skipping playlist "${pl.name}" (${pl.id}): ${err}`);
      continue;
    }

    results.push({
      spotifyPlaylistId: pl.id,
      name: pl.name,
      season: matchedSeason.season,
      year,
    });
  }

  return results;
}

/** Infer the year of a seasonal playlist from the median add date of its tracks */
async function inferYearFromTracks(
  spotify: SpotifyClient,
  playlistId: string,
  seasonMonths: number[]
): Promise<number> {
  const items = await getPlaylistTracks(spotify, playlistId, 100);
  if (items.length === 0) return new Date().getFullYear();

  // Get the median added_at date
  const dates = items
    .map(item => new Date(item.added_at))
    .filter(d => !isNaN(d.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());

  if (dates.length === 0) return new Date().getFullYear();

  const median = dates[Math.floor(dates.length / 2)];
  return median.getFullYear();
}

/** Determine the current season based on month */
export function getCurrentSeason(): string {
  const month = new Date().getMonth() + 1; // 1-12
  if (month >= 3 && month <= 5) return "spring";
  if (month >= 6 && month <= 8) return "summer";
  if (month >= 9 && month <= 11) return "fall";
  return "winter";
}

/** Sync detected seasonal playlists into D1 */
export async function syncSeasonalPlaylists(
  db: D1Database,
  spotify: SpotifyClient
): Promise<{ synced: number; total: number }> {
  const detected = await detectSeasonalPlaylists(spotify);
  const currentSeason = getCurrentSeason();
  const currentYear = new Date().getFullYear();
  const now = Math.floor(Date.now() / 1000);

  let synced = 0;
  for (const pl of detected) {
    const isCurrent = (pl.season === currentSeason && pl.year === currentYear) ? 1 : 0;

    await db.prepare(`
      INSERT INTO seasonal_playlists (spotify_playlist_id, name, season, year, is_current, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(spotify_playlist_id) DO UPDATE SET
        name = excluded.name,
        season = excluded.season,
        year = excluded.year,
        is_current = excluded.is_current,
        last_synced_at = excluded.last_synced_at
    `).bind(pl.spotifyPlaylistId, pl.name, pl.season, pl.year, isCurrent, now).run();
    synced++;
  }

  return { synced, total: detected.length };
}
