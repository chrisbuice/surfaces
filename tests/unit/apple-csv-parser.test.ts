import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  parsePlayActivity,
  buildDailyTracksLookup,
  buildArtistRecoveryLookup,
  buildAlbumLookup,
  recoverAppleTrackId,
  makeCacheKey,
  HeaderMismatchError,
  type PlayActivityRow,
} from "../../scripts/lib/apple-csv-parser";

const FIXTURES = resolve(__dirname, "../fixtures/apple-music");

describe("parsePlayActivity", () => {
  it("applies Option B filter correctly", async () => {
    const rows: PlayActivityRow[] = [];
    for await (const row of parsePlayActivity(`${FIXTURES}/play-activity.csv`)) {
      rows.push(row);
    }

    // Should include:
    // 1. Dreams — NATURAL_END_OF_TRACK (245s, passes both criteria)
    // 2. Anti-Hero — TRACK_SKIPPED_FORWARDS but 35s >= 30s threshold
    // 3. TEXAS HOLD 'EM — NATURAL_END_OF_TRACK (200s)
    // Should exclude:
    // - Video Games — skip + only 10s (< 30s and not natural end)
    // - LYRIC_DISPLAY — wrong event type
    // - Podcast — wrong media type (PODCAST, not AUDIO)
    // - Quick Skip — skip + only 5s
    expect(rows).toHaveLength(3);
    expect(rows[0].songName).toBe("Dreams");
    expect(rows[1].songName).toBe("Anti-Hero");
    expect(rows[2].songName).toBe("TEXAS HOLD 'EM");
  });

  it("parses fields correctly", async () => {
    const rows: PlayActivityRow[] = [];
    for await (const row of parsePlayActivity(`${FIXTURES}/play-activity.csv`)) {
      rows.push(row);
    }

    const dreams = rows[0];
    expect(dreams.artistName).toBe("Fleetwood Mac");
    expect(dreams.albumName).toBe("Rumours");
    expect(dreams.playDurationMs).toBe(245000);
    expect(dreams.endReasonType).toBe("NATURAL_END_OF_TRACK");
    expect(dreams.eventEndTimestamp).toBe("2023-07-15T14:30:00Z");
    expect(dreams.shuffle).toBe(false);
    expect(dreams.offline).toBe(false);

    expect(dreams.deviceType).toBe("iPhone14");

    const texas = rows[2];
    expect(texas.shuffle).toBe(true);
    expect(texas.offline).toBe(true);
  });

  it("throws HeaderMismatchError on bad headers", async () => {
    // Create a temp CSV with wrong headers
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpPath = `${FIXTURES}/bad-headers.csv`;
    writeFileSync(tmpPath, "Wrong Column,Another Bad Column\nval1,val2\n");
    try {
      const rows: PlayActivityRow[] = [];
      await expect(async () => {
        for await (const row of parsePlayActivity(tmpPath)) {
          rows.push(row);
        }
      }).rejects.toThrow(HeaderMismatchError);
    } finally {
      unlinkSync(tmpPath);
    }
  });
});

describe("parsePlayActivity — real header validation", () => {
  it("accepts the real Apple Music Play Activity CSV header", async () => {
    // play-activity-real-header.csv contains the actual 176-column header
    // from Apple's export. The parser should accept it without throwing,
    // even though it only uses ~10 of those columns.
    const rows: PlayActivityRow[] = [];
    // No data rows — just validates the header doesn't throw
    for await (const row of parsePlayActivity(`${FIXTURES}/play-activity-real-header.csv`)) {
      rows.push(row);
    }
    // No data rows in the fixture, so no results — but no HeaderMismatchError either
    expect(rows).toHaveLength(0);
  });
});

describe("buildDailyTracksLookup", () => {
  it("builds lookup keyed by date+song_lower", async () => {
    const map = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);

    // "Fleetwood Mac - Dreams" → song = "Dreams"
    const dreamsKey = "2023-07-15\tdreams";
    expect(map.has(dreamsKey)).toBe(true);
    expect(map.get(dreamsKey)).toHaveLength(1);
    expect(map.get(dreamsKey)![0].trackIdentifier).toBe("1234567890");
  });

  it("groups ambiguous entries under same key", async () => {
    const map = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);

    // "Same Song" has two different artists/track IDs on same date
    const ambigKey = "2023-07-15\tsame song";
    expect(map.has(ambigKey)).toBe(true);
    expect(map.get(ambigKey)).toHaveLength(2);
  });
});

describe("buildArtistRecoveryLookup", () => {
  it("builds song→artist set from Track Play History", async () => {
    const map = await buildArtistRecoveryLookup(
      `${FIXTURES}/track-play-history.csv`,
      `${FIXTURES}/library-tracks.json`,
    );

    expect(map.has("dreams")).toBe(true);
    expect(map.get("dreams")!.has("Fleetwood Mac")).toBe(true);
  });

  it("handles missing library file gracefully", async () => {
    const map = await buildArtistRecoveryLookup(
      `${FIXTURES}/track-play-history.csv`,
      `${FIXTURES}/nonexistent.json`,
    );
    // Should still return data from Track Play History
    expect(map.has("dreams")).toBe(true);
  });
});

describe("recoverAppleTrackId", () => {
  it("recovers track ID on exact date+song match", async () => {
    const dailyMap = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);
    const row: PlayActivityRow = {
      eventType: "PLAY_END",
      mediaType: "AUDIO",
      songName: "Dreams",
      artistName: "Fleetwood Mac",
      albumName: "Rumours",
      eventEndTimestamp: "2023-07-15T14:30:00Z",
      playDurationMs: 245000,
      endReasonType: "NATURAL_END_OF_TRACK",
      sourceType: "library",
      shuffle: false,
      offline: false,
      deviceType: "iPhone14",
    };

    const result = recoverAppleTrackId(row, dailyMap);
    expect(result.trackId).toBe("1234567890");
    expect(result.ambiguous).toBe(false);
  });

  it("returns ambiguous=true when multiple track IDs match and no album to disambiguate", async () => {
    const dailyMap = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);
    const row: PlayActivityRow = {
      eventType: "PLAY_END",
      mediaType: "AUDIO",
      songName: "Same Song",
      artistName: "Ambiguous Artist",
      albumName: "",
      eventEndTimestamp: "2023-07-15T12:00:00Z",
      playDurationMs: 200000,
      endReasonType: "NATURAL_END_OF_TRACK",
      sourceType: "library",
      shuffle: false,
      offline: false,
      deviceType: "iPhone14",
    };

    const result = recoverAppleTrackId(row, dailyMap);
    expect(result.trackId).toBeNull();
    expect(result.ambiguous).toBe(true);
  });

  it("disambiguates by album via Library Tracks when multiple track IDs match", async () => {
    const dailyMap = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);
    const albumLookup = await buildAlbumLookup(`${FIXTURES}/library-tracks.json`);
    const row: PlayActivityRow = {
      eventType: "PLAY_END",
      mediaType: "AUDIO",
      songName: "Same Song",
      artistName: "",
      albumName: "Album B",
      eventEndTimestamp: "2023-07-15T12:00:00Z",
      playDurationMs: 200000,
      endReasonType: "NATURAL_END_OF_TRACK",
      sourceType: "library",
      shuffle: false,
      offline: false,
      deviceType: "iPhone14",
    };

    const result = recoverAppleTrackId(row, dailyMap, albumLookup);
    expect(result.trackId).toBe("5555555555");
    expect(result.ambiguous).toBe(false);
  });

  it("recovers via ±1 day window", async () => {
    const dailyMap = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);
    // San Luis is in daily-tracks on 2023-07-14, but the play is timestamped 2023-07-15
    // (timezone shift scenario)
    const row: PlayActivityRow = {
      eventType: "PLAY_END",
      mediaType: "AUDIO",
      songName: "San Luis",
      artistName: "Gregory Alan Isakov",
      albumName: "",
      eventEndTimestamp: "2023-07-15T00:30:00Z",
      playDurationMs: 200000,
      endReasonType: "NATURAL_END_OF_TRACK",
      sourceType: "library",
      shuffle: false,
      offline: false,
      deviceType: "iPhone14",
    };

    const result = recoverAppleTrackId(row, dailyMap);
    expect(result.trackId).toBe("3333333333");
    expect(result.ambiguous).toBe(false);
  });

  it("returns null when no match found", async () => {
    const dailyMap = await buildDailyTracksLookup(`${FIXTURES}/daily-tracks.csv`);
    const row: PlayActivityRow = {
      eventType: "PLAY_END",
      mediaType: "AUDIO",
      songName: "Nonexistent Track",
      artistName: "Unknown",
      albumName: "",
      eventEndTimestamp: "2023-07-15T12:00:00Z",
      playDurationMs: 200000,
      endReasonType: "NATURAL_END_OF_TRACK",
      sourceType: "library",
      shuffle: false,
      offline: false,
      deviceType: "iPhone14",
    };

    const result = recoverAppleTrackId(row, dailyMap);
    expect(result.trackId).toBeNull();
    expect(result.ambiguous).toBe(false);
  });
});

describe("makeCacheKey", () => {
  it("uses apple track ID when available", () => {
    const key = makeCacheKey("12345", "Song", "Artist", "Album");
    expect(key).toBe("apple:12345");
  });

  it("falls back to text hash when no track ID", () => {
    const key = makeCacheKey(null, "Song", "Artist", "Album");
    expect(key).toMatch(/^text:[a-f0-9]{40}$/);
  });

  it("produces consistent hashes", () => {
    const a = makeCacheKey(null, "Dreams", "Fleetwood Mac", "Rumours");
    const b = makeCacheKey(null, "Dreams", "Fleetwood Mac", "Rumours");
    expect(a).toBe(b);
  });

  it("produces different hashes for different inputs", () => {
    const a = makeCacheKey(null, "Dreams", "Fleetwood Mac", "Rumours");
    const b = makeCacheKey(null, "Anti-Hero", "Taylor Swift", "Midnights");
    expect(a).not.toBe(b);
  });
});
