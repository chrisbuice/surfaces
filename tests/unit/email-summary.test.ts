import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { buildSummary, renderEmail, formatEt } from "../../src/email/summary";

/**
 * Nightly summary email: Top Artists must count tracks the taste model hasn't
 * seen yet and must never render a blank artist name. The skip-rate tile is
 * replaced by an abandon rate because live plays are never classified "skipped".
 */

// Thu Oct 29 2026, 8:00:20 PM ET — when the midnight-UTC cron fires.
const NOW_MS = Date.UTC(2026, 9, 30, 0, 0, 20);
const NOW = Math.floor(NOW_MS / 1000);

async function setupSchema(db: D1Database) {
  const ddl = [
    "CREATE TABLE IF NOT EXISTS poll_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, is_playing INTEGER NOT NULL DEFAULT 1, track_id TEXT, track_name TEXT, artist_ids TEXT, artist_name TEXT, album_id TEXT, progress_ms INTEGER, duration_ms INTEGER, device_type TEXT, context_uri TEXT, context_type TEXT)",
    "CREATE TABLE IF NOT EXISTS play_events (id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_listened_ms INTEGER NOT NULL, track_duration_ms INTEGER, classification TEXT NOT NULL, context_uri TEXT, context_type TEXT, device_type TEXT, hour_of_day INTEGER, day_of_week INTEGER, session_id TEXT)",
    "CREATE TABLE IF NOT EXISTS track_taste (track_id TEXT PRIMARY KEY, track_name TEXT NOT NULL, artist_ids TEXT NOT NULL, primary_artist_id TEXT NOT NULL, refreshed_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS artist_taste (artist_id TEXT PRIMARY KEY, artist_name TEXT NOT NULL, refreshed_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, mode TEXT NOT NULL, invoked_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS session_tracks (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL, track_id TEXT NOT NULL, source TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS context_snapshots (id INTEGER PRIMARY KEY, weather_condition TEXT, daylight_phase TEXT NOT NULL, device_type TEXT, location_label TEXT)",
    "CREATE TABLE IF NOT EXISTS play_event_context (play_event_id INTEGER PRIMARY KEY, context_snapshot_id INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS fresh_pool (id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, found_at INTEGER NOT NULL)",
  ];
  await db.batch(ddl.map(sql => db.prepare(sql)));
}

async function clearTables(db: D1Database) {
  const tables = ["poll_observations", "play_events", "track_taste", "artist_taste", "sessions", "session_tracks", "context_snapshots", "play_event_context", "fresh_pool"];
  await db.batch(tables.map(t => db.prepare(`DELETE FROM ${t}`)));
}

let nextEventId = 1;
async function play(db: D1Database, trackId: string, classification: string, minutesAgo: number) {
  const started = NOW - minutesAgo * 60;
  await db.prepare(
    "INSERT INTO play_events (id, track_id, started_at, ended_at, duration_listened_ms, classification) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(nextEventId++, trackId, started, started + 180, 180_000, classification).run();
}

async function poll(db: D1Database, trackId: string, trackName: string, artistIds: string[] | null, artistName: string | null, minutesAgo: number) {
  await db.prepare(
    "INSERT INTO poll_observations (observed_at, is_playing, track_id, track_name, artist_ids, artist_name) VALUES (?, 1, ?, ?, ?, ?)"
  ).bind(NOW - minutesAgo * 60, trackId, trackName, artistIds ? JSON.stringify(artistIds) : null, artistName).run();
}

describe("nightly summary", () => {
  beforeAll(async () => {
    await setupSchema(env.DB);
  });

  beforeEach(async () => {
    await clearTables(env.DB);
    nextEventId = 1;
    const db = env.DB;

    // Zach Seabaugh: two tracks first heard today — NOT in track_taste yet.
    await poll(db, "t-weekend", "Every Weekend", ["zach"], "Zach Seabaugh", 300);
    await poll(db, "t-weekend", "Every Weekend", null, null, 299); // older-style row with no artist data
    await poll(db, "t-onebyone", "One By One", ["zach"], "Zach Seabaugh", 200);
    for (const c of ["completed", "completed", "abandoned"]) await play(db, "t-weekend", c, 300);
    for (const c of ["completed", "abandoned"]) await play(db, "t-onebyone", c, 200);

    // Aretha: known to the taste model with a real name.
    await db.prepare("INSERT INTO track_taste VALUES ('t-chain', 'Chain of Fools', '[\"aretha\"]', 'aretha', 0)").run();
    await db.prepare("INSERT INTO artist_taste VALUES ('aretha', 'Aretha Franklin', 0)").run();
    await poll(db, "t-chain", "Chain of Fools", ["aretha"], "Aretha Franklin", 100);
    for (const c of ["completed", "completed", "completed"]) await play(db, "t-chain", c, 100);

    // Babes In Canyon: the bug case — artist_taste row exists but its name was blanked.
    await db.prepare("INSERT INTO track_taste VALUES ('t-light', 'Chemical Light', '[\"babes\"]', 'babes', 0)").run();
    await db.prepare("INSERT INTO artist_taste VALUES ('babes', '', 0)").run();
    await poll(db, "t-light", "Chemical Light", ["babes"], "Babes In Canyon", 50);
    for (const c of ["completed", "abandoned"]) await play(db, "t-light", c, 50);

    // Collab whose first artist's name contains the ", " separator; no artist_taste row.
    await poll(db, "t-collab", "Love <3 & You", ["tyler", "kali"], "Tyler, The Creator, Kali Uchis", 20);
    await play(db, "t-collab", "replayed", 20);

    // Outside the 24h window — must not count.
    await play(db, "t-chain", "completed", 25 * 60);
  });

  it("counts artists of tracks the taste model hasn't seen yet", async () => {
    const s = await buildSummary(env.DB, NOW_MS);
    expect(s.topArtists[0]).toEqual({ name: "Zach Seabaugh", count: 5 });
  });

  it("never returns a blank artist name", async () => {
    const s = await buildSummary(env.DB, NOW_MS);
    expect(s.topArtists).toEqual([
      { name: "Zach Seabaugh", count: 5 },
      { name: "Aretha Franklin", count: 3 },
      { name: "Babes In Canyon", count: 2 },
      { name: "Tyler, The Creator, Kali Uchis", count: 1 },
    ]);
    for (const a of s.topArtists) expect(a.name.trim()).not.toBe("");
  });

  it("reports an abandon rate and a breakdown that sums to the total", async () => {
    const s = await buildSummary(env.DB, NOW_MS);
    expect(s.totalTracks).toBe(11);
    expect(s.completed).toBe(7);
    expect(s.abandoned).toBe(3);
    expect(s.replayed).toBe(1);
    expect(s.skipped).toBe(0);
    expect(s.completed + s.skipped + s.abandoned + s.replayed).toBe(s.totalTracks);
    expect(s.abandonRate).toBe(27); // 3 / 11
  });

  it("covers the rolling 24 hours ending at send time", async () => {
    const s = await buildSummary(env.DB, NOW_MS);
    expect(s.windowEndMs).toBe(NOW_MS);
    expect(s.windowStartMs).toBe((NOW - 24 * 3600) * 1000);
    expect(formatEt(s.windowStartMs)).toBe("Wed, Oct 28, 8 PM");
    expect(formatEt(s.windowEndMs)).toBe("Thu, Oct 29, 8 PM");
  });

  it("renders the abandon tile, the window, and escaped names", async () => {
    const html = renderEmail(await buildSummary(env.DB, NOW_MS));
    expect(html).not.toContain("skip rate");
    expect(html).toContain(">27%</div>");
    expect(html).toContain(">abandoned</div>");
    expect(html).toContain("7 completed &middot; 3 abandoned &middot; 1 replayed");
    expect(html).not.toContain("skipped");
    expect(html).toContain("Wed, Oct 28, 8 PM – Thu, Oct 29, 8 PM ET");
    expect(html).toContain("Love &lt;3 &amp; You");
    expect(html).toContain(">1 play</td>");
    expect(html).not.toMatch(/<td style="padding:6px 0;font-size:15px;color:#333;"><\/td>/);
  });
});
