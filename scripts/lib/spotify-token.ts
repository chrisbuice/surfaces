/**
 * spotify-token.ts — Read Spotify access token from Cloudflare KV for local scripts.
 *
 * Reads the token stored by the Worker's auth flow. If the token is within
 * 5 minutes of expiry, refreshes it via Spotify's token endpoint and writes
 * the new values back to KV so the Worker stays in sync.
 *
 * Refresh requires SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET env vars.
 * If the token is still valid, no env vars are needed.
 */

import { execSync } from "child_process";

const KV_NAMESPACE_ID = "7055b925a6b74bd39150201370724eeb";
const SPOTIFY_CLIENT_ID = "1a78c31c5d7c40f7811ebd6577fc3b6a";

function kvGet(key: string): string | null {
  try {
    const result = execSync(
      `npx wrangler kv key get "${key}" --namespace-id=${KV_NAMESPACE_ID} --remote --text`,
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

function kvPut(key: string, value: string): void {
  execSync(
    `npx wrangler kv key put "${key}" "${value}" --namespace-id=${KV_NAMESPACE_ID} --remote`,
    { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
  );
}

async function refreshToken(refreshTokenValue: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!clientSecret) {
    throw new Error(
      "Token expired and SPOTIFY_CLIENT_SECRET env var is not set. " +
      "Either set it or wait for the Worker cron to refresh the token.",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshTokenValue,
  });

  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${clientSecret}`).toString("base64")}`,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed (${resp.status}): ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshTokenValue,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
  };
}

/**
 * Get a valid Spotify access token. Reads from KV; refreshes if within
 * 5 minutes of expiry (requires SPOTIFY_CLIENT_SECRET env var for refresh).
 */
export async function getSpotifyAccessToken(): Promise<string> {
  const accessToken = kvGet("spotify:access_token");
  const refreshTokenValue = kvGet("spotify:refresh_token");
  const expiresStr = kvGet("spotify:token_expires");

  if (!accessToken || !refreshTokenValue) {
    throw new Error("No Spotify tokens in KV. Run /auth/login on the Worker first.");
  }

  const expiresAt = expiresStr ? parseInt(expiresStr, 10) : 0;
  const now = Math.floor(Date.now() / 1000);

  // If token is valid for more than 5 minutes, use it directly
  if (now < expiresAt - 300) {
    return accessToken;
  }

  // Token is expired or close to expiry — refresh it
  console.log("  Token expired or near expiry, refreshing...");
  const refreshed = await refreshToken(refreshTokenValue);

  // Write refreshed values back to KV
  kvPut("spotify:access_token", refreshed.accessToken);
  kvPut("spotify:refresh_token", refreshed.refreshToken);
  kvPut("spotify:token_expires", refreshed.expiresAt.toString());
  console.log("  Token refreshed and saved to KV.");

  return refreshed.accessToken;
}
