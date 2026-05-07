/**
 * itunes-lookup.ts — Apple iTunes Lookup API client.
 *
 * Given an Apple track ID, returns clean metadata (artist, track, album,
 * duration, release date, genre). Free, no auth. ~20 req/sec safe;
 * we limit to 15 req/sec for headroom.
 */

import { RateLimiter } from "./rate-limiter";

// ── Types ──

export interface ItunesTrack {
  artistName: string;
  trackName: string;
  collectionName: string;
  trackTimeMillis: number;
  releaseDate: string;
  primaryGenreName: string;
  artistId: number;
  collectionId: number;
  previewUrl: string | null;
}

// ── Rate limiter ──

const limiter = new RateLimiter(15); // 15 req/sec

// ── Public API ──

const MAX_RETRIES = 3;

/**
 * Look up a single track by Apple track ID.
 * Returns null on 404 or if the track isn't found in the response.
 * Retries on 5xx errors.
 */
export async function lookupTrack(
  appleTrackId: string,
  fetchFn: typeof fetch = fetch,
): Promise<ItunesTrack | null> {
  const url = `https://itunes.apple.com/lookup?id=${encodeURIComponent(appleTrackId)}&entity=song`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.wait();

    let res: Response;
    try {
      res = await fetchFn(url);
    } catch {
      // Network error — retry
      if (attempt === MAX_RETRIES) return null;
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    if (res.status === 404) return null;

    if (res.status >= 500) {
      if (attempt === MAX_RETRIES) return null;
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    if (!res.ok) return null;

    const data = (await res.json()) as {
      resultCount: number;
      results: Array<Record<string, unknown>>;
    };

    if (!data.results || data.resultCount === 0) return null;

    // First result with wrapperType=track is the one we want
    const track = data.results.find((r) => r.wrapperType === "track");
    if (!track) return null;

    return {
      artistName: String(track.artistName ?? ""),
      trackName: String(track.trackName ?? ""),
      collectionName: String(track.collectionName ?? ""),
      trackTimeMillis: Number(track.trackTimeMillis ?? 0),
      releaseDate: String(track.releaseDate ?? ""),
      primaryGenreName: String(track.primaryGenreName ?? ""),
      artistId: Number(track.artistId ?? 0),
      collectionId: Number(track.collectionId ?? 0),
      previewUrl: track.previewUrl ? String(track.previewUrl) : null,
    };
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
