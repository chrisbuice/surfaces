/**
 * library.ts — fetch user's Spotify library data.
 *
 * Handles pagination for endpoints that return paged results.
 * Used by the taste model rebuild job.
 */

import { SpotifyClient } from "./client";

export interface SpotifyTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string };
  duration_ms: number;
}

export interface SpotifyArtist {
  id: string;
  name: string;
  genres: string[];
}

export interface SpotifyPlaylist {
  id: string;
  name: string;
  owner: { id: string };
  // 'tracks' is the pre-Feb-2026 field name; 'items' is the post-rename name.
  // Remove 'tracks' and the ?? fallback in callers once Spotify confirms
  // the rollout cutoff for grandfathered Dev Mode apps.
  tracks?: { total: number };
  items?: { total: number };
}

interface PaginatedResponse<T> {
  items: T[];
  next: string | null;
  total: number;
}

/** Fetch all saved/liked songs (paginated, up to a limit) */
export async function getSavedTracks(spotify: SpotifyClient, limit = 500): Promise<SpotifyTrack[]> {
  const tracks: SpotifyTrack[] = [];
  let offset = 0;
  const pageSize = 50;

  while (offset < limit) {
    const resp = await spotify.get<PaginatedResponse<{ track: SpotifyTrack }>>(
      "/v1/me/tracks", { limit: String(pageSize), offset: String(offset) }
    );
    for (const item of resp.items) {
      if (item.track) tracks.push(item.track);
    }
    if (!resp.next || resp.items.length < pageSize) break;
    offset += pageSize;
  }
  return tracks;
}

/** Fetch top tracks for a time range */
export async function getTopTracks(
  spotify: SpotifyClient,
  timeRange: "short_term" | "medium_term" | "long_term",
  limit = 50
): Promise<SpotifyTrack[]> {
  const resp = await spotify.get<PaginatedResponse<SpotifyTrack>>(
    "/v1/me/top/tracks", { time_range: timeRange, limit: String(limit) }
  );
  return resp.items;
}

/** Fetch top artists for a time range */
export async function getTopArtists(
  spotify: SpotifyClient,
  timeRange: "short_term" | "medium_term" | "long_term",
  limit = 50
): Promise<SpotifyArtist[]> {
  const resp = await spotify.get<PaginatedResponse<SpotifyArtist>>(
    "/v1/me/top/artists", { time_range: timeRange, limit: String(limit) }
  );
  return resp.items;
}

/** Fetch user's playlists (paginated) */
export async function getUserPlaylists(spotify: SpotifyClient, limit = 200): Promise<SpotifyPlaylist[]> {
  const playlists: SpotifyPlaylist[] = [];
  let offset = 0;
  const pageSize = 50;

  while (offset < limit) {
    const resp = await spotify.get<PaginatedResponse<SpotifyPlaylist>>(
      "/v1/me/playlists", { limit: String(pageSize), offset: String(offset) }
    );
    playlists.push(...resp.items);
    if (!resp.next || resp.items.length < pageSize) break;
    offset += pageSize;
  }
  return playlists;
}

// getPlaylistTracks was removed — /items works only for user-owned playlists,
// and Dev Mode blocks reads of Spotify-owned editorial playlists. All callers
// now use getPlaylistTracksViaEmbed() from embed.ts to handle both cases uniformly.

/** Fetch followed artists (paginated, cursor-based) */
export async function getFollowedArtists(spotify: SpotifyClient, limit = 200): Promise<SpotifyArtist[]> {
  const artists: SpotifyArtist[] = [];
  let after: string | undefined;

  while (artists.length < limit) {
    const params: Record<string, string> = { type: "artist", limit: "50" };
    if (after) params.after = after;

    const resp = await spotify.get<{ artists: { items: SpotifyArtist[]; cursors: { after: string | null } } }>(
      "/v1/me/following", params
    );
    artists.push(...resp.artists.items);
    if (!resp.artists.cursors.after || resp.artists.items.length < 50) break;
    after = resp.artists.cursors.after;
  }
  return artists;
}
