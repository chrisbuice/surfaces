/**
 * rss_extras.ts — additional discovery sources beyond the core 3 RSS feeds.
 *
 * Gorilla vs Bear: indie music blog, RSS titles in "Artist – Track" format
 * Hype Machine: music aggregator JSON API (not RSS), pre-parsed artist+title
 *
 * Both integrate into the existing daily feed rotation in sources.ts.
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
