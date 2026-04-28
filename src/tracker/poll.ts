/**
 * poll.ts — cron handler: fetch player state from Spotify, log to D1.
 *
 * Runs every 1 minute via Cloudflare Cron Trigger.
 * Uses /me/player (full player state) instead of /me/player/currently-playing
 * so we get device info, context, and playback state in one call.
 */

import { SpotifyClient } from "../spotify/client";
import { insertPollObservation } from "../db/queries";

interface PlayerState {
  is_playing: boolean;
  item: {
    id: string;
    name: string;
    artists: Array<{ id: string; name: string }>;
    album: { id: string };
    duration_ms: number;
  } | null;
  progress_ms: number | null;
  device: { id: string; name: string; type: string; is_active: boolean } | null;
  context: { uri: string; type: string } | null;
}

export async function handlePoll(env: { DB: D1Database; KV: KVNamespace; SPOTIFY_CLIENT_ID: string; SPOTIFY_CLIENT_SECRET: string }): Promise<void> {
  const spotify = new SpotifyClient(env);
  const now = Math.floor(Date.now() / 1000);

  let data: PlayerState | null = null;
  try {
    // Use /me/player for full state including device info
    data = await spotify.get<PlayerState>("/v1/me/player");
  } catch {
    // 204 (nothing playing) comes back as undefined from our client
    data = null;
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

  // Build device string: "Computer" or "Smartphone" etc.
  // Also store device name in context_uri field comment for richer data
  const deviceType = data.device?.type ?? null;

  await insertPollObservation(env.DB, {
    observed_at: now,
    is_playing: data.is_playing ? 1 : 0,
    track_id: data.item.id,
    track_name: data.item.name,
    artist_ids: JSON.stringify(data.item.artists.map(a => a.id)),
    album_id: data.item.album.id,
    progress_ms: data.progress_ms,
    duration_ms: data.item.duration_ms,
    device_type: deviceType,
    context_uri: data.context?.uri ?? null,
    context_type: data.context?.type ?? null,
  });

  // Also cache the device name in KV for the dashboard
  if (data.device) {
    await env.KV.put("context:current_device", JSON.stringify({
      name: data.device.name,
      type: data.device.type,
      updatedAt: now,
    }));
  }
}
