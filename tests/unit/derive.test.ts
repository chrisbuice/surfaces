import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { derivePlayEvents } from "../../src/tracker/derive";
import { insertPollObservation } from "../../src/db/queries";

/**
 * Tests for the three-way classification logic in derive.ts:
 * - completed: track played ≥80%
 * - abandoned: track stopped before 80% (NOT "skipped" — we can't tell from the live API)
 * - reconciliation: if the same track resumes, the abandoned event is deleted
 */

async function setupSchema(db: D1Database) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS poll_observations (" +
    "id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, " +
    "is_playing INTEGER NOT NULL DEFAULT 1, track_id TEXT, track_name TEXT, " +
    "artist_ids TEXT, artist_name TEXT, album_id TEXT, progress_ms INTEGER, " +
    "duration_ms INTEGER, device_type TEXT, context_uri TEXT, context_type TEXT);"
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS play_events (" +
    "id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, started_at INTEGER NOT NULL, " +
    "ended_at INTEGER NOT NULL, duration_listened_ms INTEGER NOT NULL, " +
    "track_duration_ms INTEGER, classification TEXT NOT NULL, context_uri TEXT, " +
    "context_type TEXT, device_type TEXT, hour_of_day INTEGER, day_of_week INTEGER, " +
    "session_id TEXT);"
  );
  await db.exec(
    "CREATE TABLE IF NOT EXISTS play_event_context (" +
    "play_event_id INTEGER NOT NULL, context_snapshot_id INTEGER NOT NULL, " +
    "PRIMARY KEY (play_event_id, context_snapshot_id));"
  );
}

async function clearTables(db: D1Database) {
  await db.exec("DELETE FROM play_event_context; DELETE FROM play_events; DELETE FROM poll_observations;");
}

/** Insert a poll observation with sensible defaults */
async function obs(db: D1Database, overrides: {
  observed_at: number;
  is_playing?: number;
  track_id?: string | null;
  progress_ms?: number | null;
  duration_ms?: number | null;
}) {
  await insertPollObservation(db, {
    observed_at: overrides.observed_at,
    is_playing: overrides.is_playing ?? 1,
    track_id: overrides.track_id ?? null,
    track_name: overrides.track_id ? `Track ${overrides.track_id}` : null,
    artist_ids: null,
    artist_name: null,
    album_id: null,
    progress_ms: overrides.progress_ms ?? null,
    duration_ms: overrides.duration_ms ?? null,
    device_type: "Smartphone",
    context_uri: null,
    context_type: null,
  });
}

async function getPlayEvents(db: D1Database) {
  return (await db.prepare("SELECT * FROM play_events ORDER BY started_at ASC")
    .all<{ id: number; track_id: string; classification: string; started_at: number; ended_at: number }>()).results;
}

const BASE_TIME = 1700000000; // arbitrary epoch
const TRACK_DURATION = 240000; // 4 minutes

describe("derive.ts classification", () => {
  beforeEach(async () => {
    await setupSchema(env.DB);
    await clearTables(env.DB);
  });

  it("classifies track played ≥80% as completed", async () => {
    // Track A plays at 0s, progress at 80% at 60s, then different track at 120s
    await obs(env.DB, { observed_at: BASE_TIME, track_id: "A", progress_ms: 0, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + 60, track_id: "A", progress_ms: 200000, duration_ms: TRACK_DURATION }); // 83%
    await obs(env.DB, { observed_at: BASE_TIME + 120, track_id: "B", progress_ms: 0, duration_ms: TRACK_DURATION });

    const count = await derivePlayEvents(env.DB);
    expect(count).toBe(1);

    const events = await getPlayEvents(env.DB);
    expect(events).toHaveLength(1);
    expect(events[0].track_id).toBe("A");
    expect(events[0].classification).toBe("completed");
  });

  it("classifies track stopped at 30% then different track as abandoned (not skipped)", async () => {
    // Track A plays at 0s, progress at 30% at 60s, then different track IMMEDIATELY at 120s
    // Even with a short gap, this should be "abandoned" — we can't distinguish pauses from skips
    await obs(env.DB, { observed_at: BASE_TIME, track_id: "A", progress_ms: 0, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + 60, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION }); // 30%
    await obs(env.DB, { observed_at: BASE_TIME + 120, track_id: "B", progress_ms: 0, duration_ms: TRACK_DURATION });

    const count = await derivePlayEvents(env.DB);
    expect(count).toBe(1);

    const events = await getPlayEvents(env.DB);
    expect(events).toHaveLength(1);
    expect(events[0].track_id).toBe("A");
    expect(events[0].classification).toBe("abandoned");
  });

  it("deletes abandoned event when same track resumes (short gap)", async () => {
    // Track A plays, stops (abandoned), then same track A resumes
    await obs(env.DB, { observed_at: BASE_TIME, track_id: "A", progress_ms: 0, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + 60, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION }); // 30%
    await obs(env.DB, { observed_at: BASE_TIME + 120, is_playing: 0, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION }); // paused

    // First derive: creates an "abandoned" event
    let count = await derivePlayEvents(env.DB);
    expect(count).toBe(1);
    let events = await getPlayEvents(env.DB);
    expect(events).toHaveLength(1);
    expect(events[0].classification).toBe("abandoned");

    // Track A resumes shortly after, plays to completion
    await obs(env.DB, { observed_at: BASE_TIME + 180, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + 360, track_id: "A", progress_ms: 200000, duration_ms: TRACK_DURATION }); // 83%
    await obs(env.DB, { observed_at: BASE_TIME + 420, track_id: "B", progress_ms: 0, duration_ms: TRACK_DURATION });

    // Second derive: should delete the abandoned event and create a completed event
    count = await derivePlayEvents(env.DB);
    expect(count).toBe(1);
    events = await getPlayEvents(env.DB);
    expect(events).toHaveLength(1); // abandoned was deleted, only completed remains
    expect(events[0].classification).toBe("completed");
    expect(events[0].track_id).toBe("A");
  });

  it("deletes abandoned event when same track resumes after long gap (8 hours)", async () => {
    // Track A plays 30%, pauses
    await obs(env.DB, { observed_at: BASE_TIME, track_id: "A", progress_ms: 0, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + 60, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION }); // 30%
    await obs(env.DB, { observed_at: BASE_TIME + 120, is_playing: 0, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION });

    // First derive: creates abandoned
    let count = await derivePlayEvents(env.DB);
    expect(count).toBe(1);
    let events = await getPlayEvents(env.DB);
    expect(events[0].classification).toBe("abandoned");

    // 8 hours later, same track resumes and completes
    const eightHours = 8 * 3600;
    await obs(env.DB, { observed_at: BASE_TIME + eightHours, track_id: "A", progress_ms: 72000, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + eightHours + 180, track_id: "A", progress_ms: 200000, duration_ms: TRACK_DURATION });
    await obs(env.DB, { observed_at: BASE_TIME + eightHours + 240, track_id: "B", progress_ms: 0, duration_ms: TRACK_DURATION });

    // Second derive: abandoned deleted, completed created
    count = await derivePlayEvents(env.DB);
    expect(count).toBe(1);
    events = await getPlayEvents(env.DB);
    expect(events).toHaveLength(1);
    expect(events[0].classification).toBe("completed");
    expect(events[0].track_id).toBe("A");
  });
});
