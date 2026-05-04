import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../../src/index";

// Mock SpotifyClient so we never hit the real Spotify API
const mockGet = vi.fn();
const mockPut = vi.fn();
const mockPost = vi.fn();

vi.mock("../../src/spotify/client", () => {
  return {
    SpotifyClient: class {
      get = mockGet;
      put = mockPut;
      post = mockPost;
    },
  };
});

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
    OAUTH_KV: env.KV,     // dummy, not used by these tools
    OAUTH_PROVIDER: {} as any,
  };
}

const TRACK_URI = "spotify:track:4cOdK2wGLETKBW3PvgPWqT";
const TRACK_ID = "4cOdK2wGLETKBW3PvgPWqT";
const TRACK_META = { name: "Wild Horses", artists: [{ name: "The Rolling Stones" }] };

beforeEach(() => {
  vi.clearAllMocks();
  // Default: GET /v1/tracks/... returns metadata
  mockGet.mockResolvedValue(TRACK_META);
});

// ── play_track ──────────────────────────────────────────────────────────────

describe("play_track", () => {
  it("happy path: plays track and returns name", async () => {
    mockPut.mockResolvedValue(undefined); // 204 from Spotify

    const result = await callTool("play_track", { uri: TRACK_URI }, testEnv()) as any;
    expect(result.ok).toBe(true);
    expect(result.track).toBe("Wild Horses");
    expect(result.artist).toBe("The Rolling Stones");
    expect(result.source).toBe("spotify_live");

    expect(mockPut).toHaveBeenCalledWith(
      "/v1/me/player/play",
      { uris: [TRACK_URI] },
      undefined,
    );
  });

  it("no active device: returns clear error", async () => {
    mockPut.mockRejectedValue(new Error("Spotify API PUT /v1/me/player/play failed (404): Player command failed: No active device found"));

    const result = await callTool("play_track", { uri: TRACK_URI }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No active Spotify device");
    expect(result.track).toBe("Wild Horses");
  });

  it("other Spotify error: returns error message", async () => {
    mockPut.mockRejectedValue(new Error("Spotify API PUT /v1/me/player/play failed (502): Bad Gateway"));

    const result = await callTool("play_track", { uri: TRACK_URI }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Spotify error");
    expect(result.error).toContain("502");
  });

  it("passes device_id when provided", async () => {
    mockPut.mockResolvedValue(undefined);

    await callTool("play_track", { uri: TRACK_URI, device_id: "abc123" }, testEnv());
    expect(mockPut).toHaveBeenCalledWith(
      "/v1/me/player/play",
      { uris: [TRACK_URI] },
      { device_id: "abc123" },
    );
  });

  it("rejects invalid URI format", async () => {
    const result = await callTool("play_track", { uri: "not-a-uri" }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Invalid Spotify track URI");
  });
});

// ── queue_track ─────────────────────────────────────────────────────────────

describe("queue_track", () => {
  it("happy path: queues track and returns name", async () => {
    mockPost.mockResolvedValue(undefined); // 204 from Spotify

    const result = await callTool("queue_track", { uri: TRACK_URI }, testEnv()) as any;
    expect(result.ok).toBe(true);
    expect(result.track).toBe("Wild Horses");
    expect(result.artist).toBe("The Rolling Stones");
    expect(result.source).toBe("spotify_live");

    expect(mockPost).toHaveBeenCalledWith(
      "/v1/me/player/queue",
      undefined,
      { uri: TRACK_URI },
    );
  });

  it("no active device: returns clear error", async () => {
    mockPost.mockRejectedValue(new Error("Spotify API POST /v1/me/player/queue failed (404): Player command failed: No active device found"));

    const result = await callTool("queue_track", { uri: TRACK_URI }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("No active Spotify device");
    expect(result.track).toBe("Wild Horses");
  });

  it("other Spotify error: returns error message", async () => {
    mockPost.mockRejectedValue(new Error("Spotify API POST /v1/me/player/queue failed (500): Internal Server Error"));

    const result = await callTool("queue_track", { uri: TRACK_URI }, testEnv()) as any;
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Spotify error");
    expect(result.error).toContain("500");
  });

  it("passes device_id when provided", async () => {
    mockPost.mockResolvedValue(undefined);

    await callTool("queue_track", { uri: TRACK_URI, device_id: "xyz789" }, testEnv());
    expect(mockPost).toHaveBeenCalledWith(
      "/v1/me/player/queue",
      undefined,
      { uri: TRACK_URI, device_id: "xyz789" },
    );
  });
});
