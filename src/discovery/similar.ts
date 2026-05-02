/**
 * similar.ts — Last.fm-based discovery: find tracks by similar artists.
 *
 * For each seed artist (top by taste_score), fetches similar artists from
 * Last.fm, then searches Spotify for recent tracks by those similar artists.
 *
 * Subrequest budget: up to 6 Last.fm calls + up to 24 Spotify searches = 30.
 * Worst-case total per discovery run (with existing sources) ≈ 46 of 50 limit.
 * A runtime counter aborts early if approaching 25 new subrequests to leave
 * headroom for the existing artist-search and RSS sources.
 */

import { SpotifyClient } from "../spotify/client";
import { LastFmClient } from "./lastfm";
import type { DiscoveryCandidate } from "./sources";

const MAX_SEED_ARTISTS = 6;
const SIMILAR_PER_ARTIST = 4;
const MAX_SUBREQUESTS = 80; // paid tier: 1000 subrequest limit, let Last.fm run to completion

interface SearchTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
}

/** Pull discovery candidates via Last.fm similar-artist graph */
export async function pullLastFmCandidates(
  spotify: SpotifyClient,
  db: D1Database,
  apiKey: string,
  debug?: string[]
): Promise<DiscoveryCandidate[]> {
  const lastfm = new LastFmClient(apiKey, db);
  const candidates: DiscoveryCandidate[] = [];
  let subrequests = 0;

  // Load top seed artists by taste_score
  const seedRows = await db.prepare(
    "SELECT artist_id, artist_name FROM artist_taste WHERE artist_name != '' ORDER BY taste_score DESC LIMIT ?"
  ).bind(MAX_SEED_ARTISTS).all<{ artist_id: string; artist_name: string }>();

  debug?.push(`Last.fm seeds: ${seedRows.results.map(a => a.artist_name).join(", ")}`);

  for (const seed of seedRows.results) {
    if (subrequests >= MAX_SUBREQUESTS) {
      debug?.push(`Last.fm: hit subrequest cap (${subrequests}), stopping early`);
      break;
    }

    // Fetch similar artists from Last.fm (cached after first call)
    let similarArtists: Array<{ name: string; match: number }> = [];
    try {
      const result = await lastfm.getSimilarArtists(seed.artist_name, SIMILAR_PER_ARTIST);
      similarArtists = result.artists;
      if (!result.cached) subrequests++;
      debug?.push(`  ${seed.artist_name}: ${similarArtists.length} similar (${result.cached ? "cache HIT" : "cache MISS"})`);
    } catch (err) {
      debug?.push(`  ${seed.artist_name}: Last.fm error — ${err}`);
      continue;
    }

    // Search Spotify for recent tracks by each similar artist
    for (const similar of similarArtists) {
      if (subrequests >= MAX_SUBREQUESTS) break;

      try {
        const year = new Date().getFullYear();
        const resp = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${similar.name}" year:${year}`,
            type: "track", limit: "5", market: "US",
          }
        );
        subrequests++;

        const tracks = resp.tracks?.items ?? [];
        debug?.push(`    ${similar.name} (match=${similar.match.toFixed(2)}): ${tracks.length} tracks`);

        for (const track of tracks) {
          candidates.push({
            trackId: track.id,
            trackName: track.name,
            artistIds: track.artists.map(a => a.id),
            primaryArtistId: track.artists[0]?.id ?? "",
            source: "lastfm:artist_similar",
            sourceDetail: `${similar.name} (similar to ${seed.artist_name})`,
          });
        }
      } catch {
        debug?.push(`    ${similar.name}: Spotify search error`);
      }
    }
  }

  debug?.push(`Last.fm total: ${candidates.length} candidates, ${subrequests} subrequests`);
  return candidates;
}
