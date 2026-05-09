/**
 * rate-guard.ts — Spotify rate-limit defense for the Worker runtime.
 *
 * Single chokepoint: every Spotify call goes through assertSpotifyAllowed()
 * before making an HTTP request. Cooldown and kill-switch are persisted in KV
 * so they survive Worker restarts and are visible across invocations.
 *
 * See docs/decisions_spotify_rate_limit.md for the full design.
 */

// ── KV keys ──

const COOLDOWN_KEY = "spotify:cooldown_until";
const DISABLED_KEY = "spotify:disabled";

// ── Exception types ──

export class SpotifyCooldownError extends Error {
  cooldownUntil: number; // epoch ms
  constructor(cooldownUntil: number) {
    const remainingSec = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    super(`Spotify cooldown active: ${remainingSec}s remaining (~${(remainingSec / 3600).toFixed(1)}h)`);
    this.name = "SpotifyCooldownError";
    this.cooldownUntil = cooldownUntil;
  }
}

export class SpotifyDisabledError extends Error {
  constructor() {
    super("Spotify API disabled via kill-switch (spotify:disabled)");
    this.name = "SpotifyDisabledError";
  }
}

export class SpotifyServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpotifyServerError";
  }
}

// ── Guard ──

/**
 * Check if Spotify calls are allowed. Throws immediately if not.
 * Must be called before every Spotify HTTP request.
 *
 * Check order: kill-switch first, then cooldown.
 */
export async function assertSpotifyAllowed(kv: KVNamespace): Promise<void> {
  // Kill-switch — checked first, blocks even after cooldown expires
  const disabled = await kv.get(DISABLED_KEY);
  if (disabled) {
    throw new SpotifyDisabledError();
  }

  // Cooldown — set by 429 responses
  const cooldownRaw = await kv.get(COOLDOWN_KEY);
  if (cooldownRaw) {
    const cooldownUntil = parseInt(cooldownRaw, 10);
    if (Date.now() < cooldownUntil) {
      throw new SpotifyCooldownError(cooldownUntil);
    }
    // Cooldown expired — clean it up
    await kv.delete(COOLDOWN_KEY);
  }
}

/**
 * Set a cooldown from a 429 Retry-After value.
 * Honors the full Retry-After — never caps, never shortens.
 *
 * Also logs to console with a grep-able marker (D11 notification).
 */
export async function setSpotifyCooldown(
  kv: KVNamespace,
  retryAfterSeconds: number,
  caller: string,
): Promise<void> {
  const cooldownUntil = Date.now() + retryAfterSeconds * 1000;
  await kv.put(COOLDOWN_KEY, String(cooldownUntil));

  // D11: grep-able notification line
  const hours = (retryAfterSeconds / 3600).toFixed(1);
  console.error(
    `SPOTIFY_COOLDOWN_SET retry_after=${retryAfterSeconds} hours=${hours} caller=${caller} until=${new Date(cooldownUntil).toISOString()}`,
  );
}

/**
 * Set the kill-switch. Blocks all Spotify calls until manually cleared.
 * Used for token-level bans (R3) where nothing will work.
 */
export async function setSpotifyKillSwitch(kv: KVNamespace, caller: string): Promise<void> {
  await kv.put(DISABLED_KEY, "true");
  console.error(`SPOTIFY_KILLSWITCH_SET caller=${caller}`);
}

/**
 * Clear cooldown (manual recovery).
 */
export async function clearSpotifyCooldown(kv: KVNamespace): Promise<void> {
  await kv.delete(COOLDOWN_KEY);
}

/**
 * Clear kill-switch (manual recovery).
 */
export async function clearSpotifyKillSwitch(kv: KVNamespace): Promise<void> {
  await kv.delete(DISABLED_KEY);
}
