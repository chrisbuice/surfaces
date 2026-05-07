/**
 * apple-match-queries.ts — Query helpers for the Apple Music match review UI.
 *
 * Backs the /api/listening/apple-matches/* endpoints.
 */

// ── Types ──

export interface AppleMatchItem {
  cache_key: string;
  apple_track_id: string | null;
  match_status: string;
  match_confidence: number | null;
  match_method: string | null;
  match_attempts: number;
  reviewed_by_human: number;
  // Original Apple metadata
  original_song_name: string;
  original_artist_name: string | null;
  original_album_name: string | null;
  // iTunes Lookup metadata
  itunes_artist_name: string | null;
  itunes_track_name: string | null;
  itunes_album_name: string | null;
  itunes_duration_ms: number | null;
  itunes_release_date: string | null;
  itunes_genre: string | null;
  // MusicBrainz
  musicbrainz_isrc: string | null;
  // Current Spotify match
  spotify_track_uri: string | null;
  spotify_track_name: string | null;
  spotify_artist_name: string | null;
  spotify_album_name: string | null;
  spotify_duration_ms: number | null;
  // Derived
  play_count_in_history: number;
}

export interface AppleMatchListResult {
  items: AppleMatchItem[];
  total: number;
  hasMore: boolean;
}

// ── Queries ──

/**
 * List apple_track_matches by status, with play count from the plays table.
 */
export async function listAppleMatches(
  db: D1Database,
  status: string = "review",
  limit: number = 10,
  offset: number = 0,
): Promise<AppleMatchListResult> {
  const clampedLimit = Math.min(Math.max(limit, 1), 50);

  // Get total count for this status
  const countResult = await db
    .prepare("SELECT COUNT(*) as total FROM apple_track_matches WHERE match_status = ?")
    .bind(status)
    .first<{ total: number }>();
  const total = countResult?.total ?? 0;

  // Get items with play count
  const rows = await db
    .prepare(`
      SELECT
        atm.*,
        COALESCE(pc.play_count, 0) as play_count_in_history
      FROM apple_track_matches atm
      LEFT JOIN (
        SELECT
          CASE
            WHEN apple_track_id IS NOT NULL THEN 'apple:' || apple_track_id
            ELSE apple_track_id
          END as lookup_key,
          COUNT(*) as play_count
        FROM plays
        WHERE source = 'apple'
        GROUP BY lookup_key
      ) pc ON pc.lookup_key = atm.cache_key
      WHERE atm.match_status = ?
      ORDER BY atm.last_match_attempt_at ASC
      LIMIT ? OFFSET ?
    `)
    .bind(status, clampedLimit, offset)
    .all<AppleMatchItem>();

  return {
    items: rows.results,
    total,
    hasMore: offset + clampedLimit < total,
  };
}

/**
 * Count apple_track_matches by status.
 */
export async function countAppleMatches(
  db: D1Database,
  status: string,
): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM apple_track_matches WHERE match_status = ?")
    .bind(status)
    .first<{ count: number }>();
  return result?.count ?? 0;
}

/**
 * Get a single apple_track_match by cache_key.
 */
export async function getAppleMatch(
  db: D1Database,
  cacheKey: string,
): Promise<AppleMatchItem | null> {
  const row = await db
    .prepare("SELECT * FROM apple_track_matches WHERE cache_key = ?")
    .bind(cacheKey)
    .first<AppleMatchItem>();
  return row ?? null;
}

/**
 * Update a match: set the chosen Spotify track and backfill affected plays.
 */
export async function confirmMatch(
  db: D1Database,
  cacheKey: string,
  spotifyTrackUri: string,
  spotifyTrackName: string,
  spotifyArtistName: string,
  spotifyAlbumName: string,
  spotifyDurationMs: number,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // Update the match cache
  await db
    .prepare(`
      UPDATE apple_track_matches
      SET spotify_track_uri = ?,
          spotify_track_name = ?,
          spotify_artist_name = ?,
          spotify_album_name = ?,
          spotify_duration_ms = ?,
          match_status = 'manual',
          match_method = 'manual',
          match_confidence = 1.0,
          reviewed_by_human = 1,
          last_match_attempt_at = ?
      WHERE cache_key = ?
    `)
    .bind(
      spotifyTrackUri, spotifyTrackName, spotifyArtistName,
      spotifyAlbumName, spotifyDurationMs, now, cacheKey,
    )
    .run();

  // Backfill affected plays rows
  const match = await getAppleMatch(db, cacheKey);
  if (!match) return;

  if (match.apple_track_id) {
    await db
      .prepare(`
        UPDATE plays
        SET track_name = ?,
            artist_name = ?,
            album_name = ?,
            spotify_track_uri = ?,
            match_confidence = 1.0,
            match_status = 'manual'
        WHERE source = 'apple' AND apple_track_id = ?
      `)
      .bind(
        spotifyTrackName, spotifyArtistName, spotifyAlbumName,
        spotifyTrackUri, match.apple_track_id,
      )
      .run();
  }
}

/**
 * Skip a match (defer for later).
 */
export async function skipMatch(
  db: D1Database,
  cacheKey: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(`
      UPDATE apple_track_matches
      SET match_attempts = match_attempts + 1,
          last_match_attempt_at = ?
      WHERE cache_key = ?
    `)
    .bind(now, cacheKey)
    .run();
}

/**
 * Mark a match as permanently unmatchable.
 */
export async function markUnmatchable(
  db: D1Database,
  cacheKey: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(`
      UPDATE apple_track_matches
      SET match_status = 'permanently_unmatched',
          reviewed_by_human = 1,
          last_match_attempt_at = ?
      WHERE cache_key = ?
    `)
    .bind(now, cacheKey)
    .run();
}
