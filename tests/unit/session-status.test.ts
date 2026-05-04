import { describe, it, expect, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../../src/index";

// Mock SpotifyClient — current_session_status calls it for now-playing
const mockGet = vi.fn();
vi.mock("../../src/spotify/client", () => ({
  SpotifyClient: class {
    get = mockGet;
  },
}));

const { callTool } = await import("../../src/mcp/tools");

const SESSIONS_DDL = [
  "CREATE TABLE IF NOT EXISTS sessions (id INTEGER PRIMARY KEY, session_id TEXT UNIQUE NOT NULL, mode TEXT NOT NULL, invoked_at INTEGER NOT NULL, invoked_via TEXT NOT NULL, fresh_ratio_target REAL, duration_target_min INTEGER, output TEXT NOT NULL, spotify_playlist_id TEXT, ended_at INTEGER, context_snapshot_id INTEGER)",
  "CREATE TABLE IF NOT EXISTS session_tracks (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL, track_id TEXT NOT NULL, source TEXT NOT NULL, was_swapped INTEGER DEFAULT 0, outcome TEXT, FOREIGN KEY(session_id) REFERENCES sessions(session_id))",
  "CREATE TABLE IF NOT EXISTS track_taste (track_id TEXT PRIMARY KEY, track_name TEXT, primary_artist_id TEXT, album_id TEXT, taste_score REAL, play_count INTEGER, complete_count INTEGER, skip_count INTEGER, in_liked_songs INTEGER, in_top_tracks_short INTEGER, in_top_tracks_medium INTEGER, in_playlists INTEGER, first_played_at INTEGER, last_played_at INTEGER)",
  "CREATE TABLE IF NOT EXISTS fresh_pool (track_id TEXT PRIMARY KEY, track_name TEXT, artist_name TEXT, source TEXT, source_detail TEXT, taste_score REAL, status TEXT, added_at INTEGER)",
];

function testEnv(): Env {
  return {
    DB: env.DB,
    KV: env.KV,
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SHORTCUT_TOKEN: "",
    RESEND_API_KEY: "",
    NOTIFICATION_EMAIL: "",
    SPOTIFY_USER_ID: "",
    ACCESS_ALLOWED_EMAIL: "",
    ACCESS_TEAM_NAME: "",
    ACCESS_AUD: "",
    OAUTH_KV: env.KV,
    OAUTH_PROVIDER: {} as any,
  };
}

async function seedSession(db: D1Database) {
  for (const ddl of SESSIONS_DDL) await db.exec(ddl);

  const now = Math.floor(Date.now() / 1000);
  await db.prepare(
    "INSERT INTO sessions (session_id, mode, invoked_at, invoked_via, output) VALUES (?, ?, ?, ?, ?)",
  ).bind("test-session-1", "working", now - 600, "mcp", "queue").run();

  // Insert track_taste rows so names resolve
  await db.prepare(
    "INSERT INTO track_taste (track_id, track_name) VALUES (?, ?)",
  ).bind("4cOdK2wGLETKBW3PvgPWqT", "Wild Horses").run();
  await db.prepare(
    "INSERT INTO track_taste (track_id, track_name) VALUES (?, ?)",
  ).bind("7ouMYWpwJ422jRcDASZB7P", "Knights of Cydonia").run();

  // Insert session tracks
  await db.prepare(
    "INSERT INTO session_tracks (session_id, position, track_id, source) VALUES (?, ?, ?, ?)",
  ).bind("test-session-1", 0, "4cOdK2wGLETKBW3PvgPWqT", "taste:familiar").run();
  await db.prepare(
    "INSERT INTO session_tracks (session_id, position, track_id, source) VALUES (?, ?, ?, ?)",
  ).bind("test-session-1", 1, "7ouMYWpwJ422jRcDASZB7P", "fresh:lastfm").run();
}

describe("current_session_status URIs", () => {
  beforeEach(async () => {
    await env.DB.exec("DROP TABLE IF EXISTS session_tracks");
    await env.DB.exec("DROP TABLE IF EXISTS sessions");
    await env.DB.exec("DROP TABLE IF EXISTS track_taste");
    await env.DB.exec("DROP TABLE IF EXISTS fresh_pool");
    await seedSession(env.DB);
    vi.clearAllMocks();
    // Default: no active playback
    mockGet.mockResolvedValue(null);
  });

  it("allTracks entries include uri fields", async () => {
    const result = (await callTool("current_session_status", {}, testEnv())) as Record<string, unknown>;
    expect(result.sessionId).toBe("test-session-1");

    const allTracks = result.allTracks as Array<{ name: string; uri: string; position: number }>;
    expect(allTracks).toHaveLength(2);
    expect(allTracks[0].uri).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    expect(allTracks[0].name).toBe("Wild Horses");
    expect(allTracks[1].uri).toBe("spotify:track:7ouMYWpwJ422jRcDASZB7P");
    expect(allTracks[1].name).toBe("Knights of Cydonia");
  });

  it("currentlyPlaying includes uri when track is playing", async () => {
    mockGet.mockResolvedValue({
      is_playing: true,
      item: {
        id: "4cOdK2wGLETKBW3PvgPWqT",
        name: "Wild Horses",
        artists: [{ name: "The Rolling Stones" }],
        duration_ms: 340000,
      },
      progress_ms: 120000,
    });

    const result = (await callTool("current_session_status", {}, testEnv())) as Record<string, unknown>;
    const playing = result.currentlyPlaying as Record<string, unknown>;
    expect(playing).not.toBeNull();
    expect(playing.uri).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    expect(playing.trackName).toBe("Wild Horses");
  });

  it("upcoming entries include uri fields", async () => {
    // Simulate first track playing — upcoming should be position 2+
    mockGet.mockResolvedValue({
      is_playing: true,
      item: {
        id: "4cOdK2wGLETKBW3PvgPWqT",
        name: "Wild Horses",
        artists: [{ name: "The Rolling Stones" }],
        duration_ms: 340000,
      },
      progress_ms: 120000,
    });

    const result = (await callTool("current_session_status", {}, testEnv())) as Record<string, unknown>;
    const upcoming = result.upcoming as Array<{ uri: string; name: string }>;
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].uri).toBe("spotify:track:7ouMYWpwJ422jRcDASZB7P");
    expect(upcoming[0].name).toBe("Knights of Cydonia");
  });
});
