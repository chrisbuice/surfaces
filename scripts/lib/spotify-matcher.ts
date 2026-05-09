/**
 * spotify-matcher.ts — Match Apple Music tracks to Spotify catalog.
 *
 * Two matching strategies:
 *   1. ISRC search (confidence = 1.00, match_method = 'isrc')
 *   2. Text search with fuzzy scoring (confidence formula from decisions §D7 Stage 2)
 *
 * Uses the file-based rate-guard for cooldown/kill-switch defense.
 * All fetch calls go through spotifyFetch() which checks the guard
 * before every request.
 */

import * as fuzzball from "fuzzball";
import { RateLimiter } from "./rate-limiter";
import {
  assertSpotifyAllowed,
  setSpotifyCooldown,
  SpotifyCooldownError,
  SpotifyServerError,
} from "./spotify-rate-guard";

// Re-export for callers that need to catch these
export { SpotifyCooldownError, SpotifyServerError } from "./spotify-rate-guard";

// ── Types ──

export interface SpotifyMatchCandidate {
  spotifyTrackUri: string;
  trackName: string;
  artistName: string;
  albumName: string;
  durationMs: number;
  confidence: number;
  matchMethod: "isrc" | "text";
}

interface SpotifySearchTrack {
  uri: string;
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string };
  duration_ms: number;
}

interface SpotifySearchResponse {
  tracks: {
    items: SpotifySearchTrack[];
  };
}

// ── Rate limiting ──

const limiter = new RateLimiter(10); // 10 req/sec

const SPOTIFY_API = "https://api.spotify.com/v1";
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;

// ── ISRC search ──

/**
 * Search Spotify by ISRC. Returns a single match with confidence 1.00 or null.
 */
export async function searchByIsrc(
  isrc: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<SpotifyMatchCandidate | null> {
  const url = `${SPOTIFY_API}/search?q=isrc:${encodeURIComponent(isrc)}&type=track&limit=1`;

  const data = await spotifyFetch<SpotifySearchResponse>(url, token, fetchFn);
  if (!data?.tracks?.items?.length) return null;

  const track = data.tracks.items[0];
  return {
    spotifyTrackUri: track.uri,
    trackName: track.name,
    artistName: track.artists.map((a) => a.name).join(", "),
    albumName: track.album.name,
    durationMs: track.duration_ms,
    confidence: 1.0,
    matchMethod: "isrc",
  };
}

// ── Text search ──

/**
 * Search Spotify by track/artist/album text. Returns top 5 candidates, scored.
 */
export async function searchByText(
  track: string,
  artist: string,
  album: string | null,
  targetDurationMs: number | null,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<SpotifyMatchCandidate[]> {
  const parts = [`track:"${track}"`, `artist:"${artist}"`];
  if (album) parts.push(`album:"${album}"`);
  const query = parts.join(" ");

  const url = `${SPOTIFY_API}/search?q=${encodeURIComponent(query)}&type=track&limit=5`;
  const data = await spotifyFetch<SpotifySearchResponse>(url, token, fetchFn);
  if (!data?.tracks?.items?.length) return [];

  return data.tracks.items.map((item) => {
    const candidate = {
      trackName: item.name,
      artistName: item.artists.map((a) => a.name).join(", "),
      durationMs: item.duration_ms,
    };
    const target = {
      trackName: track,
      artistName: artist,
      durationMs: targetDurationMs,
    };
    return {
      spotifyTrackUri: item.uri,
      trackName: item.name,
      artistName: candidate.artistName,
      albumName: item.album.name,
      durationMs: item.duration_ms,
      confidence: scoreCandidate(candidate, target),
      matchMethod: "text" as const,
    };
  }).sort((a, b) => b.confidence - a.confidence);
}

// ── Scoring ──

/**
 * Compute match confidence per decisions §D7 Stage 2:
 *   confidence = 0.6 × title_ratio + 0.3 × artist_ratio + 0.1 × duration_score
 */
export function scoreCandidate(
  candidate: { trackName: string; artistName: string; durationMs: number },
  target: { trackName: string; artistName: string; durationMs: number | null },
): number {
  const titleRatio = fuzzball.token_sort_ratio(
    candidate.trackName.toLowerCase(),
    target.trackName.toLowerCase(),
  ) / 100;

  const artistRatio = fuzzball.token_sort_ratio(
    candidate.artistName.toLowerCase(),
    target.artistName.toLowerCase(),
  ) / 100;

  let durationScore = 0.5;
  if (target.durationMs != null && target.durationMs > 0) {
    const diffMs = Math.abs(candidate.durationMs - target.durationMs);
    if (diffMs <= 3000) {
      durationScore = 1.0;
    } else if (diffMs <= 30000) {
      durationScore = 1.0 - (diffMs - 3000) / 27000;
    } else {
      durationScore = 0.0;
    }
  }

  return Math.round((0.6 * titleRatio + 0.3 * artistRatio + 0.1 * durationScore) * 100) / 100;
}

// ── Internal fetch with guard ──

async function spotifyFetch<T>(
  url: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<T | null> {
  // Chokepoint: check cooldown + kill-switch before any HTTP call
  assertSpotifyAllowed();

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await limiter.wait();

    let res: Response;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      res = await fetchFn(url, {
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token}` },
      });
      clearTimeout(timer);
    } catch {
      // Network error or timeout — retry
      if (attempt === MAX_RETRIES) return null;
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    // 429: set persistent cooldown and throw — no cap, full Retry-After
    if (res.status === 429) {
      const retryAfterRaw = res.headers.get("retry-after");
      const retryAfterSec = retryAfterRaw ? parseInt(retryAfterRaw, 10) : 3600;
      setSpotifyCooldown(retryAfterSec, `spotifyFetch ${url.split("?")[0]}`);
      throw new SpotifyCooldownError(Date.now() + retryAfterSec * 1000);
    }

    // 5xx: retry with backoff
    if (res.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    if (res.status >= 500) {
      throw new SpotifyServerError(`Spotify ${res.status} after ${MAX_RETRIES} retries`);
    }

    if (!res.ok) return null;
    return (await res.json()) as T;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
