/**
 * client.ts — Spotify API wrapper with rate-limit defense.
 *
 * Every Spotify HTTP call goes through request(), which:
 * 1. Checks the cooldown/kill-switch via assertSpotifyAllowed()
 * 2. Enforces a 100ms minimum interval between calls
 * 3. Handles 429 → sets persistent cooldown, throws SpotifyCooldownError
 * 4. Handles 5xx → retries with backoff, throws SpotifyServerError
 * 5. Handles 401 → refreshes token once, retries once
 */

import { getTokens, saveTokens } from "../auth/tokens";
import { refreshAccessToken } from "../auth/spotify-oauth";
import {
  assertSpotifyAllowed,
  setSpotifyCooldown,
  SpotifyCooldownError,
  SpotifyServerError,
} from "./rate-guard";

const SPOTIFY_BASE = "https://api.spotify.com";
const MAX_RETRIES = 3;
const MIN_INTERVAL_MS = 100;

interface SpotifyEnv {
  KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
}

export class SpotifyClient {
  private env: SpotifyEnv;
  private lastRequestAt = 0;

  constructor(env: SpotifyEnv) {
    this.env = env;
  }

  private async getValidToken(): Promise<string> {
    const tokens = await getTokens(this.env.KV);
    if (!tokens) {
      throw new Error("No Spotify tokens found. Visit /auth/login first.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < tokens.expiresAt - 60) {
      return tokens.accessToken;
    }

    const refreshed = await refreshAccessToken(this.env, tokens.refreshToken);
    await saveTokens(this.env.KV, refreshed);
    return refreshed.accessToken;
  }

  private async enforceMinInterval(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < MIN_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  async put<T = unknown>(path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    return this.request<T>("PUT", path, params, body);
  }

  async post<T = unknown>(path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, params, body);
  }

  async delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, undefined, body);
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown,
  ): Promise<T> {
    // Chokepoint: check cooldown + kill-switch before any HTTP call
    await assertSpotifyAllowed(this.env.KV);
    await this.enforceMinInterval();

    let token = await this.getValidToken();
    let url = `${SPOTIFY_BASE}${path}`;
    if (params) {
      url += "?" + new URLSearchParams(params).toString();
    }

    const doFetch = (accessToken: string) =>
      fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const resp = await doFetch(token);

      // 429: set persistent cooldown and throw immediately
      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("retry-after") ?? "0", 10) || 3600;
        await setSpotifyCooldown(this.env.KV, retryAfter, `${method} ${path}`);
        throw new SpotifyCooldownError(Date.now() + retryAfter * 1000);
      }

      // 401: refresh token once, retry once
      if (resp.status === 401 && attempt === 0) {
        console.error(`TOKEN_REFRESH_TRIGGERED caller=${method} ${path}`);
        const tokens = await getTokens(this.env.KV);
        if (!tokens) {
          console.error(`TOKEN_REFRESH_ERROR no tokens in KV`);
          throw new Error("No tokens available for refresh");
        }
        try {
          const refreshed = await refreshAccessToken(this.env, tokens.refreshToken);
          await saveTokens(this.env.KV, refreshed);
          token = refreshed.accessToken;
          console.error(`TOKEN_REFRESH_OK new token acquired`);
        } catch (refreshErr) {
          const e = refreshErr instanceof Error ? refreshErr : new Error(String(refreshErr));
          console.error(`TOKEN_REFRESH_ERROR name=${e.name} message=${e.message}`);
          throw refreshErr;
        }
        continue;
      }

      // 5xx: retry with backoff
      if (resp.status >= 500 && attempt < MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
        continue;
      }
      if (resp.status >= 500) {
        throw new SpotifyServerError(
          `Spotify ${method} ${path} (${resp.status}) after ${MAX_RETRIES} retries`,
        );
      }

      if (resp.status === 204) {
        return undefined as T;
      }

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Spotify API ${method} ${path} failed (${resp.status}): ${text}`);
      }

      const contentType = resp.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) {
        return undefined as T;
      }

      return (await resp.json()) as T;
    }

    throw new SpotifyServerError(`Spotify ${method} ${path}: exhausted retries`);
  }
}
