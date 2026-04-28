/**
 * sources.ts — pull discovery candidates from available sources.
 *
 * Spotify Dev Mode blocks /playlists/{id}/tracks and /browse/new-releases.
 * Working sources:
 * 1. Followed artists → search for their recent tracks
 * 2. Search for new tracks by top artists (finds stuff not in the taste model)
 */

import { SpotifyClient } from "../spotify/client";
import { getFollowedArtists, getTopArtists } from "../spotify/library";

export interface DiscoveryCandidate {
  trackId: string;
  trackName: string;
  artistIds: string[];
  primaryArtistId: string;
  source: string;
  sourceDetail?: string;
}

interface SearchTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
  album: { id: string; name: string; release_date: string };
}

/** Pull candidates using search-based discovery */
export async function pullAllCandidates(
  spotify: SpotifyClient,
  debug?: string[]
): Promise<DiscoveryCandidate[]> {
  const candidates: DiscoveryCandidate[] = [];
  const day = Math.floor(Date.now() / 86400000);

  // ── 1. Search for recent tracks from followed artists ──
  try {
    const followed = await getFollowedArtists(spotify, 50);
    debug?.push(`Followed artists: ${followed.length}`);

    // Rotate through 6 artists per day
    const batchSize = 6;
    const offset = (day % Math.ceil(followed.length / batchSize)) * batchSize;
    const batch = followed.slice(offset, offset + batchSize);
    debug?.push(`Checking: ${batch.map(a => a.name).join(", ")}`);

    for (const artist of batch) {
      try {
        // Search for recent tracks by this artist
        const year = new Date().getFullYear();
        const resp = await spotify.get<{
          tracks: { items: SearchTrack[] }
        }>("/v1/search", {
          q: `artist:"${artist.name}" year:${year}`,
          type: "track",
          limit: "10",
          market: "US",
        });

        const tracks = resp.tracks?.items ?? [];
        debug?.push(`  ${artist.name}: ${tracks.length} tracks found`);
        for (const track of tracks) {
          candidates.push({
            trackId: track.id,
            trackName: track.name,
            artistIds: track.artists.map(a => a.id),
            primaryArtistId: track.artists[0]?.id ?? "",
            source: "followed_artist_search",
            sourceDetail: artist.name,
          });
        }
      } catch (err) {
        debug?.push(`  ${artist.name}: error - ${err}`);
      }
    }
  } catch (err) {
    debug?.push(`Followed artists error: ${err}`);
  }

  // ── 2. Search for new tracks by top artists (medium-term) ──
  try {
    const topArtists = await getTopArtists(spotify, "medium_term", 20);
    debug?.push(`Top artists (medium): ${topArtists.length}`);

    // Pick 4 that aren't in the followed batch
    const topBatch = topArtists.slice(0, 4);
    for (const artist of topBatch) {
      try {
        const year = new Date().getFullYear();
        const resp = await spotify.get<{
          tracks: { items: SearchTrack[] }
        }>("/v1/search", {
          q: `artist:"${artist.name}" year:${year}`,
          type: "track",
          limit: "10",
          market: "US",
        });

        const tracks = resp.tracks?.items ?? [];
        for (const track of tracks) {
          candidates.push({
            trackId: track.id,
            trackName: track.name,
            artistIds: track.artists.map(a => a.id),
            primaryArtistId: track.artists[0]?.id ?? "",
            source: "top_artist_search",
            sourceDetail: artist.name,
          });
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    debug?.push(`Top artists error: ${err}`);
  }

  // Deduplicate
  const seen = new Set<string>();
  const deduped = candidates.filter(c => {
    if (seen.has(c.trackId)) return false;
    seen.add(c.trackId);
    return true;
  });
  debug?.push(`Total candidates after dedup: ${deduped.length}`);
  return deduped;
}
