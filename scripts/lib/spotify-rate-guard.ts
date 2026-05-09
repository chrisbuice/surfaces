/**
 * spotify-rate-guard.ts — Spotify rate-limit defense for grimmauldplace scripts.
 *
 * Same contract as src/spotify/rate-guard.ts but uses file-based persistence
 * instead of KV. All Spotify calls from scripts should check this before
 * making HTTP requests.
 *
 * Persistence:
 *   ~/.surfaces/spotify-cooldown   — contains epoch ms
 *   ~/.surfaces/spotify-disabled   — presence = disabled
 *   ~/.surfaces/spotify-incidents.log — append-only incident log
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SURFACES_DIR = join(homedir(), ".surfaces");
const COOLDOWN_FILE = join(SURFACES_DIR, "spotify-cooldown");
const DISABLED_FILE = join(SURFACES_DIR, "spotify-disabled");
const INCIDENTS_FILE = join(SURFACES_DIR, "spotify-incidents.log");

// ── Exception types (same as Worker side) ──

export class SpotifyCooldownError extends Error {
  cooldownUntil: number;
  constructor(cooldownUntil: number) {
    const remainingSec = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
    super(`Spotify cooldown active: ${remainingSec}s remaining (~${(remainingSec / 3600).toFixed(1)}h)`);
    this.name = "SpotifyCooldownError";
    this.cooldownUntil = cooldownUntil;
  }
}

export class SpotifyDisabledError extends Error {
  constructor() {
    super("Spotify API disabled via kill-switch (~/.surfaces/spotify-disabled)");
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

function ensureDir(): void {
  if (!existsSync(SURFACES_DIR)) {
    mkdirSync(SURFACES_DIR, { recursive: true });
  }
}

/**
 * Check if Spotify calls are allowed. Throws immediately if not.
 * Kill-switch checked first, then cooldown.
 */
export function assertSpotifyAllowed(): void {
  // Kill-switch
  if (existsSync(DISABLED_FILE)) {
    throw new SpotifyDisabledError();
  }

  // Cooldown
  if (existsSync(COOLDOWN_FILE)) {
    const raw = readFileSync(COOLDOWN_FILE, "utf-8").trim();
    const cooldownUntil = parseInt(raw, 10);
    if (Date.now() < cooldownUntil) {
      throw new SpotifyCooldownError(cooldownUntil);
    }
    // Cooldown expired — clean up
    try { unlinkSync(COOLDOWN_FILE); } catch {}
  }
}

/**
 * Set a cooldown from a 429 Retry-After value.
 * Honors the full value — never caps, never shortens.
 */
export function setSpotifyCooldown(retryAfterSeconds: number, caller: string): void {
  ensureDir();
  const cooldownUntil = Date.now() + retryAfterSeconds * 1000;
  writeFileSync(COOLDOWN_FILE, String(cooldownUntil));

  // D11: log to incidents file + stderr
  const hours = (retryAfterSeconds / 3600).toFixed(1);
  const logLine = `${new Date().toISOString()} SPOTIFY_COOLDOWN_SET retry_after=${retryAfterSeconds} hours=${hours} caller=${caller} until=${new Date(cooldownUntil).toISOString()}\n`;
  appendFileSync(INCIDENTS_FILE, logLine);
  console.error(`SPOTIFY_COOLDOWN_SET retry_after=${retryAfterSeconds} hours=${hours} caller=${caller}`);
}

/**
 * Set the kill-switch. Used for token-level bans.
 */
export function setSpotifyKillSwitch(caller: string): void {
  ensureDir();
  writeFileSync(DISABLED_FILE, "true");
  const logLine = `${new Date().toISOString()} SPOTIFY_KILLSWITCH_SET caller=${caller}\n`;
  appendFileSync(INCIDENTS_FILE, logLine);
  console.error(`SPOTIFY_KILLSWITCH_SET caller=${caller}`);
}
