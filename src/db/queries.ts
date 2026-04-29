/**
 * queries.ts — typed database helpers.
 * All raw SQL lives here; business logic imports these functions.
 */

export interface PollObservation {
  id?: number;
  observed_at: number;
  is_playing: number;
  track_id: string | null;
  track_name: string | null;
  artist_ids: string | null;
  artist_name: string | null;
  album_id: string | null;
  progress_ms: number | null;
  duration_ms: number | null;
  device_type: string | null;
  context_uri: string | null;
  context_type: string | null;
}

export interface PlayEvent {
  id?: number;
  track_id: string;
  started_at: number;
  ended_at: number;
  duration_listened_ms: number;
  track_duration_ms: number | null;
  classification: "completed" | "skipped" | "partial" | "replayed";
  context_uri: string | null;
  context_type: string | null;
  device_type: string | null;
  hour_of_day: number | null;
  day_of_week: number | null;
  session_id: string | null;
}

export async function insertPollObservation(db: D1Database, obs: Omit<PollObservation, "id">): Promise<void> {
  await db.prepare(`
    INSERT INTO poll_observations
      (observed_at, is_playing, track_id, track_name, artist_ids, artist_name, album_id, progress_ms, duration_ms, device_type, context_uri, context_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    obs.observed_at, obs.is_playing, obs.track_id, obs.track_name, obs.artist_ids,
    obs.artist_name, obs.album_id, obs.progress_ms, obs.duration_ms, obs.device_type, obs.context_uri, obs.context_type
  ).run();
}

export async function insertPlayEvent(db: D1Database, ev: Omit<PlayEvent, "id">): Promise<number> {
  const result = await db.prepare(`
    INSERT INTO play_events
      (track_id, started_at, ended_at, duration_listened_ms, track_duration_ms, classification, context_uri, context_type, device_type, hour_of_day, day_of_week, session_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    ev.track_id, ev.started_at, ev.ended_at, ev.duration_listened_ms, ev.track_duration_ms,
    ev.classification, ev.context_uri, ev.context_type, ev.device_type, ev.hour_of_day, ev.day_of_week, ev.session_id
  ).run();
  return result.meta.last_row_id as number;
}

export async function getRecentPollObservations(db: D1Database, limit: number = 50): Promise<PollObservation[]> {
  const result = await db.prepare(
    "SELECT * FROM poll_observations ORDER BY observed_at DESC LIMIT ?"
  ).bind(limit).all<PollObservation>();
  return result.results;
}

export async function getRecentPlayEvents(db: D1Database, limit: number = 50): Promise<PlayEvent[]> {
  const result = await db.prepare(
    "SELECT * FROM play_events ORDER BY started_at DESC LIMIT ?"
  ).bind(limit).all<PlayEvent>();
  return result.results;
}

/** Get unprocessed poll observations (those after the last derived play event) */
export async function getUnderivedObservations(db: D1Database): Promise<PollObservation[]> {
  // Find the latest play_event ended_at as our watermark
  const lastEvent = await db.prepare(
    "SELECT MAX(ended_at) as max_ended FROM play_events"
  ).first<{ max_ended: number | null }>();

  const watermark = lastEvent?.max_ended ?? 0;

  const result = await db.prepare(
    "SELECT * FROM poll_observations WHERE observed_at > ? ORDER BY observed_at ASC"
  ).bind(watermark).all<PollObservation>();
  return result.results;
}

/** Prune poll_observations older than a given age (seconds) */
export async function pruneOldObservations(db: D1Database, maxAgeSec: number): Promise<number> {
  const cutoff = Math.floor(Date.now() / 1000) - maxAgeSec;
  const result = await db.prepare(
    "DELETE FROM poll_observations WHERE observed_at < ?"
  ).bind(cutoff).run();
  return result.meta.changes ?? 0;
}

/** Get the last poll observation (most recent) */
export async function getLastObservation(db: D1Database): Promise<PollObservation | null> {
  return db.prepare(
    "SELECT * FROM poll_observations ORDER BY observed_at DESC LIMIT 1"
  ).first<PollObservation>();
}
