import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { env } from "cloudflare:test";

/**
 * The nightly taste rebuild used to write artist_name = "" for any artist it
 * only knew through a track (not in top/followed lists), overwriting real
 * names every night. These tests pin the fix: names come from track objects
 * and poll observations, and an empty name never overwrites a stored one.
 */

vi.mock("../../src/spotify/library", () => ({
  getSavedTracks: vi.fn(),
  getTopTracks: vi.fn(),
  getTopArtists: vi.fn(),
  getFollowedArtists: vi.fn(),
}));
vi.mock("../../src/taste/seasonal", () => ({
  syncSeasonalPlaylists: vi.fn(async () => ({ total: 0 })),
}));
vi.mock("../../src/spotify/embed", () => ({
  getPlaylistTracksViaEmbed: vi.fn(async () => ({ tracks: [] })),
}));

const library = await import("../../src/spotify/library");
const { rebuildTasteModel, ARTIST_TASTE_UPSERT_SQL } = await import("../../src/taste/model");
import type { SpotifyClient } from "../../src/spotify/client";

async function setupSchema(db: D1Database) {
  const ddl = [
    "CREATE TABLE IF NOT EXISTS poll_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, observed_at INTEGER NOT NULL, is_playing INTEGER NOT NULL DEFAULT 1, track_id TEXT, track_name TEXT, artist_ids TEXT, artist_name TEXT, album_id TEXT, progress_ms INTEGER, duration_ms INTEGER, device_type TEXT, context_uri TEXT, context_type TEXT)",
    "CREATE TABLE IF NOT EXISTS play_events (id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, started_at INTEGER NOT NULL, ended_at INTEGER NOT NULL, duration_listened_ms INTEGER NOT NULL, track_duration_ms INTEGER, classification TEXT NOT NULL, context_uri TEXT, context_type TEXT, device_type TEXT, hour_of_day INTEGER, day_of_week INTEGER, session_id TEXT)",
    "CREATE TABLE IF NOT EXISTS seasonal_playlists (id INTEGER PRIMARY KEY, spotify_playlist_id TEXT UNIQUE NOT NULL, name TEXT NOT NULL, season TEXT NOT NULL, year INTEGER NOT NULL, is_current INTEGER DEFAULT 0, last_synced_at INTEGER)",
    "CREATE TABLE IF NOT EXISTS track_taste (track_id TEXT PRIMARY KEY, track_name TEXT NOT NULL, artist_ids TEXT NOT NULL, primary_artist_id TEXT NOT NULL, album_id TEXT, in_liked_songs INTEGER DEFAULT 0, in_top_tracks_short INTEGER DEFAULT 0, in_top_tracks_medium INTEGER DEFAULT 0, in_top_tracks_long INTEGER DEFAULT 0, seasonal_playlist_count INTEGER DEFAULT 0, current_season_present INTEGER DEFAULT 0, play_count INTEGER DEFAULT 0, skip_count INTEGER DEFAULT 0, complete_count INTEGER DEFAULT 0, last_played_at INTEGER, taste_score REAL, acoustic_fit_to_overall REAL, refreshed_at INTEGER NOT NULL)",
    "CREATE TABLE IF NOT EXISTS artist_taste (artist_id TEXT PRIMARY KEY, artist_name TEXT NOT NULL, in_top_artists_short INTEGER DEFAULT 0, in_top_artists_medium INTEGER DEFAULT 0, in_top_artists_long INTEGER DEFAULT 0, is_followed INTEGER DEFAULT 0, total_plays INTEGER DEFAULT 0, unique_tracks_played INTEGER DEFAULT 0, taste_score REAL, refreshed_at INTEGER NOT NULL)",
  ];
  await db.batch(ddl.map(sql => db.prepare(sql)));
}

async function nameOf(db: D1Database, artistId: string): Promise<string | null> {
  const row = await db.prepare("SELECT artist_name FROM artist_taste WHERE artist_id = ?").bind(artistId).first<{ artist_name: string }>();
  return row?.artist_name ?? null;
}

function upsert(db: D1Database, artistId: string, name: string) {
  return db.prepare(ARTIST_TASTE_UPSERT_SQL).bind(artistId, name, 0, 0, 0, 0, 0, 0, 0.5, 0).run();
}

describe("artist_taste names", () => {
  beforeAll(async () => {
    await setupSchema(env.DB);
  });

  beforeEach(async () => {
    const tables = ["poll_observations", "play_events", "seasonal_playlists", "track_taste", "artist_taste"];
    await env.DB.batch(tables.map(t => env.DB.prepare(`DELETE FROM ${t}`)));
    vi.mocked(library.getSavedTracks).mockResolvedValue([]);
    vi.mocked(library.getTopTracks).mockResolvedValue([]);
    vi.mocked(library.getTopArtists).mockResolvedValue([]);
    vi.mocked(library.getFollowedArtists).mockResolvedValue([]);
  });

  it("upsert keeps a stored name when the incoming name is empty", async () => {
    await upsert(env.DB, "aretha", "Aretha Franklin");
    await upsert(env.DB, "aretha", "");
    expect(await nameOf(env.DB, "aretha")).toBe("Aretha Franklin");
  });

  it("upsert still updates a name when the incoming name is real", async () => {
    await upsert(env.DB, "aretha", "Aretha");
    await upsert(env.DB, "aretha", "Aretha Franklin");
    expect(await nameOf(env.DB, "aretha")).toBe("Aretha Franklin");
  });

  it("names track-only artists from saved-track objects and from poll observations", async () => {
    // Featured artist on a liked song — not in top/followed lists.
    vi.mocked(library.getSavedTracks).mockResolvedValue([{
      id: "t-liked", name: "Chain of Fools", duration_ms: 1,
      album: { id: "al1", name: "Lady Soul" },
      artists: [{ id: "aretha", name: "Aretha Franklin" }, { id: "curtis", name: "King Curtis" }],
    }]);
    // Artist only ever seen through a live play.
    await env.DB.prepare(
      "INSERT INTO poll_observations (observed_at, is_playing, track_id, track_name, artist_ids, artist_name) VALUES (1, 1, 't-new', 'Every Weekend', '[\"zach\"]', 'Zach Seabaugh')"
    ).run();
    await env.DB.prepare(
      "INSERT INTO play_events (id, track_id, started_at, ended_at, duration_listened_ms, classification) VALUES (1, 't-new', 1, 200, 199000, 'completed')"
    ).run();

    await rebuildTasteModel(env.DB, {} as SpotifyClient, "user");

    expect(await nameOf(env.DB, "aretha")).toBe("Aretha Franklin");
    expect(await nameOf(env.DB, "curtis")).toBe("King Curtis");
    expect(await nameOf(env.DB, "zach")).toBe("Zach Seabaugh");
  });

  it("a rebuild doesn't wipe the name of an artist who dropped out of the top lists", async () => {
    vi.mocked(library.getTopArtists).mockResolvedValue([{ id: "babes", name: "Babes In Canyon", genres: [] }]);
    await rebuildTasteModel(env.DB, {} as SpotifyClient, "user");
    expect(await nameOf(env.DB, "babes")).toBe("Babes In Canyon");

    // Next night: no longer a top artist, only reachable through a track with an unsplittable credit.
    vi.mocked(library.getTopArtists).mockResolvedValue([]);
    await env.DB.prepare(
      "INSERT INTO poll_observations (observed_at, is_playing, track_id, track_name, artist_ids, artist_name) VALUES (1, 1, 't-collab', 'Collab', '[\"babes\",\"tyler\"]', 'Babes In Canyon, Tyler, The Creator')"
    ).run();
    await env.DB.prepare(
      "INSERT INTO play_events (id, track_id, started_at, ended_at, duration_listened_ms, classification) VALUES (1, 't-collab', 1, 200, 199000, 'completed')"
    ).run();
    await rebuildTasteModel(env.DB, {} as SpotifyClient, "user");
    expect(await nameOf(env.DB, "babes")).toBe("Babes In Canyon");
  });
});
