/**
 * fresh_pool_sync.ts — promote 'notified' submissions into fresh_pool.
 *
 * The /api/submit-track endpoint deliberately stays lightweight: it
 * inserts into the submissions table and returns. The daily summary
 * cron at midnight UTC marks rows 'notified'. This step — running in
 * the 1 AM ET taste-rebuild cron the next morning — picks up those
 * notified rows, fetches track metadata from Spotify, and inserts
 * into fresh_pool so the next discovery/curation pass sees them.
 *
 * Submitted tracks are seeded with a fixed taste_score that places
 * them above default discoveries but below the user's curated favorites.
 * The intent: a friend-recommended track gets a real chance at being
 * surfaced in a session, but doesn't bulldoze the existing model.
 *
 * Status transitions:
 *   new → notified         (by daily summary cron after digest is sent)
 *   notified → added_to_pool  (by this function on successful fresh_pool insert)
 *   notified → rejected    (by this function when the track is unfetchable)
 */

import { SpotifyClient } from "../spotify/client";
import { addToFreshPool } from "../discovery/pool";

const SUBMISSION_TASTE_SCORE = 0.7;
const SUBMISSION_SOURCE = "submission";

interface NotifiedSubmission {
  id: number;
  track_id: string;
  submitter_name: string | null;
}

interface SpotifyTrackForPool {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
}

export interface SyncResult {
  candidates: number;        // notified rows considered
  added: number;             // inserted into fresh_pool
  already_present: number;   // addToFreshPool returned false (dedup)
  rejected: number;          // unfetchable, marked 'rejected'
}

export async function syncSubmissionsToFreshPool(
  db: D1Database,
  spotify: SpotifyClient,
): Promise<SyncResult> {
  const candidates = await listNotifiedSubmissions(db);
  const result: SyncResult = {
    candidates: candidates.length,
    added: 0,
    already_present: 0,
    rejected: 0,
  };

  for (const row of candidates) {
    const bareId = row.track_id.replace(/^spotify:track:/, "");
    let track: SpotifyTrackForPool;
    try {
      track = await spotify.get<SpotifyTrackForPool>(`/v1/tracks/${bareId}`);
    } catch (err) {
      console.warn(`submissions: track ${row.track_id} unfetchable, marking rejected: ${err}`);
      await markStatus(db, row.id, "rejected");
      result.rejected++;
      continue;
    }

    const artistIds = track.artists.map(a => a.id);
    const primaryArtist = artistIds[0];
    if (!primaryArtist) {
      console.warn(`submissions: track ${row.track_id} has no artist, marking rejected`);
      await markStatus(db, row.id, "rejected");
      result.rejected++;
      continue;
    }

    const sourceDetail = row.submitter_name
      ? `from ${row.submitter_name}`
      : "anonymous submission";

    const wasInserted = await addToFreshPool(db, {
      trackId: track.id,
      trackName: track.name,
      artistIds,
      primaryArtistId: primaryArtist,
      source: SUBMISSION_SOURCE,
      sourceDetail,
      tasteScore: SUBMISSION_TASTE_SCORE,
    });

    if (wasInserted) result.added++;
    else result.already_present++;

    // Either way, the submission has been processed — flip its status
    // so we don't try again tomorrow.
    await markStatus(db, row.id, "added_to_pool");
  }

  return result;
}

async function listNotifiedSubmissions(db: D1Database): Promise<NotifiedSubmission[]> {
  const r = await db.prepare(
    `SELECT id, track_id, submitter_name
     FROM submissions
     WHERE status = 'notified'
     ORDER BY submitted_at ASC
     LIMIT 50`
  ).all<NotifiedSubmission>();
  return r.results ?? [];
}

async function markStatus(db: D1Database, id: number, status: string): Promise<void> {
  await db.prepare(
    `UPDATE submissions SET status = ? WHERE id = ?`
  ).bind(status, id).run();
}
