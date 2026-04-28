/**
 * browse.ts — Spotify browse/discovery endpoints.
 *
 * New releases, followed artists' recent releases, editorial playlist tracks.
 */

import { SpotifyClient } from "./client";
import type { SpotifyTrack } from "./library";

interface Album {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album_type: string;
  release_date: string;
  total_tracks: number;
}

interface AlbumTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  duration_ms: number;
}

/** Fetch new releases from Spotify browse */
export async function getNewReleases(spotify: SpotifyClient, limit = 50): Promise<Album[]> {
  const resp = await spotify.get<{ albums: { items: Album[] } }>(
    "/v1/browse/new-releases", { limit: String(limit) }
  );
  return resp.albums.items;
}

/** Get tracks from an album */
export async function getAlbumTracks(spotify: SpotifyClient, albumId: string): Promise<AlbumTrack[]> {
  const resp = await spotify.get<{ items: AlbumTrack[] }>(
    `/v1/albums/${albumId}/tracks`, { limit: "50" }
  );
  return resp.items;
}

/** Get recent albums/singles from a specific artist (last 14 days) */
export async function getArtistRecentReleases(
  spotify: SpotifyClient,
  artistId: string,
  daysBack = 14
): Promise<Album[]> {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysBack);
  const cutoffStr = cutoff.toISOString().split("T")[0]; // YYYY-MM-DD

  try {
    const resp = await spotify.get<{ items: Album[] }>(
      `/v1/artists/${artistId}/albums`,
      { include_groups: "album,single", limit: "10", market: "US" }
    );
    return resp.items.filter(a => a.release_date >= cutoffStr);
  } catch {
    return []; // Some artist IDs may be invalid
  }
}

/** Fetch tracks from an editorial playlist by ID */
export async function getEditorialPlaylistTracks(
  spotify: SpotifyClient,
  playlistId: string,
  limit = 100
): Promise<SpotifyTrack[]> {
  try {
    const resp = await spotify.get<{
      items: Array<{ track: SpotifyTrack | null }>;
    }>(`/v1/playlists/${playlistId}/tracks`, {
      limit: String(limit),
      fields: "items(track(id,name,artists(id,name),album(id,name),duration_ms))",
    });
    return resp.items
      .map(i => i.track)
      .filter((t): t is SpotifyTrack => t !== null && t.id !== null);
  } catch {
    console.warn(`Failed to fetch editorial playlist ${playlistId}`);
    return [];
  }
}

/** Search for a playlist by name and return its ID (for finding editorial playlists) */
export async function findPlaylistByName(
  spotify: SpotifyClient,
  name: string
): Promise<{ id: string; name: string; owner: string } | null> {
  const resp = await spotify.get<{
    playlists: {
      items: Array<{
        id: string;
        name: string;
        owner: { id: string; display_name: string };
      } | null>;
    };
  }>("/v1/search", { q: name, type: "playlist", limit: "10" });

  // Filter nulls
  const items = (resp.playlists?.items ?? []).filter(
    (p): p is NonNullable<typeof p> => p !== null && p?.owner !== null
  );

  // Best match: exact name + owned by "spotify"
  const exactEditorial = items.find(
    p => p.name.toLowerCase() === name.toLowerCase() && p.owner?.id === "spotify"
  );
  if (exactEditorial) return { id: exactEditorial.id, name: exactEditorial.name, owner: exactEditorial.owner.id };

  // Next: any Spotify-owned result
  const anyEditorial = items.find(p => p.owner?.id === "spotify");
  if (anyEditorial) return { id: anyEditorial.id, name: anyEditorial.name, owner: anyEditorial.owner.id };

  // Fallback: first result
  return items[0] ? { id: items[0].id, name: items[0].name, owner: items[0].owner.id } : null;
}
