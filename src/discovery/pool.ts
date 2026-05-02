/**
 * pool.ts — fresh pool management.
 *
 * Add candidates, expire stale entries, get top-N for curation.
 */

export interface FreshPoolEntry {
  id: number;
  track_id: string;
  track_name: string;
  artist_ids: string;
  primary_artist_id: string;
  source: string;
  source_detail: string | null;
  found_at: number;
  taste_score: number;
  status: string;
  status_changed_at: number | null;
  expires_at: number | null;
}

/** Add a candidate to the fresh pool (skip if already exists) */
export async function addToFreshPool(
  db: D1Database,
  entry: {
    trackId: string;
    trackName: string;
    artistIds: string[];
    primaryArtistId: string;
    source: string;
    sourceDetail?: string;
    tasteScore: number;
  }
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 21 * 24 * 3600; // 21 days

  try {
    await db.prepare(`
      INSERT INTO fresh_pool (track_id, track_name, artist_ids, primary_artist_id, source, source_detail, found_at, taste_score, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fresh', ?)
      ON CONFLICT(track_id) DO UPDATE SET
        taste_score = MAX(excluded.taste_score, fresh_pool.taste_score),
        source = CASE WHEN excluded.taste_score > fresh_pool.taste_score THEN excluded.source ELSE fresh_pool.source END,
        source_detail = CASE WHEN excluded.taste_score > fresh_pool.taste_score THEN excluded.source_detail ELSE fresh_pool.source_detail END,
        -- Re-discovered tracks go back to fresh unless the user explicitly
        -- liked or skipped them. "queued", "played", and "expired" are
        -- non-terminal — the track deserves another chance.
        status = CASE WHEN fresh_pool.status IN ('liked', 'skipped') THEN fresh_pool.status ELSE 'fresh' END,
        expires_at = CASE WHEN fresh_pool.status IN ('liked', 'skipped') THEN fresh_pool.expires_at ELSE excluded.expires_at END
    `).bind(
      entry.trackId, entry.trackName, JSON.stringify(entry.artistIds),
      entry.primaryArtistId, entry.source, entry.sourceDetail ?? null,
      now, entry.tasteScore, expiresAt
    ).run();
    return true;
  } catch {
    return false; // likely duplicate
  }
}

/** Get top-N fresh candidates for curation */
export async function getTopFresh(db: D1Database, limit = 50): Promise<FreshPoolEntry[]> {
  const result = await db.prepare(
    "SELECT * FROM fresh_pool WHERE status = 'fresh' ORDER BY taste_score DESC LIMIT ?"
  ).bind(limit).all<FreshPoolEntry>();
  return result.results;
}

/** Expire stale entries that are past their expires_at */
export async function expireStaleEntries(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(
    "UPDATE fresh_pool SET status = 'expired', status_changed_at = ? WHERE status = 'fresh' AND expires_at < ?"
  ).bind(now, now).run();
  return result.meta.changes ?? 0;
}

/** Mark a fresh pool entry based on actual listening outcome */
export async function markFreshUsed(
  db: D1Database,
  trackId: string,
  status: "played" | "liked" | "skipped"
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "UPDATE fresh_pool SET status = ?, status_changed_at = ? WHERE track_id = ?"
  ).bind(status, now, trackId).run();
}

/** Get fresh pool stats */
export async function getFreshPoolStats(db: D1Database): Promise<{
  fresh: number;
  queued: number;
  played: number;
  liked: number;
  skipped: number;
  expired: number;
}> {
  const result = await db.prepare(
    "SELECT status, COUNT(*) as count FROM fresh_pool GROUP BY status"
  ).all<{ status: string; count: number }>();

  const stats = { fresh: 0, queued: 0, played: 0, liked: 0, skipped: 0, expired: 0 };
  for (const row of result.results) {
    if (row.status in stats) {
      stats[row.status as keyof typeof stats] = row.count;
    }
  }
  return stats;
}
