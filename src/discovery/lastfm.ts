/**
 * lastfm.ts — Last.fm API client with D1 cache layer.
 *
 * API: http://ws.audioscrobbler.com/2.0/
 * Auth: API key as query param (no OAuth)
 * Rate limit: ~5 req/sec per docs; we throttle to 2 req/sec (500ms delay)
 * Cache: 7-day TTL in lastfm_similar_cache table
 */

const LASTFM_BASE = "http://ws.audioscrobbler.com/2.0/";
const CACHE_TTL_SECONDS = 7 * 24 * 3600; // 7 days

export interface SimilarArtist {
  name: string;
  match: number; // 0-1 similarity score
}

export class LastFmClient {
  private apiKey: string;
  private db: D1Database;

  constructor(apiKey: string, db: D1Database) {
    this.apiKey = apiKey;
    this.db = db;
  }

  /** Fetch similar artists, with cache. Each call wrapped in try/catch by caller. */
  async getSimilarArtists(
    artistName: string,
    limit = 5
  ): Promise<{ artists: SimilarArtist[]; cached: boolean }> {
    const cacheKey = artistName.toLowerCase();

    // Check cache
    const cached = await this.getCache("artist_similar", cacheKey);
    if (cached) {
      return { artists: JSON.parse(cached) as SimilarArtist[], cached: true };
    }

    // Fetch from Last.fm
    const params = new URLSearchParams({
      method: "artist.getsimilar",
      artist: artistName,
      limit: String(limit),
      api_key: this.apiKey,
      format: "json",
    });

    const resp = await fetch(`${LASTFM_BASE}?${params}`, {
      headers: { "User-Agent": "Surfaces/1.0 (personal project)" },
    });

    if (!resp.ok) {
      throw new Error(`Last.fm API error ${resp.status}`);
    }

    const data = (await resp.json()) as {
      similarartists?: { artist?: Array<{ name: string; match: string }> };
      error?: number;
      message?: string;
    };

    if (data.error) {
      throw new Error(`Last.fm error ${data.error}: ${data.message}`);
    }

    const artists: SimilarArtist[] = (data.similarartists?.artist ?? []).map(a => ({
      name: a.name,
      match: parseFloat(a.match) || 0,
    }));

    // Write to cache
    await this.setCache("artist_similar", cacheKey, JSON.stringify(artists));

    return { artists, cached: false };
  }

  private async getCache(queryType: string, queryKey: string): Promise<string | null> {
    const now = Math.floor(Date.now() / 1000);
    const row = await this.db.prepare(
      "SELECT response_json FROM lastfm_similar_cache WHERE query_type = ? AND query_key = ? AND expires_at > ?"
    ).bind(queryType, queryKey, now).first<{ response_json: string }>();
    return row?.response_json ?? null;
  }

  private async setCache(queryType: string, queryKey: string, responseJson: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    await this.db.prepare(`
      INSERT INTO lastfm_similar_cache (query_type, query_key, response_json, fetched_at, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(query_type, query_key) DO UPDATE SET
        response_json = excluded.response_json,
        fetched_at = excluded.fetched_at,
        expires_at = excluded.expires_at
    `).bind(queryType, queryKey, responseJson, now, now + CACHE_TTL_SECONDS).run();
  }
}
