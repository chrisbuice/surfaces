/**
 * spotify-oauth.ts — Spotify Authorization Code flow.
 *
 * /auth/login   → redirects user to Spotify's consent screen
 * /auth/callback → Spotify redirects back here with a code; we exchange it for tokens
 *
 * Scopes requested match §12 of the plan.
 */

import { saveTokens } from "./tokens";

const SCOPES = [
  "user-read-private",
  "user-read-email",
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-recently-played",
  "user-top-read",
  "user-library-read",
  "user-library-modify",
  "user-follow-read",
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-private",
  "playlist-modify-public",
].join(" ");

interface Env {
  KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
}

/** Step 1: redirect user to Spotify login */
export function handleLogin(request: Request, env: Env): Response {
  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/callback`;

  const params = new URLSearchParams({
    response_type: "code",
    client_id: env.SPOTIFY_CLIENT_ID,
    scope: SCOPES,
    redirect_uri: redirectUri,
    show_dialog: "true",
  });

  return Response.redirect(`https://accounts.spotify.com/authorize?${params}`, 302);
}

/** Step 2: exchange the authorization code for tokens */
export async function handleCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");

  if (error) {
    return new Response(`Spotify auth error: ${error}`, { status: 400 });
  }
  if (!code) {
    return new Response("Missing authorization code", { status: 400 });
  }

  const redirectUri = `${url.origin}/auth/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    return new Response(`Token exchange failed: ${text}`, { status: 500 });
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  await saveTokens(env.KV, {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
  });

  return new Response(
    "Spotify auth complete! Tokens saved. You can close this tab.",
    { status: 200, headers: { "Content-Type": "text/plain" } }
  );
}

/** Refresh an expired access token using the refresh token */
export async function refreshAccessToken(env: Env, refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${btoa(`${env.SPOTIFY_CLIENT_ID}:${env.SPOTIFY_CLIENT_SECRET}`)}`,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token refresh failed: ${text}`);
  }

  const data = (await resp.json()) as {
    access_token: string;
    refresh_token?: string; // Spotify may or may not rotate the refresh token
    expires_in: number;
  };

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? refreshToken, // keep old if not rotated
    expiresAt: Math.floor(Date.now() / 1000) + data.expires_in,
  };
}
