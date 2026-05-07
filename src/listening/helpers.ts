/**
 * helpers.ts — load-bearing shared helpers for the listening-history layer.
 *
 * These encode dataset quirks documented in LISTENING_HISTORY.md.
 * Do NOT modify the logic without checking regression tests.
 */

import type { PlayRow, GeoResult, IpGeoCache } from "./types";

/**
 * The ONLY way to determine if a play was skipped.
 * The `skipped` boolean in the Spotify export is broken from 2017 to 2022
 * (effectively always false). `reason_end == 'fwdbtn'` is the truth.
 */
export function isSkip(reasonEnd: string): boolean {
  return reasonEnd === "fwdbtn"
    || reasonEnd === "track_skipped_forwards"
    || reasonEnd === "track_skipped_backwards";
}

/**
 * Maps raw platform strings from the Spotify export to a stable enum.
 * Platform strings drift across OS versions (e.g. "iOS 15.0 (iPhone13,4)",
 * "OS X 10.12.6 [x86 8]"). This normalizes to 5 categories + "Other".
 */
export function normalizePlatform(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("ios") || lower.includes("iphone") || lower.includes("ipad")) return "iOS";
  if (lower.includes("os x") || lower.includes("mac") || lower.includes("osx")) return "macOS";
  if (lower.includes("android")) return "Android";
  if (lower.includes("windows")) return "Windows";
  if (lower.includes("partner") || lower.includes("cast") || lower.includes("sonos") || lower.includes("echo")) return "Cast";
  return "Other";
}

/**
 * No-op at query time: the `plays` table is pre-filtered to music-only rows.
 * Exists so callers can express intent and for test assertions documenting
 * the filter contract: _kind == 'audio' AND spotify_track_uri not null
 * AND episode_name is null AND audiobook_title is null → 260,331 rows.
 */
export function musicOnly<T>(rows: T[]): T[] {
  return rows;
}

/**
 * Query wrapper: fetches plays from D1 with optional filters.
 * Encapsulates the column schema so callers don't write raw SQL.
 */
export async function loadPlays(
  db: D1Database,
  filters?: {
    year?: number;
    month?: number;
    artistName?: string;
    limit?: number;
    platformFilter?: "ios_only";
  },
): Promise<PlayRow[]> {
  const conditions: string[] = [];
  const binds: (string | number)[] = [];

  if (filters?.year != null) {
    conditions.push("year = ?");
    binds.push(filters.year);
  }
  if (filters?.month != null) {
    conditions.push("month = ?");
    binds.push(filters.month);
  }
  if (filters?.artistName != null) {
    conditions.push("artist_name = ?");
    binds.push(filters.artistName);
  }
  if (filters?.platformFilter === "ios_only") {
    conditions.push("platform = 'iOS'");
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = filters?.limit != null ? `LIMIT ${filters.limit}` : "";
  const sql = `SELECT * FROM plays ${where} ORDER BY ts DESC ${limit}`;

  const result = await db.prepare(sql).bind(...binds).all<PlayRow>();
  return result.results;
}

/**
 * Looks up an IP in the static ip_geo.json cache (embedded, read-only).
 * Returns { city, region, country, lat, lon } or null if not found.
 */
export function geolocate(ip: string, cache: IpGeoCache): GeoResult | null {
  return cache[ip] ?? null;
}

/**
 * Looks up an IP in the embedded cache, then falls back to KV for IPs
 * added by live-sync.
 */
export async function geolocateWithKvFallback(
  ip: string,
  cache: IpGeoCache,
  kv: KVNamespace,
): Promise<GeoResult | null> {
  const cached = cache[ip];
  if (cached) return cached;

  const kvResult = await kv.get(`geo:ip:${ip}`, "json");
  return (kvResult as GeoResult) ?? null;
}

/**
 * Looks up an IP via a free geolocation API and caches the result in KV.
 * Never stores the raw IP in D1 or any external service beyond the lookup.
 */
export async function geolocateAndCache(
  ip: string,
  kv: KVNamespace,
): Promise<GeoResult | null> {
  try {
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,lat,lon`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      city?: string;
      regionName?: string;
      country?: string;
      lat?: number;
      lon?: number;
    };
    if (!data.city) return null;
    const result: GeoResult = {
      city: data.city,
      region: data.regionName ?? "",
      country: data.country ?? "",
      lat: data.lat ?? 0,
      lon: data.lon ?? 0,
    };
    await kv.put(`geo:ip:${ip}`, JSON.stringify(result));
    return result;
  } catch {
    return null;
  }
}
