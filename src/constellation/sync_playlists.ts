/**
 * sync_playlists.ts — populate the playlist_tracks table.
 *
 * Walks every playlist owned by the user, scrapes track membership via
 * the embed page (Dev Mode blocks the playlist-tracks API), and persists
 * (playlist_id, track_id, track_name, primary_artist_name, position) rows.
 *
 * Followed-but-not-owned playlists are skipped — the spec's "playlist
 * co-occurrence" signal is meant to capture *Chris's* curatorial choices
 * (spec §5.3), not editorial playlists he merely listens to.
 *
 * Re-runs are safe: each playlist's rows are deleted before reinsert, so
 * the table reflects the current contents on Spotify rather than a
 * cumulative history.
 */

import { SpotifyClient } from "../spotify/client";
import { getUserPlaylists } from "../spotify/library";
import { getPlaylistTracksViaEmbed } from "../spotify/embed";

// Hardcoded user id used elsewhere in the codebase (taste/seasonal.ts).
// Pulled from getUserPlaylists().owner.id check; here so non-owned
// playlists get filtered out without an extra round-trip.
const USER_SPOTIFY_ID = "121776622";

export interface SyncPlaylistsResult {
  total_owned: number;
  scraped: number;
  failed: number;
  total_tracks: number;
}

export async function syncOwnedPlaylistsForConstellation(
  db: D1Database,
  spotify: SpotifyClient,
): Promise<SyncPlaylistsResult> {
  const playlists = await getUserPlaylists(spotify, 500);
  const owned = playlists.filter(p => p.owner?.id === USER_SPOTIFY_ID);

  const now = Math.floor(Date.now() / 1000);
  let scraped = 0;
  let failed = 0;
  let total_tracks = 0;

  for (const pl of owned) {
    try {
      const { tracks } = await getPlaylistTracksViaEmbed(pl.id, 500);
      // Replace existing rows for this playlist atomically-ish: D1 does
      // not expose transactions across statements but the renderer does
      // not read this table mid-update, so a delete+insert is fine.
      await db.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?")
        .bind(pl.id).run();

      // Batch inserts via prepare/bind. D1 handles this fine even at
      // 100s of rows; Spotify caps at 500 tracks per playlist anyway.
      const stmts = tracks.map((t, idx) =>
        db.prepare(
          `INSERT INTO playlist_tracks
             (playlist_id, track_id, track_name, artist_name, position, synced_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(pl.id, t.trackId, t.trackName, t.artistNames[0] ?? "", idx, now)
      );
      if (stmts.length > 0) {
        await db.batch(stmts);
      }
      scraped++;
      total_tracks += tracks.length;
    } catch (err) {
      failed++;
      console.warn(`constellation: failed to scrape playlist ${pl.id} (${pl.name}): ${err}`);
    }
  }

  return {
    total_owned: owned.length,
    scraped,
    failed,
    total_tracks,
  };
}
