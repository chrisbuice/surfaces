/**
 * backfill.ts — cron handler for batched audio feature fetching.
 *
 * Runs every 2 hours at :30 via cron. Picks tracks from track_taste
 * that don't yet have audio features, prioritized by taste_score DESC.
 * Fetches from ReccoBeats in a single batch request, then writes rows.
 *
 * Tracks ReccoBeats doesn't know about get a 'reccobeats:not_found' row
 * with NULL feature columns. These are rescanned after AUDIO_NOT_FOUND_RESCAN_DAYS.
 *
 * Subrequest budget: the batch fetch is a single HTTP request to ReccoBeats,
 * so the 50-subrequest Worker limit is not a concern here.
 */

import { ReccoBeatsProvider } from "./reccobeats";
import { AUDIO_BACKFILL_BATCH_SIZE, AUDIO_NOT_FOUND_RESCAN_DAYS } from "../config";

export interface BackfillResult {
  fetched: number;
  notFound: number;
  batchSize: number;
  remaining: number;
}

export async function runAudioBackfill(db: D1Database): Promise<BackfillResult> {
  const now = Math.floor(Date.now() / 1000);
  const rescanCutoff = now - AUDIO_NOT_FOUND_RESCAN_DAYS * 86400;

  // Pick tracks with no features row, OR not-found rows older than the rescan window.
  // Prioritize by taste_score DESC so the most-surfaced tracks get features first.
  const candidates = await db.prepare(`
    SELECT tt.track_id
    FROM track_taste tt
    LEFT JOIN track_audio_features af ON af.track_id = tt.track_id
    WHERE af.track_id IS NULL
       OR (af.source = 'reccobeats:not_found' AND af.fetched_at < ?)
    ORDER BY tt.taste_score DESC
    LIMIT ?
  `).bind(rescanCutoff, AUDIO_BACKFILL_BATCH_SIZE).all<{ track_id: string }>();

  const trackIds = candidates.results.map(r => r.track_id);
  if (trackIds.length === 0) {
    // Count remaining (should be 0)
    return { fetched: 0, notFound: 0, batchSize: 0, remaining: 0 };
  }

  // Single batch fetch from ReccoBeats
  const provider = new ReccoBeatsProvider();
  const features = await provider.fetchBatch(trackIds);

  let fetched = 0;
  let notFound = 0;
  const batch: D1PreparedStatement[] = [];

  for (const trackId of trackIds) {
    const af = features.get(trackId);
    if (af) {
      batch.push(
        db.prepare(`
          INSERT INTO track_audio_features
            (track_id, acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence, source, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(track_id) DO UPDATE SET
            acousticness = excluded.acousticness, danceability = excluded.danceability,
            energy = excluded.energy, instrumentalness = excluded.instrumentalness,
            liveness = excluded.liveness, loudness = excluded.loudness,
            speechiness = excluded.speechiness, tempo = excluded.tempo,
            valence = excluded.valence, source = excluded.source,
            fetched_at = excluded.fetched_at
        `).bind(
          trackId, af.acousticness, af.danceability, af.energy,
          af.instrumentalness, af.liveness, af.loudness,
          af.speechiness, af.tempo, af.valence, "reccobeats", now
        )
      );
      fetched++;
    } else {
      // Not found — store marker with NULL features
      batch.push(
        db.prepare(`
          INSERT INTO track_audio_features
            (track_id, acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence, source, fetched_at)
          VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
          ON CONFLICT(track_id) DO UPDATE SET
            source = excluded.source, fetched_at = excluded.fetched_at
        `).bind(trackId, "reccobeats:not_found", now)
      );
      notFound++;
    }
  }

  // Write in D1 batch chunks (limit 100 per batch)
  for (let i = 0; i < batch.length; i += 100) {
    await db.batch(batch.slice(i, i + 100));
  }

  // Count remaining
  const remainingCount = await db.prepare(`
    SELECT COUNT(*) as cnt
    FROM track_taste tt
    LEFT JOIN track_audio_features af ON af.track_id = tt.track_id
    WHERE af.track_id IS NULL
       OR (af.source = 'reccobeats:not_found' AND af.fetched_at < ?)
  `).bind(rescanCutoff).first<{ cnt: number }>();

  return {
    fetched,
    notFound,
    batchSize: trackIds.length,
    remaining: remainingCount?.cnt ?? 0,
  };
}
