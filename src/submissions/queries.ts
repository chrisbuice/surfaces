/**
 * queries.ts — submissions table helpers.
 *
 * Visitor-track-recommendations layer. The /api/submit-track endpoint
 * calls insertSubmission() (insert-only); the nightly summary cron
 * calls listNewSubmissions() to render the digest, then markNotified()
 * to flip status from 'new' to 'notified'.
 */

export interface Submission {
  id: number;
  track_id: string;
  submitter_name: string | null;
  note: string | null;
  submitted_at: number;
  status: string;
}

export interface SubmissionInsert {
  track_id: string;
  submitter_name: string | null;
  note: string | null;
}

/**
 * Insert one submission. Caller has already validated and trimmed the
 * fields. Returns the inserted row id; throws if D1 rejects the write.
 */
export async function insertSubmission(
  db: D1Database,
  s: SubmissionInsert,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(
    `INSERT INTO submissions (track_id, submitter_name, note, submitted_at, status)
     VALUES (?, ?, ?, ?, 'new')`
  ).bind(s.track_id, s.submitter_name, s.note, now).run();
  return result.meta.last_row_id;
}

/** Pull every submission still in the 'new' state, oldest first. */
export async function listNewSubmissions(db: D1Database): Promise<Submission[]> {
  const r = await db.prepare(
    `SELECT id, track_id, submitter_name, note, submitted_at, status
     FROM submissions
     WHERE status = 'new'
     ORDER BY submitted_at ASC`
  ).all<Submission>();
  return r.results ?? [];
}

/** Flip the given ids from 'new' to 'notified'. No-op for empty input. */
export async function markNotified(db: D1Database, ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  // D1 binding lists are positional; build placeholders.
  const placeholders = ids.map(() => "?").join(",");
  await db.prepare(
    `UPDATE submissions SET status = 'notified' WHERE id IN (${placeholders}) AND status = 'new'`
  ).bind(...ids).run();
}

/**
 * Canonicalize a track id from the wire into "spotify:track:<id>". Accepts:
 *   - "spotify:track:abc123"  (already canonical)
 *   - "abc123"                (bare 22-char id)
 *   - "https://open.spotify.com/track/abc123?si=..."  (web URL)
 * Returns null for anything that doesn't match.
 */
export function canonicalizeTrackId(input: string): string | null {
  const s = input.trim();
  if (!s) return null;

  // Web URL: https://open.spotify.com/track/<id>?si=...
  const urlMatch = s.match(/open\.spotify\.com\/track\/([A-Za-z0-9]{22})/);
  if (urlMatch) return `spotify:track:${urlMatch[1]}`;

  // Already-canonical URI
  if (/^spotify:track:[A-Za-z0-9]{22}$/.test(s)) return s;

  // Bare 22-char id
  if (/^[A-Za-z0-9]{22}$/.test(s)) return `spotify:track:${s}`;

  return null;
}
