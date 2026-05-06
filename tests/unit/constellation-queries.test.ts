import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import {
  buildNodes, buildEdges, buildStats, computeReflectionBuckets, reflectionIndexFor, reflectionLabel,
  computeEdgeWeights, pairKey,
  MIN_PLAYS, SESSION_THRESHOLD, SEASONAL_PLAYLIST_BONUS, PLAYLIST_WEIGHT,
} from "../../src/constellation/queries";

const PLAYS_DDL =
  "CREATE TABLE IF NOT EXISTS plays (" +
  "id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, platform TEXT NOT NULL, " +
  "ms_played INTEGER NOT NULL, conn_country TEXT NOT NULL, track_name TEXT NOT NULL, " +
  "artist_name TEXT NOT NULL, album_name TEXT NOT NULL, spotify_track_uri TEXT NOT NULL, " +
  "reason_start TEXT NOT NULL DEFAULT '', reason_end TEXT NOT NULL DEFAULT '', " +
  "shuffle INTEGER NOT NULL DEFAULT 0, offline INTEGER NOT NULL DEFAULT 0, " +
  "year INTEGER NOT NULL, month INTEGER NOT NULL, hour INTEGER NOT NULL, " +
  "local_hour INTEGER NOT NULL, minutes REAL NOT NULL);";

const PLAYLIST_TRACKS_DDL =
  "CREATE TABLE IF NOT EXISTS playlist_tracks (" +
  "playlist_id TEXT NOT NULL, track_id TEXT NOT NULL, " +
  "track_name TEXT NOT NULL, artist_name TEXT NOT NULL, " +
  "position INTEGER, synced_at INTEGER NOT NULL, " +
  "PRIMARY KEY (playlist_id, track_id));";

const SEASONAL_DDL =
  "CREATE TABLE IF NOT EXISTS seasonal_playlists (" +
  "id INTEGER PRIMARY KEY, spotify_playlist_id TEXT UNIQUE NOT NULL, " +
  "name TEXT NOT NULL, season TEXT NOT NULL, year INTEGER NOT NULL, " +
  "is_current INTEGER DEFAULT 0, last_synced_at INTEGER);";

const ARTIST_TASTE_DDL =
  "CREATE TABLE IF NOT EXISTS artist_taste (" +
  "artist_id TEXT PRIMARY KEY, artist_name TEXT NOT NULL, " +
  "in_top_artists_short INTEGER DEFAULT 0, in_top_artists_medium INTEGER DEFAULT 0, " +
  "in_top_artists_long INTEGER DEFAULT 0, is_followed INTEGER DEFAULT 0, " +
  "total_plays INTEGER DEFAULT 0, unique_tracks_played INTEGER DEFAULT 0, " +
  "taste_score REAL, refreshed_at INTEGER NOT NULL);";

async function resetTables(db: D1Database) {
  await db.exec("DROP TABLE IF EXISTS plays;");
  await db.exec("DROP TABLE IF EXISTS playlist_tracks;");
  await db.exec("DROP TABLE IF EXISTS seasonal_playlists;");
  await db.exec("DROP TABLE IF EXISTS artist_taste;");
  await db.exec(PLAYS_DDL);
  await db.exec(PLAYLIST_TRACKS_DDL);
  await db.exec(SEASONAL_DDL);
  await db.exec(ARTIST_TASTE_DDL);
}

async function insertPlay(
  db: D1Database,
  artist: string,
  ts: number,
  uri: string = "spotify:track:" + Math.random().toString(36).slice(2),
  year: number = new Date(ts * 1000).getUTCFullYear(),
) {
  await db.prepare(
    "INSERT INTO plays (ts, platform, ms_played, conn_country, track_name, artist_name, " +
    "album_name, spotify_track_uri, reason_start, reason_end, shuffle, offline, " +
    "year, month, hour, local_hour, minutes) " +
    "VALUES (?, 'iOS', 200000, 'US', 'T', ?, 'A', ?, '', 'trackdone', 0, 0, ?, 1, 12, 7, 3.3)"
  ).bind(ts, artist, uri, year).run();
}

async function insertPlaylistTrack(
  db: D1Database,
  playlistId: string,
  trackId: string,
  artist: string,
  pos: number = 0,
) {
  await db.prepare(
    "INSERT OR REPLACE INTO playlist_tracks " +
    "(playlist_id, track_id, track_name, artist_name, position, synced_at) " +
    "VALUES (?, ?, 'T', ?, ?, 0)"
  ).bind(playlistId, trackId, artist, pos).run();
}

describe("constellation queries — node phase", () => {
  beforeAll(async () => {
    await resetTables(env.DB);
  });

  it(`filters artists below the ${MIN_PLAYS}-play floor`, async () => {
    await resetTables(env.DB);
    const above = MIN_PLAYS + 2;
    const below = MIN_PLAYS - 1;
    // above threshold — passes
    for (let i = 0; i < above; i++) {
      await insertPlay(env.DB, "Heavy", 1_700_000_000 + i * 60);
    }
    // below threshold — drops
    for (let i = 0; i < below; i++) {
      await insertPlay(env.DB, "Light", 1_700_000_000 + i * 60);
    }

    const nodes = await buildNodes(env.DB);
    const names = nodes.map(n => n.artist_name).sort();
    expect(names).toEqual(["Heavy"]);
    expect(nodes[0].total_plays).toBe(above);
  });

  it("computes peak_year as the year with the most plays for that artist", async () => {
    await resetTables(env.DB);
    // More plays in 2018 than 2019 — peak should be 2018
    const ts18 = Math.floor(new Date("2018-06-15T12:00:00Z").getTime() / 1000);
    const ts19 = Math.floor(new Date("2019-06-15T12:00:00Z").getTime() / 1000);
    const majorYear = MIN_PLAYS;
    const minorYear = 10;
    for (let i = 0; i < majorYear; i++) {
      await insertPlay(env.DB, "Peaks", ts18 + i * 60, "u" + i, 2018);
    }
    for (let i = 0; i < minorYear; i++) {
      await insertPlay(env.DB, "Peaks", ts19 + i * 60, "v" + i, 2019);
    }

    const nodes = await buildNodes(env.DB);
    const peaks = nodes.find(n => n.artist_name === "Peaks");
    expect(peaks).toBeDefined();
    expect(peaks!.peak_year).toBe(2018);
  });

  it("years_active counts only years with ≥5 plays", async () => {
    await resetTables(env.DB);
    // Spread plays across 3 years, with enough total to pass MIN_PLAYS.
    // Half+5 in 2017, half+5 in 2019 (both ≥5 → active), 4 in 2020 (<5 → not active)
    const half = Math.ceil(MIN_PLAYS / 2) + 5;
    const years: Array<[number, number]> = [[2017, half], [2019, half], [2020, 4]];
    let uri = 0;
    for (const [y, n] of years) {
      const ts = Math.floor(new Date(`${y}-06-15T12:00:00Z`).getTime() / 1000);
      for (let i = 0; i < n; i++) {
        await insertPlay(env.DB, "Long", ts + i * 60, "u" + (uri++), y);
      }
    }

    const nodes = await buildNodes(env.DB);
    const long = nodes.find(n => n.artist_name === "Long");
    expect(long).toBeDefined();
    expect(long!.years_active).toBe(2);
    expect(long!.total_plays).toBe(half * 2 + 4);
  });
});

describe("constellation queries — edges + weights", () => {
  it("applies the ≥3 session threshold", () => {
    const sessionCounts = new Map<string, number>([
      [pairKey("A", "B"), 5],   // keeps
      [pairKey("A", "C"), 2],   // drops
      [pairKey("B", "D"), 3],   // keeps (boundary)
    ]);
    const playlistCounts = new Map();
    const edges = computeEdgeWeights(sessionCounts, playlistCounts);
    const pairs = edges.map(e => `${e.artist_a}|${e.artist_b}`).sort();
    expect(pairs).toEqual(["A|B", "B|D"]);
  });

  it("collapses to log(session_co) when no playlist signal exists", () => {
    const sessionCounts = new Map<string, number>([[pairKey("A", "B"), 5]]);
    const edges = computeEdgeWeights(sessionCounts, new Map());
    expect(edges).toHaveLength(1);
    expect(edges[0].weight).toBeCloseTo(Math.log(5));
  });

  it("applies the seasonal 1.5× bonus on top of the playlist term", () => {
    const sessionCounts = new Map<string, number>([[pairKey("A", "B"), 5]]);
    // 2 seasonal + 1 non-seasonal co-occurrences → weighted = 2*1.5 + 1 = 4
    const playlistCounts = new Map([
      [pairKey("A", "B"), { total: 3, seasonal: 2 }],
    ]);
    const edges = computeEdgeWeights(sessionCounts, playlistCounts);
    expect(edges).toHaveLength(1);
    const expected = Math.log(5) + PLAYLIST_WEIGHT * Math.log(2 * SEASONAL_PLAYLIST_BONUS + 1 + 1);
    expect(edges[0].weight).toBeCloseTo(expected);
    expect(edges[0].playlist_co).toBeCloseTo(4);
  });

  it("end-to-end: builds edges from synthetic plays + playlists", async () => {
    await resetTables(env.DB);
    // A and B co-occur in enough windows to pass MIN_PLAYS; C is a noise drop-in.
    const baseTs = Math.floor(new Date("2020-01-01T12:00:00Z").getTime() / 1000);
    let uri = 0;
    const sessions = Math.ceil(MIN_PLAYS / 4) + 5;
    for (let s = 0; s < sessions; s++) {
      const t0 = baseTs + s * 86400;
      // Pad each artist past the MIN_PLAYS floor.
      for (let i = 0; i < 5; i++) {
        await insertPlay(env.DB, "ArtistA", t0 + i * 120, "u" + uri++, 2020);
      }
      for (let i = 0; i < 5; i++) {
        await insertPlay(env.DB, "ArtistB", t0 + 60 + i * 120, "u" + uri++, 2020);
      }
    }
    // ArtistC: MIN_PLAYS plays well outside any A/B window → no co-occurrence.
    for (let i = 0; i < MIN_PLAYS; i++) {
      await insertPlay(env.DB, "ArtistC", baseTs + i * 86400 * 30 + 100000, "u" + uri++, 2020);
    }

    const nodes = await buildNodes(env.DB);
    const nodeArtists = new Set(nodes.map(n => n.artist_name));
    expect(nodeArtists.has("ArtistA")).toBe(true);
    expect(nodeArtists.has("ArtistB")).toBe(true);

    const edges = await buildEdges(env.DB, nodeArtists);
    const ab = edges.find(e =>
      (e.artist_a === "ArtistA" && e.artist_b === "ArtistB")
      || (e.artist_a === "ArtistB" && e.artist_b === "ArtistA")
    );
    expect(ab).toBeDefined();
    expect(ab!.session_co).toBeGreaterThanOrEqual(SESSION_THRESHOLD);
    // No A-C or B-C edge should pass the threshold.
    const acOrBc = edges.find(e =>
      e.artist_a === "ArtistC" || e.artist_b === "ArtistC"
    );
    expect(acOrBc).toBeUndefined();
  });
});

describe("constellation queries — reflection buckets", () => {
  it("splits 100 evenly-spread peak years into roughly equal-population quintiles", () => {
    // 100 years from 2011..2025 with 20 each (uneven enough to test).
    const years: number[] = [];
    for (let y = 2011; y <= 2025; y++) {
      const reps = y >= 2018 ? 10 : 5;
      for (let i = 0; i < reps; i++) years.push(y);
    }
    const buckets = computeReflectionBuckets(years);
    expect(buckets).toHaveLength(5);
    expect(buckets[0].start_year).toBe(2011);
    expect(buckets[buckets.length - 1].end_year).toBe(2025);
    // Buckets are monotonic and non-overlapping.
    for (let i = 1; i < buckets.length; i++) {
      expect(buckets[i].start_year).toBeGreaterThan(buckets[i - 1].end_year);
    }
  });

  it("handles the degenerate single-year case", () => {
    const buckets = computeReflectionBuckets([2020, 2020, 2020]);
    expect(buckets).toHaveLength(5);
    // The first and last bucket both cover the same single year.
    expect(buckets[0].start_year).toBe(2020);
    expect(buckets[buckets.length - 1].end_year).toBeGreaterThanOrEqual(2020);
  });

  it("reflectionIndexFor maps a year to its bucket", () => {
    const buckets = [
      { start_year: 2011, end_year: 2014 },
      { start_year: 2015, end_year: 2017 },
      { start_year: 2018, end_year: 2020 },
      { start_year: 2021, end_year: 2023 },
      { start_year: 2024, end_year: 2026 },
    ];
    expect(reflectionIndexFor(2012, buckets)).toBe(0);
    expect(reflectionIndexFor(2017, buckets)).toBe(1);
    expect(reflectionIndexFor(2020, buckets)).toBe(2);
    expect(reflectionIndexFor(2023, buckets)).toBe(3);
    expect(reflectionIndexFor(2025, buckets)).toBe(4);
  });

  it("reflectionLabel renders the latest bucket as 'YYYY–now'", () => {
    expect(reflectionLabel({ start_year: 2024, end_year: 2026 }, true)).toBe("2024–now");
    expect(reflectionLabel({ start_year: 2011, end_year: 2014 }, false)).toBe("2011–2014");
    expect(reflectionLabel({ start_year: 2020, end_year: 2020 }, false)).toBe("2020");
  });
});

describe("constellation queries — artist-id resolution", () => {
  it("marks resolved / ambiguous / unresolved artists distinctly", async () => {
    await resetTables(env.DB);
    // MIN_PLAYS + 2 plays each across three artists, all in 2020.
    const ts = Math.floor(new Date("2020-06-15T12:00:00Z").getTime() / 1000);
    let uri = 0;
    const playCount = MIN_PLAYS + 2;
    for (const name of ["Resolved", "Ambiguous", "Unresolved"]) {
      for (let i = 0; i < playCount; i++) {
        await insertPlay(env.DB, name, ts + i * 60, "u" + uri++, 2020);
      }
    }
    // artist_taste: Resolved → exactly one id, Ambiguous → two distinct ids,
    // Unresolved → no row at all.
    await env.DB.prepare(
      "INSERT INTO artist_taste (artist_id, artist_name, refreshed_at) VALUES ('rid_1', 'Resolved', 0)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO artist_taste (artist_id, artist_name, refreshed_at) VALUES ('aid_1', 'Ambiguous', 0)"
    ).run();
    await env.DB.prepare(
      "INSERT INTO artist_taste (artist_id, artist_name, refreshed_at) VALUES ('aid_2', 'Ambiguous', 0)"
    ).run();

    const nodes = await buildNodes(env.DB);
    const byName = new Map(nodes.map(n => [n.artist_name, n]));
    expect(byName.get("Resolved")!.artist_id).toEqual({ kind: "resolved", id: "rid_1" });
    expect(byName.get("Ambiguous")!.artist_id).toEqual({ kind: "ambiguous" });
    expect(byName.get("Unresolved")!.artist_id).toEqual({ kind: "unresolved" });
  });
});

describe("constellation queries — stats", () => {
  it("total_tracks counts distinct URIs, not total plays", async () => {
    await resetTables(env.DB);
    const ts = Math.floor(new Date("2020-06-15T12:00:00Z").getTime() / 1000);
    const trackA = "spotify:track:aaa";
    const trackB = "spotify:track:bbb";
    // 3 plays of track A, 2 plays of track B → 5 rows but only 2 distinct URIs.
    await insertPlay(env.DB, "Artist", ts + 0,   trackA, 2020);
    await insertPlay(env.DB, "Artist", ts + 60,  trackA, 2020);
    await insertPlay(env.DB, "Artist", ts + 120, trackA, 2020);
    await insertPlay(env.DB, "Artist", ts + 180, trackB, 2020);
    await insertPlay(env.DB, "Artist", ts + 240, trackB, 2020);

    const stats = await buildStats(env.DB);
    expect(stats.total_tracks).toBe(2);
    expect(stats.total_plays).toBe(5);
  });
});

describe("constellation queries — playlist co-occurrence", () => {
  it("counts seasonal vs non-seasonal playlist co-occurrence separately", async () => {
    await resetTables(env.DB);
    // A and B co-appear on 1 seasonal playlist + 1 non-seasonal.
    await env.DB.prepare(
      "INSERT INTO seasonal_playlists (spotify_playlist_id, name, season, year) " +
      "VALUES ('pl_seasonal', 'Spring 2020', 'spring', 2020)"
    ).run();
    await insertPlaylistTrack(env.DB, "pl_seasonal", "t1", "A", 0);
    await insertPlaylistTrack(env.DB, "pl_seasonal", "t2", "B", 1);
    await insertPlaylistTrack(env.DB, "pl_other", "t3", "A", 0);
    await insertPlaylistTrack(env.DB, "pl_other", "t4", "B", 1);
    // Pad A and B past the MIN_PLAYS floor so they're nodes.
    const ts = Math.floor(new Date("2020-01-01T12:00:00Z").getTime() / 1000);
    for (let i = 0; i < MIN_PLAYS + 2; i++) {
      await insertPlay(env.DB, "A", ts + i * 60, "uA" + i, 2020);
      await insertPlay(env.DB, "B", ts + i * 60 + 30, "uB" + i, 2020);
    }

    const nodes = await buildNodes(env.DB);
    const nodeArtists = new Set(nodes.map(n => n.artist_name));
    const edges = await buildEdges(env.DB, nodeArtists);
    const ab = edges.find(e =>
      (e.artist_a === "A" && e.artist_b === "B") || (e.artist_a === "B" && e.artist_b === "A")
    );
    expect(ab).toBeDefined();
    // playlist_co_weighted = 1 seasonal × 1.5 + 1 non-seasonal = 2.5
    expect(ab!.playlist_co).toBeCloseTo(2.5);
  });
});

describe("constellation queries — top track per artist", () => {
  it("picks the most-played track for an artist", async () => {
    await resetTables(env.DB);
    const ts = Math.floor(new Date("2020-06-15T12:00:00Z").getTime() / 1000);
    const winner = "spotify:track:winner";
    const loser = "spotify:track:loser";
    // 200 plays of winner, 100 of loser → winner has higher count.
    for (let i = 0; i < 200; i++) {
      await insertPlay(env.DB, "TopTrackArtist", ts + i * 60, winner, 2020);
    }
    for (let i = 0; i < 100; i++) {
      await insertPlay(env.DB, "TopTrackArtist", ts + (200 + i) * 60, loser, 2020);
    }

    const nodes = await buildNodes(env.DB);
    const node = nodes.find(n => n.artist_name === "TopTrackArtist");
    expect(node).toBeDefined();
    expect(node!.top_track_id).toBe("winner");
  });

  it("tie-breaks by most recent play when counts are equal", async () => {
    await resetTables(env.DB);
    const ts = Math.floor(new Date("2020-06-15T12:00:00Z").getTime() / 1000);
    const older = "spotify:track:older";
    const newer = "spotify:track:newer";
    const half = Math.ceil(MIN_PLAYS / 2);
    // Equal play counts, but "newer" has the most recent play.
    for (let i = 0; i < half; i++) {
      await insertPlay(env.DB, "TieArtist", ts + i * 60, older, 2020);
    }
    for (let i = 0; i < half; i++) {
      await insertPlay(env.DB, "TieArtist", ts + (half + i) * 60, newer, 2020);
    }

    const nodes = await buildNodes(env.DB);
    const node = nodes.find(n => n.artist_name === "TieArtist");
    expect(node).toBeDefined();
    expect(node!.top_track_id).toBe("newer");
  });

  it("returns null when all track URIs are empty", async () => {
    await resetTables(env.DB);
    const ts = Math.floor(new Date("2020-06-15T12:00:00Z").getTime() / 1000);
    for (let i = 0; i < MIN_PLAYS; i++) {
      await insertPlay(env.DB, "NullArtist", ts + i * 60, "", 2020);
    }

    const nodes = await buildNodes(env.DB);
    const node = nodes.find(n => n.artist_name === "NullArtist");
    expect(node).toBeDefined();
    expect(node!.top_track_id).toBeNull();
  });

  it("ignores empty URIs and picks from non-empty ones", async () => {
    await resetTables(env.DB);
    const ts = Math.floor(new Date("2020-06-15T12:00:00Z").getTime() / 1000);
    const valid = "spotify:track:validone";
    // Most plays have empty URI; a few have a real one.
    for (let i = 0; i < MIN_PLAYS - 10; i++) {
      await insertPlay(env.DB, "MixArtist", ts + i * 60, "", 2020);
    }
    for (let i = 0; i < 10; i++) {
      await insertPlay(env.DB, "MixArtist", ts + (MIN_PLAYS - 10 + i) * 60, valid, 2020);
    }

    const nodes = await buildNodes(env.DB);
    const node = nodes.find(n => n.artist_name === "MixArtist");
    expect(node).toBeDefined();
    expect(node!.top_track_id).toBe("validone");
  });
});
