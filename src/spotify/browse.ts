/**
 * browse.ts — Spotify browse/discovery helpers.
 *
 * Remaining functions after Feb 2026 API audit cleanup:
 * - getArtistRecentReleases: used by /debug/discovery-sources
 * - findPlaylistByName: used by /debug/discovery-sources
 *
 * Removed (dead code referencing removed/renamed endpoints):
 * - getNewReleases (/v1/browse/new-releases — removed Feb 2026)
 * - getAlbumTracks (/v1/albums/{id}/tracks — no callers)
 * - getEditorialPlaylistTracks (/v1/playlists/{id}/tracks — renamed to /items, no callers)
 */

import { SpotifyClient } from "./client";

interface Album {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album_type: string;
  release_date: string;
  total_tracks: number;
}

/** Get recent albums/singles from a specific artist (last N days) */
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
