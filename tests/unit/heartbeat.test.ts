import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  recordSpotifySuccess,
  resetHeartbeatThrottle,
  runHeartbeatCheck,
  LAST_OK_KEY,
  HEARTBEAT_WRITE_INTERVAL_MS,
} from "../../src/spotify/heartbeat";
import { SpotifyClient } from "../../src/spotify/client";
import { saveTokens } from "../../src/auth/tokens";

const HOUR = 3_600_000;
const T0 = 1_800_000_000_000;
const realFetch = globalThis.fetch;
const alertEnv = () => ({ KV: env.KV, RESEND_API_KEY: "k", NOTIFICATION_EMAIL: "me@example.com" });

beforeEach(async () => {
  resetHeartbeatThrottle();
  for (const k of [LAST_OK_KEY, "spotify:auth_alert:stale", "spotify:auth_broken", "spotify:cooldown_until", "spotify:disabled"]) {
    await env.KV.delete(k);
  }
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("recordSpotifySuccess", () => {
  it("writes, then throttles within 10 minutes", async () => {
    await recordSpotifySuccess(env.KV, T0);
    expect(await env.KV.get(LAST_OK_KEY)).toBe(String(T0));
    await recordSpotifySuccess(env.KV, T0 + HEARTBEAT_WRITE_INTERVAL_MS - 1);
    expect(await env.KV.get(LAST_OK_KEY)).toBe(String(T0));
    await recordSpotifySuccess(env.KV, T0 + HEARTBEAT_WRITE_INTERVAL_MS);
    expect(await env.KV.get(LAST_OK_KEY)).toBe(String(T0 + HEARTBEAT_WRITE_INTERVAL_MS));
  });

  it("SpotifyClient records a heartbeat on a successful call, not on failure", async () => {
    await saveTokens(env.KV, { accessToken: "a", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("{}", { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;
    await new SpotifyClient({ KV: env.KV, SPOTIFY_CLIENT_ID: "i", SPOTIFY_CLIENT_SECRET: "s" }).get("/v1/me");
    expect(await env.KV.get(LAST_OK_KEY)).not.toBeNull();

    await env.KV.delete(LAST_OK_KEY);
    resetHeartbeatThrottle();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("no", { status: 403 })) as unknown as typeof fetch;
    await expect(
      new SpotifyClient({ KV: env.KV, SPOTIFY_CLIENT_ID: "i", SPOTIFY_CLIENT_SECRET: "s" }).get("/v1/me"),
    ).rejects.toThrow();
    expect(await env.KV.get(LAST_OK_KEY)).toBeNull();
  });
});

describe("runHeartbeatCheck", () => {
  const okSend = () =>
    (globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch);

  it("no heartbeat yet → no alert", async () => {
    const f = okSend();
    expect((await runHeartbeatCheck(alertEnv(), T0)).emailed).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("fresh heartbeat → no alert", async () => {
    await env.KV.put(LAST_OK_KEY, String(T0));
    const f = okSend();
    const r = await runHeartbeatCheck(alertEnv(), T0 + 23 * HOUR);
    expect(r.stale).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it(">24h stale → emails once, then dedupes for 24h", async () => {
    await env.KV.put(LAST_OK_KEY, String(T0));
    const f = okSend();
    expect((await runHeartbeatCheck(alertEnv(), T0 + 25 * HOUR)).emailed).toBe(true);
    expect((await runHeartbeatCheck(alertEnv(), T0 + 26 * HOUR)).emailed).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject.startsWith("Action needed:")).toBe(true);
  });

  it("skips when auth is already flagged broken", async () => {
    await env.KV.put(LAST_OK_KEY, String(T0));
    await env.KV.put("spotify:auth_broken", JSON.stringify({ reason: "invalid_grant", at: T0 }));
    const f = okSend();
    const r = await runHeartbeatCheck(alertEnv(), T0 + 48 * HOUR);
    expect(r.stale).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  it("failed send is not deduped", async () => {
    await env.KV.put(LAST_OK_KEY, String(T0));
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("e", { status: 500 })) as unknown as typeof fetch;
    expect((await runHeartbeatCheck(alertEnv(), T0 + 25 * HOUR)).emailed).toBe(false);
    okSend();
    expect((await runHeartbeatCheck(alertEnv(), T0 + 26 * HOUR)).emailed).toBe(true);
  });
});
