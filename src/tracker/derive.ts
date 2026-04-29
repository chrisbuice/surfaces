/**
 * derive.ts — turn raw poll_observations into play_events.
 *
 * Logic:
 * We look at consecutive observations and figure out what happened.
 * - Same track, progress advanced → still listening
 * - Different track (or nothing playing) → previous track ended
 *   - If previous track was >80% through → "completed"
 *   - If previous track was <30% through → "skipped"
 *   - Otherwise → "partial"
 * - Same track, progress jumped backward → "replayed"
 *
 * We use America/New_York for hour_of_day and day_of_week since that's
 * the user's timezone (confirmed in pre-flight).
 */

import { getUnderivedObservations, insertPlayEvent, type PollObservation } from "../db/queries";

const USER_TZ = "America/New_York";

/**
 * Derive play events from poll observations.
 * If contextSnapshotId is provided, links each new play event to that snapshot.
 */
export async function derivePlayEvents(db: D1Database, contextSnapshotId?: number | null): Promise<number> {
  const observations = await getUnderivedObservations(db);
  if (observations.length < 2) return 0;

  let eventsCreated = 0;
  let currentTrack: PollObservation | null = null;
  let trackStartObs: PollObservation | null = null;

  for (const obs of observations) {
    if (currentTrack === null) {
      // First observation — start tracking if something is playing
      if (obs.is_playing && obs.track_id) {
        currentTrack = obs;
        trackStartObs = obs;
      }
      continue;
    }

    const trackChanged = obs.track_id !== currentTrack.track_id;
    const stoppedPlaying = !obs.is_playing;
    const replayed = !trackChanged && obs.progress_ms !== null && currentTrack.progress_ms !== null
      && obs.progress_ms < currentTrack.progress_ms - 5000; // 5s buffer for seek jitter

    if (trackChanged || stoppedPlaying || replayed) {
      // The previous track ended — classify it
      const event = classifyTrack(trackStartObs!, currentTrack, obs);
      if (event) {
        const eventId = await insertPlayEvent(db, event);
        eventsCreated++;

        // Link to context snapshot if available
        if (contextSnapshotId && eventId) {
          try {
            await db.prepare(
              "INSERT INTO play_event_context (play_event_id, context_snapshot_id) VALUES (?, ?)"
            ).bind(eventId, contextSnapshotId).run();
          } catch { /* already linked or snapshot doesn't exist */ }
        }
      }

      // Start tracking the new track (if any)
      if (obs.is_playing && obs.track_id && !stoppedPlaying) {
        currentTrack = obs;
        trackStartObs = obs;
      } else if (replayed && obs.is_playing) {
        // Replay — same track restarted
        currentTrack = obs;
        trackStartObs = obs;
      } else {
        currentTrack = null;
        trackStartObs = null;
      }

      // If track changed to a new track, start tracking it
      if (trackChanged && obs.is_playing && obs.track_id) {
        currentTrack = obs;
        trackStartObs = obs;
      }
    } else {
      // Same track, still playing — update our latest observation
      currentTrack = obs;
    }
  }

  return eventsCreated;
}

function classifyTrack(
  startObs: PollObservation,
  lastObs: PollObservation,
  endObs: PollObservation
): Omit<import("../db/queries").PlayEvent, "id"> | null {
  if (!startObs.track_id) return null;

  const durationMs = lastObs.duration_ms ?? 0;
  const progressAtEnd = lastObs.progress_ms ?? 0;
  const listenedMs = (endObs.observed_at - startObs.observed_at) * 1000;

  // Don't create events for very short observations (< 5 seconds)
  if (listenedMs < 5000) return null;

  let classification: "completed" | "skipped" | "partial" | "replayed";

  if (durationMs > 0) {
    const fractionPlayed = progressAtEnd / durationMs;
    if (fractionPlayed >= 0.8) {
      classification = "completed";
    } else if (fractionPlayed < 0.3) {
      classification = "skipped";
    } else {
      classification = "partial";
    }
  } else {
    // No duration info — use time-based heuristic
    classification = listenedMs > 60000 ? "completed" : "partial";
  }

  // Check if this was a replay (progress went backward in the endObs)
  if (endObs.track_id === startObs.track_id && endObs.progress_ms !== null
    && lastObs.progress_ms !== null && endObs.progress_ms < lastObs.progress_ms - 5000) {
    classification = "replayed";
  }

  const startDate = new Date(startObs.observed_at * 1000);
  const localTime = new Date(startDate.toLocaleString("en-US", { timeZone: USER_TZ }));

  return {
    track_id: startObs.track_id,
    started_at: startObs.observed_at,
    ended_at: endObs.observed_at,
    duration_listened_ms: listenedMs,
    track_duration_ms: durationMs || null,
    classification,
    context_uri: startObs.context_uri,
    context_type: startObs.context_type,
    device_type: startObs.device_type,
    hour_of_day: localTime.getHours(),
    day_of_week: localTime.getDay(),
    session_id: null,
  };
}
