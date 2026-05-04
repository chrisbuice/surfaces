/**
 * pending.ts — Lazy-analysis trigger for the lyrics transparency layer.
 *
 * Idempotent: INSERT OR IGNORE ensures existing rows (any status) are untouched.
 * grimmauldplace cron picks up 'pending' rows every ~10 minutes.
 */

export async function ensureAnalysisPending(
  db: D1Database,
  uri: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT OR IGNORE INTO track_lyric_analysis_status
       (spotify_track_uri, status, last_attempted_at, attempts)
       VALUES (?, 'pending', ?, 0)`,
    )
    .bind(uri, now)
    .run();
}
