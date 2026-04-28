/**
 * poll.ts — cron handler: fetch currently-playing from Spotify, log to D1.
 *
 * Runs every 1 minute via Cloudflare Cron Trigger.
 * Each poll writes one row to poll_observations, even if nothing is playing
 * (we write is_playing=0 so we can detect when playback stops).
 */

import { SpotifyClient } from "../spotify/client";
import { insertPollObservation } from "../db/queries";

interface CurrentlyPlaying {
  is_playing: boolean;
  item: {
    id: string;
    name: string;
    artists: Array<{ id: string; name: string }>;
    album: { id: string };
    duration_ms: number;
  } | null;
  progress_ms: number | null;
  device?: { type: string } | null;
  context?: { uri: string; type: string } | null;
}

export async function handlePoll(env: { DB: D1Database; KV: KVNamespace; SPOTIFY_CLIENT_ID: string; SPOTIFY_CLIENT_SECRET: string }): Promise<void> {
  const spotify = new SpotifyClient(env);
  const now = Math.floor(Date.now() / 1000);

  let data: CurrentlyPlaying | null = null;
  try {
    const resp = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
      headers: {
        Authorization: `Bearer ${await getToken(env)}`,
      },
    });
    // 204 = nothing playing, 200 = something playing
    if (resp.status === 204) {
      data = null;
    } else if (resp.ok) {
      data = await resp.json() as CurrentlyPlaying;
    } else if (resp.status === 401) {
      // Token expired — use the SpotifyClient which handles refresh
      data = await spotify.get<CurrentlyPlaying>("/v1/me/player/currently-playing");
    } else {
      console.error(`Poll: Spotify returned ${resp.status}`);
      return;
    }
  } catch (err) {
    console.error("Poll error:", err);
    return;
  }

  // Nothing playing or no track item
  if (!data || !data.item) {
    await insertPollObservation(env.DB, {
      observed_at: now,
      is_playing: 0,
      track_id: null,
      track_name: null,
      artist_ids: null,
      album_id: null,
      progress_ms: null,
      duration_ms: null,
      device_type: null,
      context_uri: null,
      context_type: null,
    });
    return;
  }

  await insertPollObservation(env.DB, {
    observed_at: now,
    is_playing: data.is_playing ? 1 : 0,
    track_id: data.item.id,
    track_name: data.item.name,
    artist_ids: JSON.stringify(data.item.artists.map(a => a.id)),
    album_id: data.item.album.id,
    progress_ms: data.progress_ms,
    duration_ms: data.item.duration_ms,
    device_type: data.device?.type ?? null,
    context_uri: data.context?.uri ?? null,
    context_type: data.context?.type ?? null,
  });
}

/** Quick token getter — reads directly from KV for the initial fetch */
async function getToken(env: { KV: KVNamespace; SPOTIFY_CLIENT_ID: string; SPOTIFY_CLIENT_SECRET: string }): Promise<string> {
  const { getTokens } = await import("../auth/tokens");
  const { refreshAccessToken } = await import("../auth/spotify-oauth");
  const { saveTokens } = await import("../auth/tokens");

  const tokens = await getTokens(env.KV);
  if (!tokens) throw new Error("No Spotify tokens. Visit /auth/login first.");

  const now = Math.floor(Date.now() / 1000);
  if (now < tokens.expiresAt - 60) {
    return tokens.accessToken;
  }

  const refreshed = await refreshAccessToken(env, tokens.refreshToken);
  await saveTokens(env.KV, refreshed);
  return refreshed.accessToken;
}
