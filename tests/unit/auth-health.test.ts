import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  evaluateAuthHealth,
  getAuthHealth,
  markAuthorized,
  runAuthHealthCheck,
  AUTHORIZED_AT_KEY,
} from "../../src/auth/auth-health";
import { handleCallback, refreshAccessToken } from "../../src/auth/spotify-oauth";
import { SpotifyClient } from "../../src/spotify/client";
import { saveTokens } from "../../src/auth/tokens";
import {
  assertSpotifyAllowed,
  SpotifyAuthError,
  SpotifyDisabledError,
} from "../../src/spotify/rate-guard";

const DAY = 86_400_000;
const T0 = 1_800_000_000_000;
const KEYS = [
  "spotify:authorized_at",
  "spotify:auth_broken",
  "spotify:disabled",
  "spotify:cooldown_until",
  "spotify:access_token",
  "spotify:refresh_token",
  "spotify:token_expires",
];

const realFetch = globalThis.fetch;
async function clean() {
  for (const k of KEYS) await env.KV.delete(k);
  const l = await env.KV.list({ prefix: "spotify:auth_alert:" });
  for (const k of l.keys) await env.KV.delete(k.name);
  const o = await env.KV.list({ prefix: "oauth_state:" });
  for (const k of o.keys) await env.KV.delete(k.name);
}
const testEnv = () => ({
  KV: env.KV,
  SPOTIFY_CLIENT_ID: "id",
  SPOTIFY_CLIENT_SECRET: "secret",
});
const tokenResp = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(clean);
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("evaluateAuthHealth", () => {
  const at = (days: number) => ({
    authorizedAt: T0,
    authBroken: null,
    now: T0 + days * DAY,
  });

  it.each([
    [149, "ok", null],
    [150, "expiring", "warn-150"],
    [164, "expiring", "warn-150"],
    [165, "expiring", "warn-165"],
    [175, "expiring", "warn-175"],
    [180, "expiring", "warn-175"],
  ])("day %i → %s / %s", (days, status, alert) => {
    const h = evaluateAuthHealth(at(days));
    expect(h.status).toBe(status);
    expect(h.alert).toBe(alert);
    expect(h.daysUntilExpiry).toBe(180 - days);
  });

  it("is unknown (no alert) when never authorized via callback", () => {
    const h = evaluateAuthHealth({ authorizedAt: null, authBroken: null, now: T0 });
    expect(h).toEqual({ status: "unknown", daysSinceAuth: null, daysUntilExpiry: null, alert: null });
  });

  it("broken overrides everything, even with no timestamp", () => {
    const flag = { reason: "invalid_grant", at: T0 };
    expect(evaluateAuthHealth({ authorizedAt: T0, authBroken: flag, now: T0 }).status).toBe("broken");
    expect(evaluateAuthHealth({ authorizedAt: null, authBroken: flag, now: T0 }).alert).toBe("broken");
  });
});

describe("refreshAccessToken classification", () => {
  it("400 invalid_grant → SpotifyAuthError, sets flag, exactly one HTTP call", async () => {
    const f = vi.fn().mockResolvedValue(tokenResp(400, { error: "invalid_grant" }));
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(refreshAccessToken(testEnv(), "rt")).rejects.toThrow(SpotifyAuthError);
    expect(f).toHaveBeenCalledTimes(1);
    const flag = JSON.parse((await env.KV.get("spotify:auth_broken"))!);
    expect(flag.reason).toBe("invalid_grant");
  });

  it("400 invalid_client → SpotifyAuthError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(tokenResp(400, { error: "invalid_client" })) as unknown as typeof fetch;
    await expect(refreshAccessToken(testEnv(), "rt")).rejects.toThrow(SpotifyAuthError);
  });

  it("429 still sets cooldown + kill-switch, not auth_broken", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 429 })) as unknown as typeof fetch;
    await expect(refreshAccessToken(testEnv(), "rt")).rejects.toThrow();
    expect(await env.KV.get("spotify:disabled")).toBe("true");
    expect(await env.KV.get("spotify:cooldown_until")).not.toBeNull();
    expect(await env.KV.get("spotify:auth_broken")).toBeNull();
  });

  it("500 is a plain error and does not flag auth", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const err = await refreshAccessToken(testEnv(), "rt").catch((e) => e);
    expect(err).not.toBeInstanceOf(SpotifyAuthError);
    expect(await env.KV.get("spotify:auth_broken")).toBeNull();
  });

  it("successful refresh does not touch authorized_at", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(tokenResp(200, { access_token: "a", expires_in: 3600 })) as unknown as typeof fetch;
    await refreshAccessToken(testEnv(), "rt");
    expect(await env.KV.get(AUTHORIZED_AT_KEY)).toBeNull();
  });
});

describe("auth_broken short-circuit", () => {
  it("SpotifyAuthError is a SpotifyDisabledError (existing catch sites skip quietly)", () => {
    expect(new SpotifyAuthError("invalid_grant")).toBeInstanceOf(SpotifyDisabledError);
  });

  it("assertSpotifyAllowed throws when flag set", async () => {
    await env.KV.put("spotify:auth_broken", JSON.stringify({ reason: "invalid_grant", at: T0 }));
    await expect(assertSpotifyAllowed(env.KV)).rejects.toThrow(SpotifyAuthError);
  });

  it("SpotifyClient makes zero fetches when flag set", async () => {
    await saveTokens(env.KV, { accessToken: "a", refreshToken: "r", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    await env.KV.put("spotify:auth_broken", JSON.stringify({ reason: "invalid_grant", at: T0 }));
    const f = vi.fn();
    globalThis.fetch = f as unknown as typeof fetch;
    await expect(new SpotifyClient(testEnv()).get("/v1/me")).rejects.toThrow(SpotifyAuthError);
    expect(f).toHaveBeenCalledTimes(0);
  });
});

describe("handleCallback", () => {
  async function callback() {
    await env.KV.put("oauth_state:abc", "1");
    globalThis.fetch = vi.fn().mockResolvedValue(
      tokenResp(200, { access_token: "a", refresh_token: "r", expires_in: 3600 }),
    ) as unknown as typeof fetch;
    return handleCallback(new Request("https://x.test/auth/callback?code=c&state=abc"), testEnv());
  }

  it("writes authorized_at and clears auth_broken", async () => {
    await env.KV.put("spotify:auth_broken", JSON.stringify({ reason: "invalid_grant", at: T0 }));
    const before = Date.now();
    const resp = await callback();
    expect(resp.status).toBe(200);
    const at = parseInt((await env.KV.get(AUTHORIZED_AT_KEY))!, 10);
    expect(at).toBeGreaterThanOrEqual(before);
    expect(await env.KV.get("spotify:auth_broken")).toBeNull();
  });

  it("failed token exchange leaves authorized_at unset", async () => {
    await env.KV.put("oauth_state:abc", "1");
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("nope", { status: 400 })) as unknown as typeof fetch;
    const resp = await handleCallback(new Request("https://x.test/auth/callback?code=c&state=abc"), testEnv());
    expect(resp.status).toBe(500);
    expect(await env.KV.get(AUTHORIZED_AT_KEY)).toBeNull();
  });
});

describe("runAuthHealthCheck", () => {
  const alertEnv = () => ({ KV: env.KV, RESEND_API_KEY: "k", NOTIFICATION_EMAIL: "me@example.com" });
  const okSend = () =>
    (globalThis.fetch = vi.fn().mockResolvedValue(new Response("{}", { status: 200 })) as unknown as typeof fetch);

  it("sends nothing when healthy", async () => {
    await markAuthorized(env.KV, T0);
    const f = okSend();
    const r = await runAuthHealthCheck(alertEnv(), T0 + 10 * DAY);
    expect(r.emailed).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("sends once per threshold, then dedupes", async () => {
    await markAuthorized(env.KV, T0);
    const f = okSend();
    expect((await runAuthHealthCheck(alertEnv(), T0 + 150 * DAY)).emailed).toBe(true);
    expect((await runAuthHealthCheck(alertEnv(), T0 + 151 * DAY)).emailed).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject.startsWith("Action needed:")).toBe(true);
    expect(body.html).toContain("/auth/login");
    // next threshold fires separately
    expect((await runAuthHealthCheck(alertEnv(), T0 + 165 * DAY)).emailed).toBe(true);
  });

  it("re-login resets the dedupe", async () => {
    await markAuthorized(env.KV, T0);
    okSend();
    await runAuthHealthCheck(alertEnv(), T0 + 150 * DAY);
    await markAuthorized(env.KV, T0 + 151 * DAY);
    expect((await getAuthHealth(env.KV, T0 + 152 * DAY)).status).toBe("ok");
    expect((await runAuthHealthCheck(alertEnv(), T0 + 151 * DAY + 150 * DAY)).emailed).toBe(true);
  });

  it("failed send is not deduped (retries next run)", async () => {
    await markAuthorized(env.KV, T0);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("err", { status: 500 })) as unknown as typeof fetch;
    expect((await runAuthHealthCheck(alertEnv(), T0 + 150 * DAY)).emailed).toBe(false);
    okSend();
    expect((await runAuthHealthCheck(alertEnv(), T0 + 151 * DAY)).emailed).toBe(true);
  });

  it("broken flag emails", async () => {
    await env.KV.put("spotify:auth_broken", JSON.stringify({ reason: "invalid_grant", at: T0 }));
    const f = okSend();
    expect((await runAuthHealthCheck(alertEnv(), T0)).emailed).toBe(true);
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.subject).toContain("lost its Spotify authorization");
  });
});

describe("OAuth scopes", () => {
  it("does not request unused scopes (least privilege)", async () => {
    const { SCOPES } = await import("../../src/auth/spotify-oauth");
    const list = SCOPES.split(" ");
    expect(list).not.toContain("user-read-email");
    expect(list).not.toContain("user-library-modify");
    // scopes the code does rely on
    for (const s of ["user-read-recently-played", "user-modify-playback-state", "playlist-modify-private", "user-library-read", "user-follow-read"]) {
      expect(list).toContain(s);
    }
  });
});
