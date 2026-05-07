/**
 * musicbrainz-isrc.ts — Find ISRCs for tracks via MusicBrainz recording search.
 *
 * Rate limit: 1 req/sec (hard MB requirement).
 * User-Agent: surfaces/1.0 ( chrisbuice@gmail.com ) — required by MB policy.
 *
 * Searches for recordings by (artist, track), returns the ISRC from the
 * top result. Scans top 3 results if the first has no ISRCs.
 */

import { RateLimiter } from "./rate-limiter";

const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "surfaces/1.0 ( chrisbuice@gmail.com )";
const MAX_RESULTS_TO_SCAN = 3;

const limiter = new RateLimiter(1); // 1 req/sec

interface MBRecording {
  id: string;
  score: number;
  isrcs?: string[];
  title: string;
}

interface MBSearchResponse {
  recordings?: MBRecording[];
}

/**
 * Search MusicBrainz for a recording and return the first ISRC found.
 * Scans the top 3 results before giving up.
 */
export async function findIsrc(
  artist: string,
  track: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const query = `recording:"${escapeQuery(track)}" AND artist:"${escapeQuery(artist)}"`;
  const url = `${MB_BASE}/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${MAX_RESULTS_TO_SCAN}`;

  await limiter.wait();

  let res: Response;
  try {
    res = await fetchFn(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
  } catch {
    return null;
  }

  if (!res.ok) return null;

  const data = (await res.json()) as MBSearchResponse;
  if (!data.recordings || data.recordings.length === 0) return null;

  // Scan top results for one with an ISRC
  for (const recording of data.recordings.slice(0, MAX_RESULTS_TO_SCAN)) {
    if (recording.isrcs && recording.isrcs.length > 0) {
      return recording.isrcs[0];
    }
  }

  return null;
}

function escapeQuery(s: string): string {
  // Escape special Lucene characters that could break the query
  return s.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, "\\$&");
}
