/**
 * playback.ts — Spotify playback control.
 *
 * Play tracks, queue tracks, get available devices.
 */

import { SpotifyClient } from "./client";

export interface SpotifyDevice {
  id: string;
  name: string;
  type: string;
  is_active: boolean;
}

/** Get available playback devices */
export async function getDevices(spotify: SpotifyClient): Promise<SpotifyDevice[]> {
  const resp = await spotify.get<{ devices: SpotifyDevice[] }>("/v1/me/player/devices");
  return resp.devices;
}

/** Get the active device, or the first available one */
export async function getActiveDevice(spotify: SpotifyClient): Promise<SpotifyDevice | null> {
  const devices = await getDevices(spotify);
  return devices.find(d => d.is_active) ?? devices[0] ?? null;
}

/**
 * Start playing a list of tracks.
 * This replaces whatever is currently playing.
 */
export async function playTracks(
  spotify: SpotifyClient,
  trackIds: string[],
  deviceId?: string
): Promise<void> {
  const uris = trackIds.map(id => `spotify:track:${id}`);
  const params: Record<string, string> = {};
  if (deviceId) params.device_id = deviceId;

  await spotify.put("/v1/me/player/play", { uris }, params);
}

/**
 * Add tracks to the queue (doesn't disrupt current playback).
 * Spotify's queue endpoint only accepts one track at a time, via query param.
 */
export async function queueTracks(
  spotify: SpotifyClient,
  trackIds: string[],
  deviceId?: string
): Promise<void> {
  for (const id of trackIds) {
    const params: Record<string, string> = {
      uri: `spotify:track:${id}`,
    };
    if (deviceId) params.device_id = deviceId;
    await spotify.post("/v1/me/player/queue", undefined, params);
  }
}

/**
 * Create a Spotify playlist and add tracks to it.
 * Returns the playlist ID.
 */
export async function createPlaylist(
  spotify: SpotifyClient,
  _userId: string,
  name: string,
  trackIds: string[]
): Promise<string> {
  const playlist = await spotify.post<{ id: string }>(
    "/v1/me/playlists",
    { name, public: false }
  );

  if (trackIds.length > 0) {
    const uris = trackIds.map(id => `spotify:track:${id}`);
    // Use /items endpoint (works in Dev Mode; /tracks returns 403)
    for (let i = 0; i < uris.length; i += 100) {
      await spotify.post(`/v1/playlists/${playlist.id}/items`, {
        uris: uris.slice(i, i + 100),
      });
    }
  }

  return playlist.id;
}
