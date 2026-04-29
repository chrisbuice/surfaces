/**
 * sources.ts — pull discovery candidates from all available sources.
 *
 * Sources (rotated daily to stay under Cloudflare's 50-subrequest limit):
 * Day A: 6 followed artists (search for recent tracks)
 * Day B: 4 top artists (search for recent tracks)
 * Every day: 1 editorial RSS feed (rotated among Stereogum, Line of Best Fit, EARMILK)
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

// ── Editorial RSS feed configuration ──

interface RssFeedConfig {
  name: string;
  url: string;
  titlePatterns: RegExp[];
}

const RSS_FEEDS: RssFeedConfig[] = [
  {
    name: "Stereogum",
    url: "https://stereogum.com/feed",
    titlePatterns: [
      /^(.+?)\s+(?:Shares?|Announces?|Releases?|Unveils?|Debuts?|Drops?|Premieres?)\b.+["\u201C\u201D](.+?)["\u201C\u201D]/i,
      /^(.+?)\s+.*["\u201C\u201D](.+?)["\u201C\u201D]/i,
    ],
  },
  {
    name: "The Line of Best Fit",
    url: "https://feeds.feedburner.com/TheLineOfBestFit",
    titlePatterns: [
      /^(.+?)(?:'s)?\s+(?:unveils?|shares?|releases?|announces?|debuts?|drops?|premieres?|returns?\s+with)\b.+[,:]?\s*['\u2018\u2019"\u201C\u201D](.+?)['\u2018\u2019"\u201C\u201D]/i,
      /^(.+?)\s+.*['\u2018\u2019"\u201C\u201D](.+?)['\u2018\u2019"\u201C\u201D]/i,
    ],
  },
  {
    name: "EARMILK",
    url: "https://earmilk.com/feed",
    titlePatterns: [
      /^(.+?)\s+(?:releases?|shares?|explores?|unveils?|debuts?|drops?|premieres?|returns?\s+with)\b.+['\u2018\u2019"\u201C\u201D](.+?)['\u2018\u2019"\u201C\u201D]/i,
      /^(.+?)\s+.*['\u2018\u2019"\u201C\u201D](.+?)['\u2018\u2019"\u201C\u201D]/i,
    ],
  },
];

// ── RSS parsing helpers ──

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

function extractRssItems(xml: string): Array<{ title: string }> {
  const items: Array<{ title: string }> = [];
  const itemBlocks = xml.split("<item");
  for (const block of itemBlocks.slice(1)) {
    const titleMatch = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s);
    if (titleMatch) {
      items.push({ title: decodeXmlEntities(titleMatch[1].trim()) });
    }
  }
  return items;
}

function parseTrackFromTitle(
  title: string,
  patterns: RegExp[]
): { artist: string; track: string } | null {
  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match && match[1] && match[2]) {
      return { artist: match[1].trim(), track: match[2].trim() };
    }
  }
  return null;
}

// ── Main entry point ──

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

  // ── 2. Editorial RSS feed (1 feed per day, rotated) ──
  await searchEditorialRss(spotify, candidates, day, debug);

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

// ── Artist-based sources ──

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

// ── Editorial RSS source ──

async function searchEditorialRss(
  spotify: SpotifyClient,
  candidates: DiscoveryCandidate[],
  day: number,
  debug?: string[]
): Promise<void> {
  const feed = RSS_FEEDS[day % RSS_FEEDS.length];
  debug?.push(`RSS feed today: ${feed.name} (${feed.url})`);

  try {
    const resp = await fetch(feed.url);
    if (!resp.ok) {
      debug?.push(`RSS fetch failed: ${resp.status}`);
      return;
    }
    const xml = await resp.text();
    const items = extractRssItems(xml);
    debug?.push(`RSS items parsed: ${items.length}`);

    let searched = 0;
    const MAX_SEARCHES = 10;

    for (const item of items) {
      if (searched >= MAX_SEARCHES) break;
      const parsed = parseTrackFromTitle(item.title, feed.titlePatterns);
      if (!parsed) {
        debug?.push(`  skipped (no track): ${item.title.slice(0, 60)}`);
        continue;
      }

      debug?.push(`  parsed: "${parsed.artist}" — "${parsed.track}"`);
      searched++;

      try {
        const result = await spotify.get<{ tracks: { items: SearchTrack[] } }>(
          "/v1/search", {
            q: `artist:"${parsed.artist}" track:"${parsed.track}"`,
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
            source: "editorial_rss",
            sourceDetail: feed.name,
          });
          debug?.push(`    -> matched: ${best.name} by ${best.artists[0]?.name}`);
        } else {
          debug?.push(`    -> no Spotify match`);
        }
      } catch { /* skip individual search failures */ }
    }
    debug?.push(`RSS candidates added: ${candidates.filter(c => c.source === "editorial_rss").length}`);
  } catch (err) {
    debug?.push(`RSS error: ${err}`);
  }
}
