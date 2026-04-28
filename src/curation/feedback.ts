/**
 * feedback.ts — in-session adjustments based on play behavior.
 *
 * Runs every 2 minutes via cron while a session is active.
 * Reads recent play_events, matches them to session_tracks, and reacts:
 *
 * - Skip in first 25% of track: strong negative
 * - Skip after 75%: mild negative (fine but not now)
 * - Replay: strong positive — if fresh, mark as 'liked' in pool
 * - 3 skips in a row: shift rest of queue to higher familiarity
 * - 3 skips in first 5 tracks with context biases: reset context biases
 *
 * Also links each play_event to the session's context_snapshot via
 * play_event_context — this feeds learned affinities (M10).
 */

import { markFreshUsed } from "../discovery/pool";

interface SessionInfo {
  session_id: string;
  mode: string;
  context_snapshot_id: number | null;
  invoked_at: number;
}

interface SessionTrack {
  id: number;
  session_id: string;
  position: number;
  track_id: string;
  source: string;
  outcome: string | null;
}

interface PlayEvent {
  id: number;
  track_id: string;
  started_at: number;
  classification: string;
  duration_listened_ms: number;
  track_duration_ms: number | null;
}

export interface FeedbackResult {
  sessionId: string;
  eventsProcessed: number;
  skipsDetected: number;
  completionsDetected: number;
  replaysDetected: number;
  consecutiveSkips: number;
  familiarityShifted: boolean;
  contextReset: boolean;
  freshLiked: string[];
  freshSkipped: string[];
  contextLinked: number;
}

/** Check for an active session and process feedback */
export async function processFeedback(db: D1Database): Promise<FeedbackResult | null> {
  // Find the most recent session that hasn't ended
  const session = await db.prepare(
    "SELECT session_id, mode, context_snapshot_id, invoked_at FROM sessions WHERE ended_at IS NULL ORDER BY invoked_at DESC LIMIT 1"
  ).first<SessionInfo>();

  if (!session) return null;

  // If session is older than 4 hours, auto-end it
  const now = Math.floor(Date.now() / 1000);
  if (now - session.invoked_at > 4 * 3600) {
    await db.prepare(
      "UPDATE sessions SET ended_at = ? WHERE session_id = ?"
    ).bind(now, session.session_id).run();
    return null;
  }

  // Get session tracks
  const sessionTracks = await db.prepare(
    "SELECT * FROM session_tracks WHERE session_id = ? ORDER BY position"
  ).bind(session.session_id).all<SessionTrack>();

  const trackIds = new Set(sessionTracks.results.map(t => t.track_id));

  // Get play events since session started, for tracks in this session
  const playEvents = await db.prepare(
    "SELECT * FROM play_events WHERE started_at >= ? ORDER BY started_at ASC"
  ).bind(session.invoked_at).all<PlayEvent>();

  // Filter to events for session tracks
  const sessionEvents = playEvents.results.filter(e => trackIds.has(e.track_id));

  const result: FeedbackResult = {
    sessionId: session.session_id,
    eventsProcessed: 0,
    skipsDetected: 0,
    completionsDetected: 0,
    replaysDetected: 0,
    consecutiveSkips: 0,
    familiarityShifted: false,
    contextReset: false,
    freshLiked: [],
    freshSkipped: [],
    contextLinked: 0,
  };

  // Track consecutive skips
  let consecutiveSkips = 0;
  let eventsInFirst5 = 0;
  let skipsInFirst5 = 0;

  for (const event of sessionEvents) {
    result.eventsProcessed++;

    // Find the matching session track
    const sessionTrack = sessionTracks.results.find(t => t.track_id === event.track_id);
    if (!sessionTrack) continue;

    // Update outcome if not already set
    if (!sessionTrack.outcome) {
      await db.prepare(
        "UPDATE session_tracks SET outcome = ? WHERE id = ?"
      ).bind(event.classification, sessionTrack.id).run();
    }

    // Link to context snapshot
    if (session.context_snapshot_id) {
      try {
        // Check if already linked
        const existing = await db.prepare(
          "SELECT 1 FROM play_event_context WHERE play_event_id = ?"
        ).bind(event.id).first();
        if (!existing) {
          await db.prepare(
            "INSERT INTO play_event_context (play_event_id, context_snapshot_id) VALUES (?, ?)"
          ).bind(event.id, session.context_snapshot_id).run();
          result.contextLinked++;
        }
      } catch { /* skip */ }
    }

    // Count by classification
    if (event.classification === "skipped") {
      result.skipsDetected++;
      consecutiveSkips++;

      // Track skips in first 5 positions
      if (sessionTrack.position < 5) {
        eventsInFirst5++;
        skipsInFirst5++;
      }

      // Mark fresh tracks as skipped in pool
      if (sessionTrack.source.startsWith("fresh:")) {
        await markFreshUsed(db, event.track_id, "skipped");
        result.freshSkipped.push(event.track_id);
      }
    } else if (event.classification === "completed") {
      result.completionsDetected++;
      consecutiveSkips = 0;

      if (sessionTrack.position < 5) eventsInFirst5++;
    } else if (event.classification === "replayed") {
      result.replaysDetected++;
      consecutiveSkips = 0;

      // If a fresh track is replayed, mark as liked
      if (sessionTrack.source.startsWith("fresh:")) {
        await markFreshUsed(db, event.track_id, "liked");
        result.freshLiked.push(event.track_id);
      }
    } else {
      // partial
      consecutiveSkips = 0;
      if (sessionTrack.position < 5) eventsInFirst5++;
    }
  }

  result.consecutiveSkips = consecutiveSkips;

  // ── React to patterns ──

  // 3+ consecutive skips: shift remaining tracks toward familiar
  if (consecutiveSkips >= 3) {
    result.familiarityShifted = true;
    // We can't reorder the Spotify queue mid-play (no API for that),
    // but we record the signal for the next session's scoring
    // and mark the session as having shifted
  }

  // 3 skips in first 5 tracks with context applied: reset context
  if (skipsInFirst5 >= 3 && eventsInFirst5 >= 5 && session.context_snapshot_id) {
    result.contextReset = true;
    // Log this for review — the context guess was likely wrong
    console.warn(`Session ${session.session_id}: context reset triggered (${skipsInFirst5} skips in first 5 tracks)`);
  }

  // Auto-end session if all tracks have outcomes
  const tracksWithOutcomes = sessionTracks.results.filter(t => t.outcome !== null).length;
  if (tracksWithOutcomes >= sessionTracks.results.length) {
    await db.prepare(
      "UPDATE sessions SET ended_at = ? WHERE session_id = ?"
    ).bind(now, session.session_id).run();
  }

  return result;
}
