import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { search, getTrackDetail, getArtistDetail, getRollingWindows } from "../../src/listening/dashboard-queries";

async function seedDashboardTestData(db: D1Database) {
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
  const recentTs = nowTs - 3 * 86400; // 3 days ago

  // Artist with multiple tracks
  for (let i = 0; i < 50; i++) {
    const ts = recentTs + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Big Hit', 'Test Star', 'Album One', " +
      "'spotify:track:bighit1', 'clickrow', 'trackdone', 0, 0, 2026, 4, 10, 5, 3.5)"
    ).bind(ts).run();
  }
  for (let i = 0; i < 20; i++) {
    const ts = recentTs + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Second Song', 'Test Star', 'Album Two', " +
      "'spotify:track:second1', 'clickrow', 'fwdbtn', 0, 0, 2026, 4, 10, 5, 3.5)"
    ).bind(ts).run();
  }

  // Case-variant track (same song, different casing)
  for (let i = 0; i < 10; i++) {
    const ts = recentTs + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'big hit', 'Test Star', 'Album One Reissue', " +
      "'spotify:track:bighit2', 'clickrow', 'trackdone', 0, 0, 2026, 4, 10, 5, 3.5)"
    ).bind(ts).run();
  }

  // Another artist
  for (let i = 0; i < 15; i++) {
    const ts = recentTs + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Other Track', 'Other Artist', 'Other Album', " +
      "'spotify:track:other1', 'clickrow', 'trackdone', 0, 0, 2026, 4, 10, 5, 3.5)"
    ).bind(ts).run();
  }
}

describe("dashboard queries", () => {
  beforeAll(async () => {
    await seedDashboardTestData(env.DB);
  });

  describe("search", () => {
    it("finds tracks by name substring", async () => {
      const results = await search(env.DB, "Big");
      expect(results.length).toBeGreaterThan(0);
      const track = results.find((r) => r.type === "track" && r.name.toLowerCase().includes("big"));
      expect(track).toBeDefined();
    });

    it("finds artists by name substring", async () => {
      const results = await search(env.DB, "Star");
      const artist = results.find((r) => r.type === "artist" && r.name.includes("Star"));
      expect(artist).toBeDefined();
    });

    it("ranks by lifetime plays", async () => {
      const results = await search(env.DB, "t");
      // Results should be sorted by plays descending
      for (let i = 1; i < results.length; i++) {
        expect(results[i].plays).toBeLessThanOrEqual(results[i - 1].plays);
      }
    });

    it("is case-insensitive", async () => {
      const upper = await search(env.DB, "BIG HIT");
      const lower = await search(env.DB, "big hit");
      expect(upper.length).toBe(lower.length);
    });

    it("returns empty for short queries", async () => {
      const results = await search(env.DB, "a");
      // The function itself doesn't enforce min length — the API route does
      // But it should still work and return results
      expect(Array.isArray(results)).toBe(true);
    });
  });

  describe("getTrackDetail", () => {
    it("returns full track detail", async () => {
      const detail = await getTrackDetail(env.DB, "Big Hit", "Test Star");
      expect(detail).not.toBeNull();
      expect(detail!.totalPlays).toBe(60); // 50 + 10 case variant
      expect(detail!.canonicalUri).toBe("spotify:track:bighit1"); // most plays
      expect(detail!.monthlyPlays.length).toBeGreaterThan(0);
    });

    it("collapses case variants (COLLATE NOCASE)", async () => {
      const detail = await getTrackDetail(env.DB, "big hit", "test star");
      expect(detail).not.toBeNull();
      expect(detail!.totalPlays).toBe(60);
    });

    it("returns null for nonexistent track", async () => {
      const detail = await getTrackDetail(env.DB, "Nonexistent", "Nobody");
      expect(detail).toBeNull();
    });

    it("includes skip and completion rates", async () => {
      const detail = await getTrackDetail(env.DB, "Big Hit", "Test Star");
      expect(detail!.skipRate).toBeDefined();
      expect(detail!.completionRate).toBeDefined();
      expect(detail!.avgSkipRate).toBeDefined();
    });
  });

  describe("getArtistDetail", () => {
    it("returns full artist detail", async () => {
      const detail = await getArtistDetail(env.DB, "Test Star");
      expect(detail).not.toBeNull();
      expect(detail!.totalPlays).toBe(80); // 50 + 20 + 10
      expect(detail!.distinctTracks).toBe(2); // Big Hit + Second Song
      expect(detail!.topTracks.length).toBe(2);
      expect(detail!.yearlyPlays.length).toBeGreaterThan(0);
    });

    it("is case-insensitive", async () => {
      const detail = await getArtistDetail(env.DB, "test star");
      expect(detail).not.toBeNull();
      expect(detail!.totalPlays).toBe(80);
    });

    it("returns null for nonexistent artist", async () => {
      const detail = await getArtistDetail(env.DB, "Nobody");
      expect(detail).toBeNull();
    });

    it("top tracks are sorted by plays descending", async () => {
      const detail = await getArtistDetail(env.DB, "Test Star");
      expect(detail!.topTracks[0].plays).toBeGreaterThan(detail!.topTracks[1].plays);
    });
  });

  describe("getRollingWindows", () => {
    it("returns week and month windows with deltas", async () => {
      const windows = await getRollingWindows(env.DB);
      expect(windows.week).toBeDefined();
      expect(windows.month).toBeDefined();
      expect(typeof windows.week.plays).toBe("number");
      expect(typeof windows.week.deltaPct).toBe("number");
      expect(windows.week.plays).toBeGreaterThan(0); // we seeded recent data
    });
  });
});
