/**
 * resolve_playing.ts — Resolve the currently-playing track from Spotify.
 *
 * Extracted so the fallback path in explain_song is testable via vi.mock
 * in vitest-pool-workers (where mocking SpotifyClient directly doesn't
 * propagate into the worker module graph).
 */

import type { Env } from "../index";
import { SpotifyClient } from "../spotify/client";

export interface ResolvedTrack {
  uri: string;
  track_name: string;
  artist_name: string;
}

export async function resolveCurrentlyPlaying(env: Env): Promise<ResolvedTrack | null> {
  const spotify = new SpotifyClient(env);
  const playing = await spotify.get<{
    item?: { uri: string; name: string; artists: Array<{ name: string }> } | null;
  }>("/v1/me/player/currently-playing");

  if (!playing?.item) return null;

  return {
    uri: playing.item.uri,
    track_name: playing.item.name,
    artist_name: playing.item.artists.map((a) => a.name).join(", "),
  };
}
