/**
 * seasonal.ts — detect and sync seasonal playlists.
 *
 * The user's seasonal playlists always contain a season name (spring, summer,
 * fall, winter) in the title — sometimes creatively (e.g. "springing",
 * "its fall yall", "brrr 2023", "wynter"). They sometimes include a year.
 * When a year isn't present, we infer the timeframe from track add dates.
 *
 * Only playlists owned by the user are considered.
 */

import { SpotifyClient } from "../spotify/client";
import { getUserPlaylists } from "../spotify/library";

// Patterns are checked in order; first match wins.
// Regexes use \b on the left but not the right, so "springing", "falling",
// "wintertime", "summmer" (typo) all match.
const SEASON_PATTERNS: Array<{ season: string; regex: RegExp; months: number[] }> = [
  // "wynter" is the user's name for a summer playlist — check it before winter
  { season: "summer", regex: /\bwynter\b/i, months: [6, 7, 8] },
  // "brrr" = winter
  { season: "winter", regex: /\bwinter/i, months: [12, 1, 2] },
  { season: "winter", regex: /\bbrrr/i, months: [12, 1, 2] },
  { season: "spring", regex: /\bspring/i, months: [3, 4, 5] },
  { season: "summer", regex: /\bsumm+er/i, months: [6, 7, 8] },
  { season: "fall",   regex: /\b(?:fall|autumn)/i, months: [9, 10, 11] },
];

// Playlists whose names match a season keyword but aren't seasonal music playlists
const EXCLUDE_PATTERNS = [
  /show ideas/i,
  /AGMC/i,
];

// Playlist IDs to exclude — playlists the user owns (or Spotify reports as owned)
// but that aren't part of their seasonal curation history.
const EXCLUDE_PLAYLIST_IDS = new Set([
  "4nZccC8qFIlEsU7385ZyAv", // "boom clap vibes tumblr summer 2014" — followed, not curated
]);

const YEAR_REGEX = /\b(20\d{2})\b/;
// Also match 2-digit year shorthand like "summer 25", "fall 24"
const SHORT_YEAR_REGEX = /\b(\d{2})\b/;

const USER_SPOTIFY_ID = "121776622";

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
    // Only consider playlists owned by the user
    if (pl.owner?.id !== USER_SPOTIFY_ID) continue;

    // Skip explicitly excluded playlist IDs
    if (EXCLUDE_PLAYLIST_IDS.has(pl.id)) continue;

    // Skip excluded patterns
    if (EXCLUDE_PATTERNS.some(re => re.test(pl.name))) continue;

    // Check if the name contains a season
    const matchedSeason = SEASON_PATTERNS.find(sp => sp.regex.test(pl.name));
    if (!matchedSeason) continue;

    // Try to extract year from name
    let year: number | null = null;

    // Full year: "2024", "2025"
    const fullYearMatch = pl.name.match(YEAR_REGEX);
    if (fullYearMatch) {
      year = parseInt(fullYearMatch[1], 10);
    }

    // Short year: "25", "24" — interpret as 20xx
    if (!year) {
      const shortYearMatch = pl.name.match(SHORT_YEAR_REGEX);
      if (shortYearMatch) {
        const twoDigit = parseInt(shortYearMatch[1], 10);
        // Only treat as year if it's plausible (14-30 range for 2014-2030)
        if (twoDigit >= 14 && twoDigit <= 30) {
          year = 2000 + twoDigit;
        }
      }
    }

    // If no year found in name, default to current year.
    // (Previously we inferred from track added_at dates, but Dev Mode blocks
    // the playlist-tracks API and the embed fallback doesn't include added_at.
    // All existing undated playlists are already synced with correct years from
    // earlier runs; new playlists without a year are most likely current.)
    if (!year) {
      year = new Date().getFullYear();
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

  // Remove any previously-synced playlists that are now excluded
  for (const excludedId of EXCLUDE_PLAYLIST_IDS) {
    await db.prepare("DELETE FROM seasonal_playlists WHERE spotify_playlist_id = ?").bind(excludedId).run();
  }

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
