import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import {
  assertSpotifyAllowed,
  setSpotifyCooldown,
  clearSpotifyCooldown,
  setSpotifyKillSwitch,
  clearSpotifyKillSwitch,
  SpotifyCooldownError,
  SpotifyDisabledError,
} from "../../src/spotify/rate-guard";

describe("rate-guard", () => {
  beforeEach(async () => {
    // Clean slate
    await env.KV.delete("spotify:cooldown_until");
    await env.KV.delete("spotify:disabled");
  });

  // Test 1: 429 with Retry-After: 78000 sets cooldown to exactly now + 78000s
  it("setSpotifyCooldown stores exact epoch ms for full Retry-After value", async () => {
    const before = Date.now();
    await setSpotifyCooldown(env.KV, 78000, "test");
    const raw = await env.KV.get("spotify:cooldown_until");
    expect(raw).not.toBeNull();
    const cooldownUntil = parseInt(raw!, 10);
    const expectedMin = before + 78000 * 1000;
    const expectedMax = Date.now() + 78000 * 1000;
    expect(cooldownUntil).toBeGreaterThanOrEqual(expectedMin);
    expect(cooldownUntil).toBeLessThanOrEqual(expectedMax);
  });

  // Test 2: 429 with no Retry-After → default 3600s (handled by caller, but verify cooldown write)
  it("stores cooldown for default 3600s value", async () => {
    const before = Date.now();
    await setSpotifyCooldown(env.KV, 3600, "test-default");
    const raw = await env.KV.get("spotify:cooldown_until");
    const cooldownUntil = parseInt(raw!, 10);
    expect(cooldownUntil).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  // Test 3: While cooldown active, throws SpotifyCooldownError without making any HTTP request
  it("throws SpotifyCooldownError when cooldown is active — zero fetch calls", async () => {
    const mockFetch = vi.fn();
    // @ts-expect-error — global fetch mock
    globalThis.fetch = mockFetch;

    // Set cooldown 1 hour in the future
    await env.KV.put("spotify:cooldown_until", String(Date.now() + 3600 * 1000));

    await expect(assertSpotifyAllowed(env.KV)).rejects.toThrow(SpotifyCooldownError);
    expect(mockFetch).toHaveBeenCalledTimes(0);
  });

  // Test 4: After cooldown expires, calls proceed
  it("allows calls after cooldown expires", async () => {
    // Set cooldown in the past
    await env.KV.put("spotify:cooldown_until", String(Date.now() - 1000));

    await expect(assertSpotifyAllowed(env.KV)).resolves.toBeUndefined();
    // Verify it cleaned up the expired key
    const raw = await env.KV.get("spotify:cooldown_until");
    expect(raw).toBeNull();
  });

  // Test 5: Kill-switch active throws SpotifyDisabledError before cooldown is checked
  it("throws SpotifyDisabledError when kill-switch is active, before checking cooldown", async () => {
    await env.KV.put("spotify:disabled", "true");
    // Also set a cooldown to prove kill-switch is checked first
    await env.KV.put("spotify:cooldown_until", String(Date.now() + 3600 * 1000));

    await expect(assertSpotifyAllowed(env.KV)).rejects.toThrow(SpotifyDisabledError);
  });

  // Test 9: setSpotifyCooldown writes to KV with correct value
  it("writes cooldown to KV with correct epoch ms", async () => {
    await setSpotifyCooldown(env.KV, 1800, "test-write");
    const raw = await env.KV.get("spotify:cooldown_until");
    expect(raw).not.toBeNull();
    const val = parseInt(raw!, 10);
    // Should be ~30 minutes from now
    expect(val).toBeGreaterThan(Date.now() + 1799 * 1000);
    expect(val).toBeLessThanOrEqual(Date.now() + 1801 * 1000);
  });

  // Test 10: Read existing cooldown from KV on cold start
  it("reads existing cooldown from KV on cold start", async () => {
    const futureTime = Date.now() + 7200 * 1000;
    await env.KV.put("spotify:cooldown_until", String(futureTime));

    try {
      await assertSpotifyAllowed(env.KV);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SpotifyCooldownError);
      expect((err as SpotifyCooldownError).cooldownUntil).toBe(futureTime);
    }
  });

  // Test 11: Token endpoint 429 → kill-switch set
  it("setSpotifyKillSwitch writes disabled key", async () => {
    await setSpotifyKillSwitch(env.KV, "token_refresh");
    const val = await env.KV.get("spotify:disabled");
    expect(val).toBe("true");
  });

  // Clear operations
  it("clearSpotifyCooldown removes the KV key", async () => {
    await env.KV.put("spotify:cooldown_until", String(Date.now() + 3600 * 1000));
    await clearSpotifyCooldown(env.KV);
    const raw = await env.KV.get("spotify:cooldown_until");
    expect(raw).toBeNull();
  });

  it("clearSpotifyKillSwitch removes the disabled key", async () => {
    await env.KV.put("spotify:disabled", "true");
    await clearSpotifyKillSwitch(env.KV);
    const raw = await env.KV.get("spotify:disabled");
    expect(raw).toBeNull();
  });

  // No cooldown or kill-switch → no throw
  it("allows calls when neither cooldown nor kill-switch is set", async () => {
    await expect(assertSpotifyAllowed(env.KV)).resolves.toBeUndefined();
  });
});
