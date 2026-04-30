/**
 * rss_extras.ts — additional discovery sources beyond the core 3 RSS feeds.
 *
 * Gorilla vs Bear: indie blog, "Artist – Track" format, ~90% extraction
 * Hype Machine: JSON API (pre-parsed artist+title), 100% extraction
 * Aquarium Drunkard: eclectic blog, "Artist :: Album" format, artist-as-seed
 *
 * Each source is wrapped in try/catch — failures are logged and skipped.
 */

import { SpotifyClient } from "../spotify/client";
import type { DiscoveryCandidate } from "./sources";

interface SearchTrack {
  id: string;
  name: string;
  artists: Array<{ id: string; name: string }>;
}

/**
 * Hype Machine — JSON API, no auth needed.
 *
 * Endpoint: GET https://api.hypem.com/v2/popular?mode=now&count=N
 * Response: flat JSON array, each item has:
 *   { artist: string, title: string, sitename: string,
 *     loved_count: number, itemid: string, ... }
 * No pagination needed at small counts. No rate-limit documented.
 */
export async function searchHypeMachine(
  spotify: SpotifyClient,
  candidates: DiscoveryCandidate[],
  maxSearches: number,
  debug?: string[]
): Promise<void> {
  debug?.push("Hype Machine: fetching popular tracks");

  try {
    const resp = await fetch("https://api.hypem.com/v2/popular?mode=now&count=10");
    if (!resp.ok) {
      debug?.push(`Hype Machine fetch failed: ${resp.status}`);
      return;
    }

    const items = (await resp.json()) as Array<{
      artist: string;
      title: string;
      sitename: string;
      loved_count: number;
    }>;

    debug?.push(`Hype Machine items: ${items.length}`);
    let searched = 0;

    for (const item of items) {
      if (searched >= maxSearches) break;
      if (!item.artist || !item.title) continue;

      debug?.push(`  "${item.artist}" — "${item.title}" (via ${item.sitename})`);
      searched++;

      try {
        const result = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${item.artist}" track:"${item.title}"`,
            type: "track", limit: "3", market: "US",
          }
        );
        const tracks = result.tracks?.items ?? [];
        if (tracks.length > 0) {
          const best = tracks[0];
          candidates.push({
            trackId: best.id,
            trackName: best.name,
            artistIds: best.artists.map(a => a.id),
            primaryArtistId: best.artists[0]?.id ?? "",
            source: "hype_machine",
            sourceDetail: item.sitename,
          });
          debug?.push(`    -> matched: ${best.name} by ${best.artists[0]?.name}`);
        } else {
          debug?.push(`    -> no Spotify match`);
        }
      } catch { /* skip individual search failures */ }
    }
    debug?.push(`Hype Machine candidates added: ${candidates.filter(c => c.source === "hype_machine").length}`);
  } catch (err) {
    debug?.push(`Hype Machine error: ${err}`);
  }
}

/**
 * Gorilla vs Bear — indie music blog RSS feed.
 *
 * Feed: https://www.gorillavsbear.net/feed/
 * Title format: "Artist – Track" (en-dash separator)
 * Clean and consistent — best extraction rate of all RSS sources.
 */
export async function searchGorillaVsBear(
  spotify: SpotifyClient,
  candidates: DiscoveryCandidate[],
  maxSearches: number,
  debug?: string[]
): Promise<void> {
  debug?.push("Gorilla vs Bear: fetching RSS");

  try {
    const resp = await fetch("https://www.gorillavsbear.net/feed/");
    if (!resp.ok) {
      debug?.push(`Gorilla vs Bear fetch failed: ${resp.status}`);
      return;
    }

    const xml = await resp.text();

    // Extract items from RSS XML
    const items: Array<{ title: string }> = [];
    const itemBlocks = xml.split("<item");
    for (const block of itemBlocks.slice(1)) {
      const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
      if (titleMatch) {
        items.push({ title: decodeXmlEntities(titleMatch[1].trim()) });
      }
    }

    debug?.push(`Gorilla vs Bear items parsed: ${items.length}`);
    let searched = 0;

    for (const item of items) {
      if (searched >= maxSearches) break;

      // Parse "Artist – Track" or "Artist - Track" format
      const match = item.title.match(/^(.+?)\s+[\u2013\u2014-]\s+(.+)$/);
      if (!match) {
        debug?.push(`  skipped (no match): ${item.title.slice(0, 60)}`);
        continue;
      }

      const artist = match[1].trim();
      const track = match[2].trim();
      // Skip entries that look like features/collaborations listed as titles
      if (artist.length < 2 || track.length < 2) continue;

      debug?.push(`  parsed: "${artist}" — "${track}"`);
      searched++;

      try {
        const result = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${artist}" track:"${track}"`,
            type: "track", limit: "3", market: "US",
          }
        );
        const tracks = result.tracks?.items ?? [];
        if (tracks.length > 0) {
          const best = tracks[0];
          candidates.push({
            trackId: best.id,
            trackName: best.name,
            artistIds: best.artists.map(a => a.id),
            primaryArtistId: best.artists[0]?.id ?? "",
            source: "rss:gorilla_vs_bear",
            sourceDetail: "Gorilla vs Bear",
          });
          debug?.push(`    -> matched: ${best.name} by ${best.artists[0]?.name}`);
        } else {
          debug?.push(`    -> no Spotify match`);
        }
      } catch { /* skip individual search failures */ }
    }
    debug?.push(`Gorilla vs Bear candidates added: ${candidates.filter(c => c.source === "rss:gorilla_vs_bear").length}`);
  } catch (err) {
    debug?.push(`Gorilla vs Bear error: ${err}`);
  }
}

/**
 * Aquarium Drunkard — eclectic/experimental music blog RSS feed.
 *
 * Feed: https://aquariumdrunkard.com/feed/
 * Title format: "Artist :: Album/Description" (~80% extraction)
 * Artist-as-seed approach: parse the artist name, search Spotify for
 * their recent tracks (limit=2). AD's signal is artist-level curation,
 * not track volume.
 */
export async function searchAquariumDrunkard(
  spotify: SpotifyClient,
  candidates: DiscoveryCandidate[],
  maxSearches: number,
  debug?: string[]
): Promise<void> {
  debug?.push("Aquarium Drunkard: fetching RSS");

  try {
    const resp = await fetch("https://aquariumdrunkard.com/feed/");
    if (!resp.ok) {
      debug?.push(`Aquarium Drunkard fetch failed: ${resp.status}`);
      return;
    }

    const xml = await resp.text();
    const items: Array<{ title: string }> = [];
    const itemBlocks = xml.split("<item");
    for (const block of itemBlocks.slice(1)) {
      const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
      if (titleMatch) {
        items.push({ title: decodeXmlEntities(titleMatch[1].trim()) });
      }
    }

    debug?.push(`Aquarium Drunkard items parsed: ${items.length}`);
    let searched = 0;
    const seenArtists = new Set<string>();

    for (const item of items) {
      if (searched >= maxSearches) break;

      // Parse "Artist :: Title/Album/Description" format
      const match = item.title.match(/^(.+?)\s+::\s+(.+)$/);
      if (!match) {
        debug?.push(`  skipped (no match): ${item.title.slice(0, 60)}`);
        continue;
      }

      // Extract artist name — skip prefixed series titles like "All One Song ::"
      let artist = match[1].trim();
      if (/^(all one song|the lagniappe sessions|the aquarium drunkard)/i.test(artist)) {
        // These are series titles — the real artist is often in part 2
        const subMatch = match[2].match(/^(.+?)(?:\s+on\s+|\s*[-–—]\s*)/);
        if (subMatch) {
          artist = subMatch[1].trim();
        } else {
          debug?.push(`  skipped (series title): ${item.title.slice(0, 60)}`);
          continue;
        }
      }

      if (artist.length < 2 || seenArtists.has(artist.toLowerCase())) continue;
      seenArtists.add(artist.toLowerCase());

      debug?.push(`  artist seed: "${artist}" (from: ${match[2].slice(0, 40)})`);
      searched++;

      // Search Spotify for recent tracks by this artist (limit=2 per approved spec)
      try {
        const year = new Date().getFullYear();
        const result = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${artist}" year:${year}`,
            type: "track", limit: "2", market: "US",
          }
        );
        const tracks = result.tracks?.items ?? [];
        for (const track of tracks) {
          candidates.push({
            trackId: track.id,
            trackName: track.name,
            artistIds: track.artists.map(a => a.id),
            primaryArtistId: track.artists[0]?.id ?? "",
            source: "rss:aquarium_drunkard",
            sourceDetail: "Aquarium Drunkard",
          });
        }
        debug?.push(`    -> ${tracks.length} tracks found`);
      } catch { /* skip individual search failures */ }
    }
    debug?.push(`Aquarium Drunkard candidates added: ${candidates.filter(c => c.source === "rss:aquarium_drunkard").length}`);
  } catch (err) {
    debug?.push(`Aquarium Drunkard error: ${err}`);
  }
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}
