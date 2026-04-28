/**
 * client.ts — thin Spotify API wrapper with automatic token refresh.
 *
 * Usage:
 *   const spotify = new SpotifyClient(env);
 *   const profile = await spotify.get("/v1/me");
 *
 * Handles:
 * - Adding the Authorization header
 * - Auto-refreshing on 401
 * - One retry after refresh
 */

import { getTokens, saveTokens, type TokenData } from "../auth/tokens";
import { refreshAccessToken } from "../auth/spotify-oauth";

const SPOTIFY_BASE = "https://api.spotify.com";

interface SpotifyEnv {
  KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
}

export class SpotifyClient {
  private env: SpotifyEnv;

  constructor(env: SpotifyEnv) {
    this.env = env;
  }

  /** Ensure we have a valid access token, refreshing if needed */
  private async getValidToken(): Promise<string> {
    const tokens = await getTokens(this.env.KV);
    if (!tokens) {
      throw new Error("No Spotify tokens found. Visit /auth/login first.");
    }

    const now = Math.floor(Date.now() / 1000);
    if (now < tokens.expiresAt - 60) {
      return tokens.accessToken;
    }

    // Token expired or about to expire — refresh
    const refreshed = await refreshAccessToken(this.env, tokens.refreshToken);
    await saveTokens(this.env.KV, refreshed);
    return refreshed.accessToken;
  }

  /** Make a GET request to the Spotify API */
  async get<T = unknown>(path: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>("GET", path, params);
  }

  /** Make a PUT request to the Spotify API */
  async put<T = unknown>(path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    return this.request<T>("PUT", path, params, body);
  }

  /** Make a POST request to the Spotify API */
  async post<T = unknown>(path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    return this.request<T>("POST", path, params, body);
  }

  /** Make a DELETE request to the Spotify API */
  async delete<T = unknown>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("DELETE", path, undefined, body);
  }

  private async request<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
    body?: unknown
  ): Promise<T> {
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

    let resp = await doFetch(token);

    // Auto-retry on 401 after refreshing the token
    if (resp.status === 401) {
      const tokens = await getTokens(this.env.KV);
      if (!tokens) throw new Error("No tokens available for refresh");
      const refreshed = await refreshAccessToken(this.env, tokens.refreshToken);
      await saveTokens(this.env.KV, refreshed);
      token = refreshed.accessToken;
      resp = await doFetch(token);
    }

    if (resp.status === 204) {
      return undefined as T;
    }

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Spotify API ${method} ${path} failed (${resp.status}): ${text}`);
    }

    // Some endpoints return non-JSON (e.g. queue returns a snapshot ID string)
    const contentType = resp.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      return undefined as T;
    }

    return (await resp.json()) as T;
  }
}
