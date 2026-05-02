/**
 * sync.ts — Daily sync of recent plays from Spotify's recently-played endpoint.
 *
 * Pulls last 50 plays, normalizes, dedupes by (ts, spotify_track_uri),
 * and inserts into the `plays` table. If exactly 50 plays are returned,
 * sets a KV flag for follow-up sync.
 */

import { SpotifyClient } from "../spotify/client";
import { normalizePlatform } from "./helpers";

interface RecentlyPlayedItem {
  track: {
    id: string;
    name: string;
    uri: string;
    duration_ms: number;
    album: { name: string };
    artists: Array<{ name: string }>;
  };
  played_at: string; // ISO 8601
}

interface RecentlyPlayedResponse {
  items: RecentlyPlayedItem[];
}

export async function syncRecentPlays(
  db: D1Database,
  spotify: SpotifyClient,
  kv?: KVNamespace,
): Promise<{ inserted: number; duplicates: number; needsFollowup: boolean }> {
  // Fetch recently played from Spotify
  const response = await spotify.get<RecentlyPlayedResponse>(
    "/v1/me/player/recently-played",
    { limit: "50" },
  );

  if (!response?.items?.length) {
    return { inserted: 0, duplicates: 0, needsFollowup: false };
  }

  const items = response.items;
  let inserted = 0;
  let duplicates = 0;

  for (const item of items) {
    const playedAt = new Date(item.played_at);
    const ts = Math.floor(playedAt.getTime() / 1000);
    const uri = item.track.uri;

    // Dedupe: check if this play already exists
    const existing = await db.prepare(
      "SELECT 1 FROM plays WHERE ts = ? AND spotify_track_uri = ?",
    ).bind(ts, uri).first();

    if (existing) {
      duplicates++;
      continue;
    }

    const utcHour = playedAt.getUTCHours();
    const localHour = (utcHour - 5 + 24) % 24; // US Eastern (UTC-5)
    const minutes = item.track.duration_ms / 60000;
    const year = playedAt.getUTCFullYear();
    const month = playedAt.getUTCMonth() + 1;

    // We don't have platform info from recently-played — default to "iOS"
    // (most plays are iOS; the live tracker will overwrite with real device info)
    const platform = "iOS";

    await db.prepare(`
      INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name,
        album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline,
        year, month, hour, local_hour, minutes)
      VALUES (?, ?, ?, 'US', ?, ?, ?, ?, '', 'trackdone', 0, 0, ?, ?, ?, ?, ?)
    `).bind(
      ts, platform, item.track.duration_ms,
      item.track.name,
      item.track.artists.map((a) => a.name).join(", "),
      item.track.album.name,
      uri,
      year, month, utcHour, localHour, minutes,
    ).run();

    inserted++;
  }

  const needsFollowup = items.length === 50;

  // Set KV flag if we need a follow-up sync
  if (needsFollowup && kv) {
    await kv.put("sync:needs_followup", "1", { expirationTtl: 3600 });
  }

  return { inserted, duplicates, needsFollowup };
}
