import { describe, it, expect, vi } from "vitest";
import { searchByIsrc, searchByText, scoreCandidate } from "../../scripts/lib/spotify-matcher";

describe("scoreCandidate", () => {
  it("returns 1.0 for exact match with matching duration", () => {
    const score = scoreCandidate(
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
    );
    expect(score).toBe(1.0);
  });

  it("returns high score for fuzzy title match", () => {
    const score = scoreCandidate(
      { trackName: "Dreams (Remastered)", artistName: "Fleetwood Mac", durationMs: 254000 },
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
    );
    // Title ratio ~70-80%, artist 100%, duration ~98%
    expect(score).toBeGreaterThan(0.7);
    expect(score).toBeLessThan(1.0);
  });

  it("penalizes mismatched artist", () => {
    const score = scoreCandidate(
      { trackName: "Dreams", artistName: "The Cranberries", durationMs: 254747 },
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
    );
    // Title 100%, artist very low, duration 100%
    expect(score).toBeLessThan(0.8);
  });

  it("returns 0.5 duration weight when no target duration", () => {
    const withDuration = scoreCandidate(
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
    );
    const withoutDuration = scoreCandidate(
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254747 },
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: null },
    );
    // Without duration, the 0.1 weight gets 0.5 instead of 1.0
    expect(withDuration).toBeGreaterThan(withoutDuration);
  });

  it("penalizes large duration difference", () => {
    const score = scoreCandidate(
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 354000 },
      { trackName: "Dreams", artistName: "Fleetwood Mac", durationMs: 254000 },
    );
    // 100s difference > 30s threshold → duration_score = 0
    expect(score).toBeLessThan(1.0);
  });

  it("hand-computed: 0.6×1.0 + 0.3×1.0 + 0.1×1.0 = 1.0 for exact match", () => {
    const score = scoreCandidate(
      { trackName: "test", artistName: "artist", durationMs: 100000 },
      { trackName: "test", artistName: "artist", durationMs: 100000 },
    );
    expect(score).toBe(1.0);
  });

  it("hand-computed: duration within 3s gets full score", () => {
    const score = scoreCandidate(
      { trackName: "test", artistName: "artist", durationMs: 102000 },
      { trackName: "test", artistName: "artist", durationMs: 100000 },
    );
    // Title and artist are exact (1.0 each), duration diff = 2s (within 3s → 1.0)
    expect(score).toBe(1.0);
  });
});

describe("searchByIsrc", () => {
  it("returns match with confidence 1.0", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        tracks: {
          items: [{
            uri: "spotify:track:0ofHAoxe9vBkTCp2UQIavz",
            name: "Dreams",
            artists: [{ name: "Fleetwood Mac" }],
            album: { name: "Rumours" },
            duration_ms: 254747,
          }],
        },
      }), { status: 200 }),
    );

    const result = await searchByIsrc("USRC17607839", "token123", mockFetch);
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(1.0);
    expect(result!.matchMethod).toBe("isrc");
    expect(result!.spotifyTrackUri).toBe("spotify:track:0ofHAoxe9vBkTCp2UQIavz");
  });

  it("returns null when no results", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 }),
    );

    const result = await searchByIsrc("INVALID", "token123", mockFetch);
    expect(result).toBeNull();
  });

  it("includes isrc: in search URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 }),
    );

    await searchByIsrc("USRC17607839", "token123", mockFetch);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("isrc:USRC17607839");
  });
});

describe("searchByText", () => {
  it("returns scored candidates sorted by confidence", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        tracks: {
          items: [
            {
              uri: "spotify:track:aaa",
              name: "Dreams (Remastered)",
              artists: [{ name: "Fleetwood Mac" }],
              album: { name: "Rumours (Deluxe)" },
              duration_ms: 255000,
            },
            {
              uri: "spotify:track:bbb",
              name: "Dreams",
              artists: [{ name: "Fleetwood Mac" }],
              album: { name: "Rumours" },
              duration_ms: 254747,
            },
          ],
        },
      }), { status: 200 }),
    );

    const results = await searchByText(
      "Dreams", "Fleetwood Mac", "Rumours", 254747,
      "token123", mockFetch,
    );
    expect(results).toHaveLength(2);
    // Exact title match should score higher
    expect(results[0].spotifyTrackUri).toBe("spotify:track:bbb");
    expect(results[0].confidence).toBeGreaterThan(results[1].confidence);
    expect(results[0].matchMethod).toBe("text");
  });

  it("returns empty array when no results", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ tracks: { items: [] } }), { status: 200 }),
    );

    const results = await searchByText(
      "Nonexistent", "Unknown", null, null,
      "token123", mockFetch,
    );
    expect(results).toHaveLength(0);
  });
});
