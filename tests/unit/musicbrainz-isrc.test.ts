import { describe, it, expect, vi } from "vitest";
import { findIsrc } from "../../scripts/lib/musicbrainz-isrc";

describe("findIsrc", () => {
  it("returns ISRC from top result", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        recordings: [
          { id: "abc", score: 100, isrcs: ["USRC17607839"], title: "Dreams" },
        ],
      }), { status: 200 }),
    );

    const result = await findIsrc("Fleetwood Mac", "Dreams", mockFetch);
    expect(result).toBe("USRC17607839");
  });

  it("scans to 3rd result if first two lack ISRCs", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        recordings: [
          { id: "a", score: 100, isrcs: [], title: "Dreams" },
          { id: "b", score: 95, title: "Dreams (Live)" },
          { id: "c", score: 90, isrcs: ["GBAYE0000123"], title: "Dreams" },
        ],
      }), { status: 200 }),
    );

    const result = await findIsrc("Fleetwood Mac", "Dreams", mockFetch);
    expect(result).toBe("GBAYE0000123");
  });

  it("returns null when no results have ISRCs", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        recordings: [
          { id: "a", score: 100, title: "Dreams" },
          { id: "b", score: 95, title: "Dreams" },
        ],
      }), { status: 200 }),
    );

    const result = await findIsrc("Fleetwood Mac", "Dreams", mockFetch);
    expect(result).toBeNull();
  });

  it("returns null on empty response", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recordings: [] }), { status: 200 }),
    );

    const result = await findIsrc("Unknown", "Track", mockFetch);
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response("Service Unavailable", { status: 503 }),
    );

    const result = await findIsrc("Fleetwood Mac", "Dreams", mockFetch);
    expect(result).toBeNull();
  });

  it("sends correct User-Agent header", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recordings: [] }), { status: 200 }),
    );

    await findIsrc("Test", "Track", mockFetch);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["User-Agent"]).toBe("surfaces/1.0 ( chrisbuice@gmail.com )");
  });

  it("builds correct search URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ recordings: [] }), { status: 200 }),
    );

    await findIsrc("Fleetwood Mac", "Dreams", mockFetch);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("musicbrainz.org/ws/2/recording?query=");
    expect(url).toContain("fmt=json");
    expect(url).toContain("limit=3");
  });
});
