/**
 * queries.ts — submissions table helpers.
 *
 * Visitor-track-recommendations layer. The /api/submit-track endpoint
 * calls insertSubmission() (insert-only); the nightly summary cron
 * calls listNewSubmissions() to render the digest, then markNotified()
 * to flip status from 'new' to 'notified'.
 *
 * The track_submissions table (migration 017) is a richer audit log
 * that captures Spotify playlist-add outcomes, track metadata, and
 * submitter details. Both tables are written per submission.
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

// ---------------------------------------------------------------------------
// track_submissions table (migration 017) — richer audit log
// ---------------------------------------------------------------------------

export interface TrackSubmissionInsert {
  track_id: string;
  track_name: string | null;
  artist_name: string | null;
  from_name: string | null;
  note: string | null;
  email: string | null;
  submitter_ip: string | null;
  user_agent: string | null;
  spotify_add_status: "ok" | "failed" | "skipped";
  spotify_error: string | null;
}

export async function insertTrackSubmission(
  db: D1Database,
  s: TrackSubmissionInsert,
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const result = await db.prepare(
    `INSERT INTO track_submissions
       (track_id, track_name, artist_name, from_name, note, email,
        submitter_ip, user_agent, spotify_add_status, spotify_error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    s.track_id, s.track_name, s.artist_name, s.from_name, s.note, s.email,
    s.submitter_ip, s.user_agent, s.spotify_add_status, s.spotify_error, now,
  ).run();
  return result.meta.last_row_id;
}

// ---------------------------------------------------------------------------
// Input validation — shared between endpoint and tests
// ---------------------------------------------------------------------------

const TRACK_ID_RE = /^[a-zA-Z0-9]{22}$/;
const EMAIL_RE = /.+@.+\..+/;

export interface ValidationError {
  error: "validation";
  field: string;
}

export interface ValidatedSubmitInput {
  track_id: string;
  from: string | null;
  note: string | null;
  email: string | null;
}

/**
 * Validate the raw JSON body for POST /api/submit-track.
 * Returns either a validated input or a validation error.
 */
export function validateSubmitInput(
  parsed: Record<string, unknown>,
): ValidatedSubmitInput | ValidationError {
  // track_id — required, must be bare 22-char Spotify base62 ID
  const rawTrackId = typeof parsed.track_id === "string" ? parsed.track_id.trim() : "";
  if (!TRACK_ID_RE.test(rawTrackId)) {
    return { error: "validation", field: "track_id" };
  }

  // from — optional, max 80 chars
  const rawFrom = typeof parsed.from === "string" ? parsed.from.trim() : "";
  if (rawFrom.length > 80) {
    return { error: "validation", field: "from" };
  }

  // note — optional, max 280 chars
  const rawNote = typeof parsed.note === "string" ? parsed.note.trim() : "";
  if (rawNote.length > 280) {
    return { error: "validation", field: "note" };
  }

  // email — optional, max 200 chars, must look like email if provided
  const rawEmail = typeof parsed.email === "string" ? parsed.email.trim() : "";
  if (rawEmail.length > 200) {
    return { error: "validation", field: "email" };
  }
  if (rawEmail && !EMAIL_RE.test(rawEmail)) {
    return { error: "validation", field: "email" };
  }

  return {
    track_id: rawTrackId,
    from: rawFrom || null,
    note: rawNote || null,
    email: rawEmail || null,
  };
}

/** Type guard: is the result a validation error? */
export function isValidationError(
  r: ValidatedSubmitInput | ValidationError,
): r is ValidationError {
  return "error" in r;
}
