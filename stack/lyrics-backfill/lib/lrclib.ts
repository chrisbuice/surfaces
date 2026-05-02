/**
 * lrclib.ts — LRCLIB client for fetching lyrics.
 *
 * API: https://lrclib.net
 * - No authentication required
 * - Signature match: GET /api/get?track_name=&artist_name=&album_name=&duration=
 * - Search fallback: GET /api/search?track_name=&artist_name=
 * - Self-paced at 5 req/sec (200ms between calls)
 */

const LRCLIB_BASE = "https://lrclib.net";
const USER_AGENT = "Surfaces/0.1 (https://www.github.com/chrisbuice/surfaces)";

export interface LrclibMatch {
  trackName: string;
  artistName: string;
  albumName: string | null;
  duration: number | null;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
  matchMethod: "signature" | "search";
}

interface LrclibResponse {
  id: number;
  trackName: string;
  artistName: string;
  albumName: string;
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

export class LrclibClient {
  private lastRequestAt = 0;
  private minIntervalMs = 200; // 5 req/sec

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  /**
   * Fetch lyrics for a track. Tries signature match first, falls back to search.
   * Returns null if no plausible match found.
   */
  async fetchLyrics(args: {
    trackName: string;
    artistName: string;
    albumName?: string;
    durationMs?: number;
  }): Promise<LrclibMatch | null> {
    // Try signature match first (requires all fields)
    const durationSec = args.durationMs ? Math.round(args.durationMs / 1000) : undefined;

    if (durationSec) {
      const signatureResult = await this.trySignatureMatch(
        args.trackName,
        args.artistName,
        args.albumName,
        durationSec,
      );
      if (signatureResult) return signatureResult;
    }

    // Fall back to search
    return this.trySearch(args.trackName, args.artistName, args.durationMs);
  }

  private async trySignatureMatch(
    trackName: string,
    artistName: string,
    albumName: string | undefined,
    durationSec: number,
  ): Promise<LrclibMatch | null> {
    await this.throttle();

    const params = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
      duration: durationSec.toString(),
    });
    if (albumName) params.set("album_name", albumName);

    const resp = await fetch(`${LRCLIB_BASE}/api/get?${params}`, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`LRCLIB signature match error ${resp.status}`);

    const data = (await resp.json()) as LrclibResponse;
    return this.toMatch(data, "signature");
  }

  private async trySearch(
    trackName: string,
    artistName: string,
    durationMs: number | undefined,
  ): Promise<LrclibMatch | null> {
    await this.throttle();

    const params = new URLSearchParams({
      track_name: trackName,
      artist_name: artistName,
    });

    const resp = await fetch(`${LRCLIB_BASE}/api/search?${params}`, {
      headers: { "User-Agent": USER_AGENT },
    });

    if (!resp.ok) throw new Error(`LRCLIB search error ${resp.status}`);

    const results = (await resp.json()) as LrclibResponse[];
    if (results.length === 0) return null;

    // If we have a duration, filter to within ±3 seconds
    if (durationMs) {
      const durationSec = durationMs / 1000;
      const match = results.find(
        r => Math.abs(r.duration - durationSec) <= 3,
      );
      if (!match) return null;
      return this.toMatch(match, "search");
    }

    // No duration to compare — take first result
    return this.toMatch(results[0], "search");
  }

  private toMatch(data: LrclibResponse, method: "signature" | "search"): LrclibMatch {
    return {
      trackName: data.trackName,
      artistName: data.artistName,
      albumName: data.albumName || null,
      duration: data.duration || null,
      instrumental: data.instrumental,
      plainLyrics: data.plainLyrics || null,
      syncedLyrics: data.syncedLyrics || null,
      matchMethod: method,
    };
  }
}
