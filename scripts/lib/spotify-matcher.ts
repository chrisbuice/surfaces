/**
 * spotify-matcher.ts — Match Apple Music tracks to Spotify catalog.
 *
 * Two matching strategies:
 *   1. ISRC search (confidence = 1.00, match_method = 'isrc')
 *   2. Text search with fuzzy scoring (confidence formula from decisions §D7 Stage 2)
 *
 * Uses client_credentials auth (public catalog reads only).
 */

import * as fuzzball from "fuzzball";
import { RateLimiter } from "./rate-limiter";

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

// ── Rate limiter ──

const limiter = new RateLimiter(25); // 25 req/sec

const SPOTIFY_API = "https://api.spotify.com/v1";
const MAX_RETRIES = 3;
const FETCH_TIMEOUT_MS = 30_000;

// ── ISRC search ──

/**
 * Search Spotify by ISRC. Returns a single match with confidence 1.00 or null.
 *
 * ISRC short-circuit: success here means confidence = 1.00 and
 * match_method = 'isrc'. Stages 2+ do not run for this track.
 * The cascade is short-circuit, not best-of-N.
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
 *
 * title_ratio and artist_ratio use fuzzball.token_sort_ratio (0–100) / 100.
 * duration_score: 1.0 if within 3 seconds, scales down linearly, 0 if >30s diff.
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

  let durationScore = 0.5; // default if no target duration
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

// ── Internal fetch with retry ──

async function spotifyFetch<T>(
  url: string,
  token: string,
  fetchFn: typeof fetch,
): Promise<T | null> {
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

    if (res.status === 429) {
      const retryAfter = res.headers.get("retry-after");
      const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 2000 * Math.pow(2, attempt);
      if (attempt === MAX_RETRIES) return null;
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) return null;
    return (await res.json()) as T;
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
