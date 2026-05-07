import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { getTimeMachine, getLostFavorites, getMonthlyTop, getSkipCount, getSkipPenalizedTracks, getOnThisDay, getDateRange } from "../../src/listening/queries";

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

  // On-this-day test data: plays on July 4 across multiple years
  // Use noon UTC = 7am ET — safely on the same date in Eastern time
  const july4_2020 = Math.floor(new Date("2020-07-04T17:00:00Z").getTime() / 1000); // noon ET
  const july4_2021 = Math.floor(new Date("2021-07-04T17:00:00Z").getTime() / 1000);
  const july4_2023 = Math.floor(new Date("2023-07-04T17:00:00Z").getTime() / 1000);

  // "Firework" by Katy Perry — 3 plays in 2020, 2 in 2021, 1 in 2023 on July 4
  for (let i = 0; i < 3; i++) {
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Firework', 'Katy Perry', 'Teenage Dream', " +
      "'spotify:track:firework1', 'clickrow', 'trackdone', 0, 0, 2020, 7, 17, 12, 3.5)"
    ).bind(july4_2020 + i * 3600).run();
  }
  for (let i = 0; i < 2; i++) {
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Firework', 'Katy Perry', 'Teenage Dream', " +
      "'spotify:track:firework1', 'clickrow', 'trackdone', 0, 0, 2021, 7, 17, 12, 3.5)"
    ).bind(july4_2021 + i * 3600).run();
  }
  // Same song, different URI (re-release) in 2023
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 210000, 'US', 'Firework', 'Katy Perry', 'Teenage Dream Complete', " +
    "'spotify:track:firework2', 'clickrow', 'trackdone', 0, 0, 2023, 7, 17, 12, 3.5)"
  ).bind(july4_2023).run();

  // "Party in the USA" — 1 play on July 4, 2021 only
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 195000, 'US', 'Party in the USA', 'Miley Cyrus', 'Breakout', " +
    "'spotify:track:partyusa', 'clickrow', 'trackdone', 0, 0, 2021, 7, 17, 12, 3.25)"
  ).bind(july4_2021 + 7200).run();

  // A play on July 3 (should NOT appear in July 4 results)
  // Use 4am UTC = 11pm ET July 3
  const july3_late = Math.floor(new Date("2020-07-04T04:00:00Z").getTime() / 1000); // 11pm ET July 3
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 200000, 'US', 'Wrong Day Song', 'Wrong Artist', 'Wrong Album', " +
    "'spotify:track:wrongday', 'clickrow', 'trackdone', 0, 0, 2020, 7, 4, 23, 3.3)"
  ).bind(july3_late).run();

  // --- date_range test data ---
  // Three distinct Eastern-time dates: 2023-12-01, 2023-12-02, 2023-12-03
  // (no plays on 2023-12-02 to test zero-play day)

  // Dec 1, 2023: noon ET = 17:00 UTC — "Winter Song" by DR Artist (2 plays), "Snow" by DR Artist (1 play)
  const dec1_noon = Math.floor(new Date("2023-12-01T17:00:00Z").getTime() / 1000);
  for (let i = 0; i < 2; i++) {
    await db.prepare(
      "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
      "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
      "year, month, hour, local_hour, minutes) " +
      "VALUES (?, 'iOS', 210000, 'US', 'Winter Song', 'DR Artist', 'DR Album', " +
      "'spotify:track:dr_winter1', 'clickrow', 'trackdone', 0, 0, 2023, 12, 17, 12, 3.5)"
    ).bind(dec1_noon + i * 3600).run();
  }
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 180000, 'US', 'Snow', 'DR Artist', 'DR Album', " +
    "'spotify:track:dr_snow', 'clickrow', 'trackdone', 0, 0, 2023, 12, 17, 12, 3.0)"
  ).bind(dec1_noon + 7200).run();

  // Dec 3, 2023: "Winter Song" by DR Artist (1 play via different URI — re-release)
  const dec3_noon = Math.floor(new Date("2023-12-03T17:00:00Z").getTime() / 1000);
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 210000, 'US', 'Winter Song', 'DR Artist', 'DR Album Deluxe', " +
    "'spotify:track:dr_winter2', 'clickrow', 'trackdone', 0, 0, 2023, 12, 17, 12, 3.5)"
  ).bind(dec3_noon).run();

  // Eastern-time boundary test: 4am UTC Dec 2 = 11pm ET Dec 1
  const dec2_4amUTC = Math.floor(new Date("2023-12-02T04:00:00Z").getTime() / 1000);
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 200000, 'US', 'Late Night', 'DR Artist', 'DR Album', " +
    "'spotify:track:dr_late', 'clickrow', 'trackdone', 0, 0, 2023, 12, 4, 23, 3.3)"
  ).bind(dec2_4amUTC).run();
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

  describe("getOnThisDay", () => {
    it("returns plays from multiple years on the same MM-DD", async () => {
      const result = await getOnThisDay(env.DB, 7, 4);
      expect(result.source).toBe("local_history");
      expect(result.date).toBe("07-04");
      expect(result.yearsCovered).toContain(2020);
      expect(result.yearsCovered).toContain(2021);
      expect(result.yearsCovered).toContain(2023);
      expect(result.totalPlaysAcrossYears).toBe(7); // 3+2+1 firework + 1 party
    });

    it("excludes plays from other dates (Eastern time boundary)", async () => {
      // "Wrong Day Song" is at 4am UTC July 4 = 11pm ET July 3 — should NOT appear
      const result = await getOnThisDay(env.DB, 7, 4);
      const wrongDay = result.topTracks.find(t => t.track === "Wrong Day Song");
      expect(wrongDay, "Play at 11pm ET July 3 should not appear in July 4 results").toBeUndefined();
    });

    it("aggregates at song level, collapsing URIs", async () => {
      const result = await getOnThisDay(env.DB, 7, 4);
      // "Firework" has plays on firework1 (5 plays) and firework2 (1 play) = 6 total
      const firework = result.topTracks.find(t => t.track === "Firework");
      expect(firework).toBeDefined();
      expect(firework!.totalPlays).toBe(6);
    });

    it("canonical URI is the most-played one", async () => {
      const result = await getOnThisDay(env.DB, 7, 4);
      const firework = result.topTracks.find(t => t.track === "Firework");
      expect(firework).toBeDefined();
      // firework1 has 5 plays total (3 in 2020 + 2 in 2021), firework2 has 1
      expect(firework!.uri).toBe("spotify:track:firework1");
    });

    it("peakYear and yearsPlayed are correct for a multi-year track", async () => {
      const result = await getOnThisDay(env.DB, 7, 4);
      const firework = result.topTracks.find(t => t.track === "Firework");
      expect(firework).toBeDefined();
      expect(firework!.peakYear).toBe(2020); // 3 plays in 2020
      expect(firework!.peakYearPlays).toBe(3);
      expect(firework!.yearsPlayed).toEqual([2020, 2021, 2023]);
    });

    it("returns correct shape for a date with no plays", async () => {
      const result = await getOnThisDay(env.DB, 12, 25); // Christmas — no seed data
      expect(result.source).toBe("local_history");
      expect(result.date).toBe("12-25");
      expect(result.yearsCovered).toEqual([]);
      expect(result.totalPlaysAcrossYears).toBe(0);
      expect(result.totalHoursAcrossYears).toBe(0);
      expect(result.uniqueTracks).toBe(0);
      expect(result.uniqueArtists).toBe(0);
      expect(result.topTracks).toEqual([]);
    });

    it("respects the limit parameter", async () => {
      const result = await getOnThisDay(env.DB, 7, 4, 1);
      expect(result.topTracks).toHaveLength(1);
      expect(result.topTracks[0].track).toBe("Firework"); // most plays
    });
  });

  describe("getDateRange", () => {
    it("single day — start == end returns plays for only that day", async () => {
      const result = await getDateRange(env.DB, "2023-12-01", "2023-12-01");
      expect(result.source).toBe("local_history");
      expect(result.startDate).toBe("2023-12-01");
      expect(result.endDate).toBe("2023-12-01");
      expect(result.daysInRange).toBe(1);
      expect(result.daily).toHaveLength(1);
      // 2 "Winter Song" + 1 "Snow" + 1 "Late Night" (11pm ET Dec 1) = 4
      expect(result.totalPlays).toBe(4);
      expect(result.daysWithPlays).toBe(1);
    });

    it("multi-day range — three-day window returns aggregated totals and daily array", async () => {
      const result = await getDateRange(env.DB, "2023-12-01", "2023-12-03");
      expect(result.daysInRange).toBe(3);
      expect(result.daily).toHaveLength(3);
      // Dec 1: 4 plays, Dec 2: 0 plays, Dec 3: 1 play = 5 total
      expect(result.totalPlays).toBe(5);
      expect(result.daysWithPlays).toBe(2);
    });

    it("zero-play day inside range — daily array still includes it", async () => {
      const result = await getDateRange(env.DB, "2023-12-01", "2023-12-03");
      const dec2 = result.daily.find(d => d.date === "2023-12-02");
      expect(dec2).toBeDefined();
      expect(dec2!.plays).toBe(0);
      expect(dec2!.topTrack).toBeNull();
    });

    it("Eastern-time boundary — 4am UTC Dec 2 = 11pm ET Dec 1 is bucketed into Dec 1", async () => {
      // "Late Night" at 4am UTC Dec 2 = 11pm ET Dec 1 should appear in Dec 1, not Dec 2
      const resultDec1 = await getDateRange(env.DB, "2023-12-01", "2023-12-01");
      const resultDec2 = await getDateRange(env.DB, "2023-12-02", "2023-12-02");
      // Dec 1 should have the "Late Night" play
      expect(resultDec1.totalPlays).toBe(4); // 2 Winter + 1 Snow + 1 Late Night
      // Dec 2 should have zero plays
      expect(resultDec2.totalPlays).toBe(0);
    });

    it("song-level aggregation — multiple URIs collapse into one row", async () => {
      // "Winter Song" has plays on dr_winter1 (Dec 1, 2 plays) and dr_winter2 (Dec 3, 1 play)
      const result = await getDateRange(env.DB, "2023-12-01", "2023-12-03");
      const winterSong = result.topTracks.find(t => t.track === "Winter Song");
      expect(winterSong).toBeDefined();
      expect(winterSong!.plays).toBe(3); // 2 + 1 collapsed
    });

    it("canonical URI is most-played within the range", async () => {
      // dr_winter1 has 2 plays in range, dr_winter2 has 1 play
      const result = await getDateRange(env.DB, "2023-12-01", "2023-12-03");
      const winterSong = result.topTracks.find(t => t.track === "Winter Song");
      expect(winterSong).toBeDefined();
      expect(winterSong!.uri).toBe("spotify:track:dr_winter1");
    });

    it("clamping below dataset — effectiveStartDate set to dataset minimum", async () => {
      const result = await getDateRange(env.DB, "1990-01-01", "2023-12-03");
      expect(result.startDate).toBe("1990-01-01"); // echoed back unchanged
      // effectiveStartDate should be the earliest play in the dataset (not 1990)
      expect(result.effectiveStartDate > "1990-01-01").toBe(true);
    });

    it("range entirely outside dataset — zeroed counters, empty arrays", async () => {
      const result = await getDateRange(env.DB, "1990-01-01", "1990-12-31");
      expect(result.startDate).toBe("1990-01-01");
      expect(result.endDate).toBe("1990-12-31");
      expect(result.daysInRange).toBe(0);
      expect(result.totalPlays).toBe(0);
      expect(result.topTracks).toEqual([]);
      expect(result.topArtists).toEqual([]);
      expect(result.daily).toEqual([]);
    });

    it("invalid date format — throws error", async () => {
      await expect(getDateRange(env.DB, "2024/07/04", "2024/07/04")).rejects.toThrow("Invalid start_date format");
      await expect(getDateRange(env.DB, "July 4 2024", "July 4 2024")).rejects.toThrow("Invalid start_date format");
    });

    it("inverted range — start_date > end_date throws error", async () => {
      await expect(getDateRange(env.DB, "2024-07-04", "2024-07-01")).rejects.toThrow("start_date");
    });

    it("limit parameter — limit:1 returns exactly one entry in topTracks", async () => {
      const result = await getDateRange(env.DB, "2023-12-01", "2023-12-03", 1);
      expect(result.topTracks).toHaveLength(1);
      expect(result.topArtists).toHaveLength(1);
    });
  });
});
