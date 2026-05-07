import { describe, it, expect, vi } from "vitest";
import { lookupTrack } from "../../scripts/lib/itunes-lookup";

// Recorded fixture: actual iTunes Lookup API response shape
const FIXTURE_RESPONSE = {
  resultCount: 1,
  results: [
    {
      wrapperType: "track",
      artistName: "Fleetwood Mac",
      trackName: "Dreams",
      collectionName: "Rumours (Super Deluxe)",
      trackTimeMillis: 254747,
      releaseDate: "1977-02-04T08:00:00Z",
      primaryGenreName: "Rock",
      artistId: 158038,
      collectionId: 594061854,
      previewUrl: "https://audio-ssl.itunes.apple.com/preview/123.m4a",
    },
  ],
};

describe("lookupTrack", () => {
  it("parses a successful response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(FIXTURE_RESPONSE), { status: 200 }),
    );

    const result = await lookupTrack("594061860", mockFetch);
    expect(result).not.toBeNull();
    expect(result!.artistName).toBe("Fleetwood Mac");
    expect(result!.trackName).toBe("Dreams");
    expect(result!.collectionName).toBe("Rumours (Super Deluxe)");
    expect(result!.trackTimeMillis).toBe(254747);
    expect(result!.primaryGenreName).toBe("Rock");
    expect(result!.previewUrl).toBe("https://audio-ssl.itunes.apple.com/preview/123.m4a");
  });

  it("returns null on 404", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Not Found", { status: 404 }),
    );

    const result = await lookupTrack("0000000", mockFetch);
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1); // no retry on 404
  });

  it("retries on 5xx and returns null after exhaustion", { timeout: 15000 }, async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await lookupTrack("12345", mockFetch);
    expect(result).toBeNull();
    // 1 initial + 3 retries = 4 calls
    expect(mockFetch).toHaveBeenCalledTimes(4);
  });

  it("returns null when no results", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ resultCount: 0, results: [] }), { status: 200 }),
    );

    const result = await lookupTrack("99999", mockFetch);
    expect(result).toBeNull();
  });

  it("handles response with only artist wrapper (no track)", async () => {
    const noTrack = {
      resultCount: 1,
      results: [{ wrapperType: "artist", artistName: "Fleetwood Mac" }],
    };
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(noTrack), { status: 200 }),
    );

    const result = await lookupTrack("158038", mockFetch);
    expect(result).toBeNull();
  });

  it("calls the correct URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(FIXTURE_RESPONSE), { status: 200 }),
    );

    await lookupTrack("594061860", mockFetch);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe(
      "https://itunes.apple.com/lookup?id=594061860&entity=song",
    );
  });
});
