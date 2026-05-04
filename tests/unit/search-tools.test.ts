import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../../src/index";

const mockGet = vi.fn();

vi.mock("../../src/spotify/client", () => ({
  SpotifyClient: class {
    get = mockGet;
  },
}));

const { callTool } = await import("../../src/mcp/tools");

function testEnv(): Env {
  return {
    DB: env.DB,
    KV: env.KV,
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SHORTCUT_TOKEN: "",
    RESEND_API_KEY: "",
    NOTIFICATION_EMAIL: "",
    SPOTIFY_USER_ID: "",
    ACCESS_ALLOWED_EMAIL: "",
    ACCESS_TEAM_NAME: "",
    ACCESS_AUD: "",
    OAUTH_KV: env.KV,
    OAUTH_PROVIDER: {} as any,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("search_tracks", () => {
  it("happy path: returns matching tracks with URIs", async () => {
    mockGet.mockResolvedValue({
      tracks: {
        items: [
          {
            uri: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
            name: "Wild Horses",
            artists: [{ name: "The Rolling Stones" }],
            album: { name: "Sticky Fingers" },
            duration_ms: 340000,
          },
          {
            uri: "spotify:track:1HNkqx9Ahdgi1Ixy2xkKkL",
            name: "Wild Horses",
            artists: [{ name: "The Sundays" }],
            album: { name: "Blind" },
            duration_ms: 285000,
          },
        ],
      },
    });

    const result = await callTool("search_tracks", { query: "wild horses" }, testEnv()) as any;
    expect(result.source).toBe("spotify_live");
    expect(result.query).toBe("wild horses");
    expect(result.results).toHaveLength(2);
    expect(result.results[0].uri).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    expect(result.results[0].track_name).toBe("Wild Horses");
    expect(result.results[0].artist_name).toBe("The Rolling Stones");
    expect(result.results[0].album_name).toBe("Sticky Fingers");
    expect(result.results[0].duration_ms).toBe(340000);

    expect(mockGet).toHaveBeenCalledWith("/v1/search", { q: "wild horses", type: "track", limit: "5" });
  });

  it("empty results: returns empty array, not error", async () => {
    mockGet.mockResolvedValue({ tracks: { items: [] } });

    const result = await callTool("search_tracks", { query: "xyznonexistent123" }, testEnv()) as any;
    expect(result.source).toBe("spotify_live");
    expect(result.results).toEqual([]);
    expect(result.ok).toBeUndefined();
  });

  it("auth error: returns clear message", async () => {
    mockGet.mockRejectedValue(new Error("Spotify API GET /v1/search failed (401): Unauthorized"));

    const result = await callTool("search_tracks", { query: "test" }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("authorization");
  });

  it("network error: returns error message", async () => {
    mockGet.mockRejectedValue(new Error("Spotify API GET /v1/search failed (500): Internal Server Error"));

    const result = await callTool("search_tracks", { query: "test" }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Spotify error");
  });

  it("clamps limit to 20", async () => {
    mockGet.mockResolvedValue({ tracks: { items: [] } });

    await callTool("search_tracks", { query: "test", limit: 50 }, testEnv());
    expect(mockGet).toHaveBeenCalledWith("/v1/search", { q: "test", type: "track", limit: "20" });
  });
});
