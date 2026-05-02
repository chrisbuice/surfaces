import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { generateQueue } from "../../src/listening/queue";

async function seedQueueTestData(db: D1Database) {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS plays (" +
    "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, platform TEXT NOT NULL, " +
    "ms_played INTEGER NOT NULL, conn_country TEXT NOT NULL, track_name TEXT NOT NULL, " +
    "artist_name TEXT NOT NULL, album_name TEXT NOT NULL, spotify_track_uri TEXT NOT NULL, " +
    "reason_start TEXT NOT NULL DEFAULT '', reason_end TEXT NOT NULL DEFAULT '', " +
    "shuffle INTEGER NOT NULL DEFAULT 0, offline INTEGER NOT NULL DEFAULT 0, " +
    "year INTEGER NOT NULL, month INTEGER NOT NULL, hour INTEGER NOT NULL, " +
    "local_hour INTEGER NOT NULL, minutes REAL NOT NULL);"
  );

  const nowTs = Math.floor(Date.now() / 1000);
  const oneMonthAgo = nowTs - 30 * 86400;
  const twoYearsAgo = nowTs - 2.5 * 365.25 * 86400;

  // Recent high-affinity tracks by various artists
  const recentTracks = [
    { name: "Track A", artist: "Artist One", uri: "spotify:track:a1" },
    { name: "Track B", artist: "Artist Two", uri: "spotify:track:b1" },
    { name: "Track C", artist: "Artist Three", uri: "spotify:track:c1" },
    { name: "Dreams", artist: "Fleetwood Mac", uri: "spotify:track:dreams" }, // never-stale core
    { name: "Halo", artist: "Beyoncé", uri: "spotify:track:halo" }, // never-stale core
    { name: "Track D", artist: "Artist Four", uri: "spotify:track:d1" },
    { name: "Track E", artist: "Artist Five", uri: "spotify:track:e1" },
    { name: "Track F", artist: "Artist One", uri: "spotify:track:f1" },
    { name: "Track G", artist: "Artist One", uri: "spotify:track:g1" },
    { name: "Track H", artist: "Artist One", uri: "spotify:track:h1" }, // 4th by same artist
  ];

  // Add recent plays for each track
  for (const t of recentTracks) {
    for (let i = 0; i < 15; i++) {
      const ts = oneMonthAgo + i * 86400;
      await db.prepare(
        "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
        "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
        "year, month, hour, local_hour, minutes) " +
        "VALUES (?, 'iOS', 210000, 'US', ?, ?, 'Album', ?, 'clickrow', 'trackdone', 0, 0, 2026, 4, 10, 5, 3.5)"
      ).bind(ts, t.name, t.artist, t.uri).run();
    }
  }

  // Old "lost favorite" tracks (played a lot 3+ years ago, not since)
  // Use a distinct artist so this track won't be in the regular affinity pool
  const threeYearsAgo = nowTs - 3.5 * 365.25 * 86400;
  for (let i = 0; i < 30; i++) {
    const ts = threeYearsAgo + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Old Hit', 'Old Artist', 'Old Album', " +
      "'spotify:track:old1', 'clickrow', 'trackdone', 0, 0, 2022, 6, 10, 5, 3.5)"
    ).bind(ts).run();
  }

  // Second lost favorite with a different artist
  for (let i = 0; i < 25; i++) {
    const ts = threeYearsAgo + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Old Hit 2', 'Old Artist 2', 'Old Album 2', " +
      "'spotify:track:old2', 'clickrow', 'trackdone', 0, 0, 2022, 6, 10, 5, 3.5)"
    ).bind(ts).run();
  }

  // A track that gets skip-penalized (≥3 quick skips recently)
  for (let i = 0; i < 4; i++) {
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 15000, 'US', 'Bad Track', 'Bad Artist', 'Bad Album', " +
      "'spotify:track:bad1', 'clickrow', 'fwdbtn', 0, 0, 2026, 4, 10, 5, 0.25)"
    ).bind(nowTs - i * 86400).run();
  }
  // Also add some completed plays so it has affinity
  for (let i = 0; i < 20; i++) {
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Bad Track', 'Bad Artist', 'Bad Album', " +
      "'spotify:track:bad1', 'clickrow', 'trackdone', 0, 0, 2026, 3, 10, 5, 3.5)"
    ).bind(oneMonthAgo - i * 86400).run();
  }

  // Morning tracks
  for (let i = 0; i < 20; i++) {
    const ts = oneMonthAgo + i * 86400;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Morning Song', 'Morning Artist', 'Morning Album', " +
      "'spotify:track:morning1', 'clickrow', 'trackdone', 0, 0, 2026, 4, 12, 7, 3.5)"
    ).bind(ts).run();
  }
}

describe("generateQueue", () => {
  beforeAll(async () => {
    await seedQueueTestData(env.DB);
  });

  it("returns tracks with reason strings and provenance", async () => {
    const result = await generateQueue(env.DB, {
      mode: "default",
      lengthMin: 30,
    });
    expect(result.source).toBe("local_history");
    expect(result.mode).toBe("default");
    expect(result.tracks.length).toBeGreaterThan(0);
    for (const t of result.tracks) {
      expect(t.uri).toBeTruthy();
      expect(t.reason).toBeTruthy();
      expect(typeof t.affinityScore).toBe("number");
    }
  });

  it("applies never-stale-core boost", async () => {
    const result = await generateQueue(env.DB, {
      mode: "default",
      lengthMin: 60,
    });
    const coreTracks = result.tracks.filter((t) => t.isNeverStaleCore);
    expect(coreTracks.length).toBeGreaterThan(0);
    // Core tracks should have "never-stale core" in their reason
    for (const t of coreTracks) {
      expect(t.reason).toContain("never-stale core");
    }
  });

  it("excludes skip-penalized tracks", async () => {
    const result = await generateQueue(env.DB, {
      mode: "default",
      lengthMin: 60,
    });
    const badTrack = result.tracks.find((t) => t.uri === "spotify:track:bad1");
    expect(badTrack).toBeUndefined();
    expect(result.excluded.skipPenalized).toBeGreaterThan(0);
  });

  it("respects artist dedup (max 3 per artist)", async () => {
    const result = await generateQueue(env.DB, {
      mode: "default",
      lengthMin: 120, // long queue to test dedup
    });
    const artistCounts: Record<string, number> = {};
    for (const t of result.tracks) {
      artistCounts[t.artist] = (artistCounts[t.artist] ?? 0) + 1;
    }
    for (const [artist, count] of Object.entries(artistCounts)) {
      expect(count, `${artist} appears ${count} times`).toBeLessThanOrEqual(3);
    }
  });

  it("mixes lost favorites in rediscover mode", async () => {
    // First verify the old track qualifies as a lost favorite
    const { getLostFavorites } = await import("../../src/listening/queries");
    const lost = await getLostFavorites(env.DB, 20, 2, 50);
    expect(lost.length, "getLostFavorites should find the old track").toBeGreaterThan(0);

    const result = await generateQueue(env.DB, {
      mode: "rediscover",
      lengthMin: 60,
    });
    const lostFavs = result.tracks.filter((t) => t.reason.includes("lost favorite"));
    // Should have some lost favorites in the mix
    expect(lostFavs.length).toBeGreaterThan(0);
  });
});
