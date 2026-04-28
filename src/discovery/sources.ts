/**
 * sources.ts — pull discovery candidates from all available sources.
 *
 * Sources (rotated daily to stay under Cloudflare's 50-subrequest limit):
 * Day A: 6 followed artists (search for recent tracks)
 * Day B: 4 top artists (search for recent tracks)
 *
 * Note: Spotify editorial playlists (New Music Friday, etc.) return 403
 * in Dev Mode even with Web Playback SDK. User's own playlists are readable
 * but editorial ones are not. We rely on search-based discovery instead.
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


/** Pull candidates — rotates sources daily */
export async function pullAllCandidates(
  spotify: SpotifyClient,
  debug?: string[]
): Promise<DiscoveryCandidate[]> {
  const candidates: DiscoveryCandidate[] = [];
  const day = Math.floor(Date.now() / 86400000);
  const useFollowed = day % 2 === 0;

  // ── 1. Artist-based search (alternates followed vs top) ──
  if (useFollowed) {
    await searchFollowedArtists(spotify, candidates, day, debug);
  } else {
    await searchTopArtists(spotify, candidates, debug);
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

async function searchFollowedArtists(
  spotify: SpotifyClient,
  candidates: DiscoveryCandidate[],
  day: number,
  debug?: string[]
): Promise<void> {
  try {
    const followed = await getFollowedArtists(spotify, 50);
    debug?.push(`Followed artists: ${followed.length}`);

    const batchSize = 6;
    const offset = (day % Math.ceil(followed.length / batchSize)) * batchSize;
    const batch = followed.slice(offset, offset + batchSize);
    debug?.push(`Searching: ${batch.map(a => a.name).join(", ")}`);

    for (const artist of batch) {
      try {
        const year = new Date().getFullYear();
        const resp = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${artist.name}" year:${year}`,
            type: "track", limit: "10", market: "US",
          }
        );
        const tracks = resp.tracks?.items ?? [];
        debug?.push(`  ${artist.name}: ${tracks.length} tracks`);
        for (const track of tracks) {
          candidates.push({
            trackId: track.id, trackName: track.name,
            artistIds: track.artists.map(a => a.id),
            primaryArtistId: track.artists[0]?.id ?? "",
            source: "followed_artist_search", sourceDetail: artist.name,
          });
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    debug?.push(`Followed artists error: ${err}`);
  }
}

async function searchTopArtists(
  spotify: SpotifyClient,
  candidates: DiscoveryCandidate[],
  debug?: string[]
): Promise<void> {
  try {
    const topArtists = await getTopArtists(spotify, "medium_term", 20);
    debug?.push(`Top artists (medium): ${topArtists.length}`);

    for (const artist of topArtists.slice(0, 4)) {
      try {
        const year = new Date().getFullYear();
        const resp = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${artist.name}" year:${year}`,
            type: "track", limit: "10", market: "US",
          }
        );
        const tracks = resp.tracks?.items ?? [];
        debug?.push(`  ${artist.name}: ${tracks.length} tracks`);
        for (const track of tracks) {
          candidates.push({
            trackId: track.id, trackName: track.name,
            artistIds: track.artists.map(a => a.id),
            primaryArtistId: track.artists[0]?.id ?? "",
            source: "top_artist_search", sourceDetail: artist.name,
          });
        }
      } catch { /* skip */ }
    }
  } catch (err) {
    debug?.push(`Top artists error: ${err}`);
  }
}

