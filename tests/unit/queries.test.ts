import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { getTimeMachine, getLostFavorites, getMonthlyTop, getSkipCount, getSkipPenalizedTracks } from "../../src/listening/queries";

// Seed a small test dataset into the D1 plays table
async function seedTestData(db: D1Database) {
  // Create the plays table
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

  // Insert test rows: 2024-03 plays
  const ts2024Mar = Math.floor(new Date("2024-03-15T12:00:00Z").getTime() / 1000);
  const ts2024Mar2 = Math.floor(new Date("2024-03-20T14:00:00Z").getTime() / 1000);
  const ts2022Jan = Math.floor(new Date("2022-01-10T09:00:00Z").getTime() / 1000);

  // A track played many times in 2022, not since — should be a "lost favorite"
  for (let i = 0; i < 25; i++) {
    const t = ts2022Jan + i * 3600;
    await db.prepare(`
      INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name,
        album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline,
        year, month, hour, local_hour, minutes)
      VALUES (?, 'iOS', 210000, 'US', 'Old Favorite', 'Test Artist', 'Test Album',
        'spotify:track:old1', 'clickrow', 'trackdone', 0, 0, 2022, 1, 9, 4, 3.5)
    `).bind(t).run();
  }

  // Recent 2024 plays
  await db.prepare(`
    INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name,
      album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline,
      year, month, hour, local_hour, minutes)
    VALUES (?, 'iOS', 180000, 'US', 'New Song', 'Cool Artist', 'Cool Album',
      'spotify:track:new1', 'clickrow', 'trackdone', 0, 0, 2024, 3, 12, 7, 3.0)
  `).bind(ts2024Mar).run();

  await db.prepare(`
    INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name,
      album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline,
      year, month, hour, local_hour, minutes)
    VALUES (?, 'iOS', 120000, 'US', 'New Song', 'Cool Artist', 'Cool Album',
      'spotify:track:new1', 'clickrow', 'fwdbtn', 0, 0, 2024, 3, 14, 9, 2.0)
  `).bind(ts2024Mar2).run();

  // URI multiplicity: same song, two URIs (original release + re-release)
  // Old URI: 25 plays all in 2022 (qualifies as "lost" at URI level)
  // New URI: 3 recent plays in 2024 (song is NOT lost at song level)
  const ts2022 = Math.floor(new Date("2022-06-15T12:00:00Z").getTime() / 1000);
  for (let i = 0; i < 25; i++) {
    const t = ts2022 + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Multi URI Song', 'Multi Artist', 'Album A', " +
      "'spotify:track:multi_old', 'clickrow', 'trackdone', 0, 0, 2022, 6, 12, 7, 3.5)"
    ).bind(t).run();
  }
  // New URI for same song: recent plays
  const tsRecent = Math.floor(new Date("2024-08-10T14:00:00Z").getTime() / 1000);
  for (let i = 0; i < 3; i++) {
    const t = tsRecent + i * 86400;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Multi URI Song', 'Multi Artist', 'Album B Deluxe', " +
      "'spotify:track:multi_new', 'clickrow', 'trackdone', 0, 0, 2024, 8, 14, 9, 3.5)"
    ).bind(t).run();
  }

  // Title-case drift: same song, same artist, different casing
  // Old casing: "Case Song" with 25 old plays
  // New casing: "case song" with recent plays
  const tsCaseOld = Math.floor(new Date("2021-03-15T12:00:00Z").getTime() / 1000);
  for (let i = 0; i < 25; i++) {
    const t = tsCaseOld + i * 3600;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Case Song', 'Case Artist', 'Album', " +
      "'spotify:track:case_old', 'clickrow', 'trackdone', 0, 0, 2021, 3, 12, 7, 3.5)"
    ).bind(t).run();
  }
  const tsCaseNew = Math.floor(new Date("2026-02-10T14:00:00Z").getTime() / 1000);
  for (let i = 0; i < 5; i++) {
    const t = tsCaseNew + i * 86400;
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'case song', 'Case Artist', 'Album Reissue', " +
      "'spotify:track:case_new', 'clickrow', 'trackdone', 0, 0, 2026, 2, 14, 9, 3.5)"
    ).bind(t).run();
  }

  // Skipped tracks (recent, within 30s = ms_played < 30000)
  const nowTs = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 4; i++) {
    await db.prepare(`
      INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name,
        album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline,
        year, month, hour, local_hour, minutes)
      VALUES (?, 'iOS', 15000, 'US', 'Annoying Track', 'Skip Artist', 'Skip Album',
        'spotify:track:skip1', 'clickrow', 'fwdbtn', 0, 0, 2026, 4, 10, 5, 0.25)
    `).bind(nowTs - i * 86400).run();
  }
}

describe("query helpers", () => {
  beforeAll(async () => {
    await seedTestData(env.DB);
  });

  describe("getTimeMachine", () => {
    it("returns correct shape for a month", async () => {
      const result = await getTimeMachine(env.DB, 2024, 3);
      expect(result.period).toBe("2024-03");
      expect(result.totalPlays).toBe(2);
      expect(result.uniqueTracks).toBe(1);
      expect(result.topTracks).toHaveLength(1);
      expect(result.topTracks[0].track).toBe("New Song");
    });

    it("returns correct shape for a year", async () => {
      const result = await getTimeMachine(env.DB, 2022);
      expect(result.period).toBe("2022");
      expect(result.totalPlays).toBe(50); // 25 Old Favorite + 25 Multi URI Song
    });

    it("returns zeros for empty period", async () => {
      const result = await getTimeMachine(env.DB, 2015);
      expect(result.totalPlays).toBe(0);
      expect(result.topTracks).toHaveLength(0);
    });
  });

  describe("getLostFavorites", () => {
    it("finds tracks with enough plays not heard recently", async () => {
      const result = await getLostFavorites(env.DB, 20, 2, 50);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].track).toBe("Old Favorite");
      expect(result[0].lifetimePlays).toBe(25);
    });

    it("respects min_plays filter", async () => {
      const result = await getLostFavorites(env.DB, 30, 2, 50);
      expect(result).toHaveLength(0);
    });
  });

  describe("getMonthlyTop", () => {
    it("returns top tracks for a month", async () => {
      const result = await getMonthlyTop(env.DB, 2024, 3);
      expect(result).toHaveLength(1);
      expect(result[0].track_name).toBe("New Song");
      expect(result[0].plays).toBe(2);
    });
  });

  describe("getSkipCount", () => {
    it("counts fwdbtn events for a track", async () => {
      const count = await getSkipCount(env.DB, "spotify:track:skip1", 30);
      expect(count).toBe(4);
    });

    it("returns 0 for non-skipped track", async () => {
      const count = await getSkipCount(env.DB, "spotify:track:old1", 30);
      expect(count).toBe(0);
    });
  });

  describe("URI multiplicity — song-level aggregation", () => {
    it("getLostFavorites excludes songs with recent plays on ANY URI", async () => {
      // "Multi URI Song" has 25 old plays on one URI and 3 recent plays on another.
      // At URI level, the old URI qualifies as "lost" (25 plays, last heard 2022).
      // At song level, it does NOT qualify because the new URI was played in 2024.
      const result = await getLostFavorites(env.DB, 20, 2, 100);
      const multiSong = result.find((r) => r.track === "Multi URI Song");
      expect(multiSong, "Multi URI Song should NOT appear as a lost favorite").toBeUndefined();
    });

    it("getTimeMachine aggregates plays across URIs for the same song", async () => {
      // In 2022, "Multi URI Song" only has plays on multi_old.
      // In a combined year, both URIs should sum.
      // Check 2022: should see the song with 25 plays
      const result2022 = await getTimeMachine(env.DB, 2022);
      const multiTrack = result2022.topTracks.find((t) => t.track === "Multi URI Song");
      expect(multiTrack).toBeDefined();
      expect(multiTrack!.plays).toBe(25);
    });

    it("getMonthlyTop aggregates plays across URIs for the same song", async () => {
      const result = await getMonthlyTop(env.DB, 2022, 6);
      const multiTrack = result.find((t) => t.track_name === "Multi URI Song");
      expect(multiTrack).toBeDefined();
      expect(multiTrack!.plays).toBe(25);
    });

    it("getLostFavorites collapses title-case drift (COLLATE NOCASE)", async () => {
      // "Case Song" (25 old plays) and "case song" (5 recent plays) are the same song.
      // Should NOT appear as a lost favorite because "case song" has recent plays.
      const result = await getLostFavorites(env.DB, 20, 2, 100);
      const caseSong = result.find((r) =>
        r.track.toLowerCase() === "case song"
      );
      expect(caseSong, "'Case Song' should NOT appear as lost — 'case song' has recent plays").toBeUndefined();
    });
  });

  describe("getSkipPenalizedTracks", () => {
    it("returns URIs with enough recent skips", async () => {
      const penalized = await getSkipPenalizedTracks(env.DB, 3, 30);
      expect(penalized.has("spotify:track:skip1")).toBe(true);
    });

    it("excludes tracks below threshold", async () => {
      const penalized = await getSkipPenalizedTracks(env.DB, 5, 30);
      expect(penalized.has("spotify:track:skip1")).toBe(false);
    });
  });
});
