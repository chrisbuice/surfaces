/**
 * apple-csv-parser.ts — Parse Apple Music export CSVs for ingest.
 *
 * Handles:
 * - Play Activity (primary event stream, ~44.6K rows)
 * - Play History Daily Tracks (track ID source, ~11.7K unique IDs)
 * - Track Play History + Library Tracks (artist-recovery lookup)
 *
 * All parsers validate CSV headers before processing (amendment 2).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";

// ── Types ──

export interface PlayActivityRow {
  eventType: string;
  mediaType: string;
  songName: string;
  artistName: string;
  albumName: string;
  eventEndTimestamp: string; // ISO 8601
  playDurationMs: number;
  endReasonType: string;
  sourceType: string;
  shuffle: boolean;
  offline: boolean;
  deviceType: string;
}

export interface DailyTrackEntry {
  trackIdentifier: string;
  trackDescription: string; // "Artist — Song"
  playCount: number;
  date: string; // YYYY-MM-DD
}

export interface TrackIdRecoveryResult {
  trackId: string | null;
  ambiguous: boolean;
}

// ── Expected headers ──

// Note: Play Activity has NO per-track "Artist Name" column.
// Artist comes from cross-reference (Daily Tracks, Library Tracks, iTunes Lookup).
// "Container Artist Name" is the container/playlist artist, not the track artist.
const PLAY_ACTIVITY_REQUIRED = [
  "Event Type",
  "Media Type",
  "Song Name",
  "Album Name",
  "Event End Timestamp",
  "Play Duration Milliseconds",
  "End Reason Type",
  "Source Type",
  "Shuffle Play",
  "Offline",
];

const DAILY_TRACKS_REQUIRED = [
  "Track Identifier",
  "Track Description",
  "Play Count",
  "Date Played",
];

const TRACK_PLAY_HISTORY_REQUIRED = [
  "Track Identifier",
  "Song Name",
  "Artist Name",
];

// ── Header validation ──

export class HeaderMismatchError extends Error {
  constructor(
    filename: string,
    missing: string[],
    unexpected?: string[],
  ) {
    const parts = [`${filename} — missing: ${JSON.stringify(missing)}`];
    if (unexpected?.length) {
      parts.push(`unexpected: ${JSON.stringify(unexpected)}`);
    }
    super(`HeaderMismatchError: ${parts.join(", ")}`);
    this.name = "HeaderMismatchError";
  }
}

function validateHeaders(
  actual: string[],
  required: string[],
  filename: string,
): void {
  const actualSet = new Set(actual.map((h) => h.trim()));
  const missing = required.filter((h) => !actualSet.has(h));
  if (missing.length > 0) {
    throw new HeaderMismatchError(filename, missing);
  }
}

// ── CSV line parsing ──

/**
 * Parse a single CSV line, handling quoted fields with embedded commas/newlines.
 */
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Stream lines from a CSV, yielding header + data rows as string arrays.
 */
async function* streamCSV(
  path: string,
): AsyncIterable<{ headers: string[]; row: string[] }> {
  const rl = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let headers: string[] | null = null;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCSVLine(line);
      continue;
    }
    const row = parseCSVLine(line);
    if (row.length === headers.length) {
      yield { headers, row };
    }
  }
}

function rowToObject(headers: string[], row: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    obj[headers[i].trim()] = row[i]?.trim() ?? "";
  }
  return obj;
}

// ── Play Activity parser (Option B filter) ──

/**
 * Stream Play Activity rows that pass the Option B filter:
 *   event_type == 'PLAY_END'
 *   AND media_type == 'AUDIO'
 *   AND (play_duration_ms >= 30000 OR end_reason_type == 'NATURAL_END_OF_TRACK')
 */
export async function* parsePlayActivity(
  path: string,
): AsyncGenerator<PlayActivityRow> {
  let headerValidated = false;

  for await (const { headers, row } of streamCSV(path)) {
    if (!headerValidated) {
      validateHeaders(headers, PLAY_ACTIVITY_REQUIRED, "Apple Music Play Activity.csv");
      headerValidated = true;
    }

    const obj = rowToObject(headers, row);
    const eventType = obj["Event Type"] ?? "";
    const mediaType = obj["Media Type"] ?? "";
    const playDurationMs = parseInt(obj["Play Duration Milliseconds"] ?? "0", 10) || 0;
    const endReasonType = obj["End Reason Type"] ?? "";

    // Option B filter (decisions doc §D3)
    if (eventType !== "PLAY_END") continue;
    if (mediaType !== "AUDIO") continue;
    if (playDurationMs < 30000 && endReasonType !== "NATURAL_END_OF_TRACK") continue;

    yield {
      eventType,
      mediaType,
      songName: obj["Song Name"] ?? "",
      // Play Activity has no per-track artist. Use Container Artist Name
      // as a fallback hint; real artist comes from cross-reference pipeline.
      artistName: obj["Container Artist Name"] ?? "",
      albumName: obj["Album Name"] ?? "",
      eventEndTimestamp: obj["Event End Timestamp"] ?? "",
      playDurationMs,
      endReasonType,
      sourceType: obj["Source Type"] ?? "",
      shuffle: (obj["Shuffle Play"] ?? "").toLowerCase() === "true",
      offline: (obj["Offline"] ?? "").toLowerCase() === "true",
      deviceType: obj["Device Type"] ?? "",
    };
  }
}

// ── Daily Tracks lookup builder ──

/**
 * Build a lookup map from Daily Tracks CSV, keyed by `${date}\t${song.toLowerCase().trim()}`.
 * Each key maps to an array of entries (for disambiguation when multiple tracks share a date+song).
 */
export async function buildDailyTracksLookup(
  path: string,
): Promise<Map<string, DailyTrackEntry[]>> {
  const map = new Map<string, DailyTrackEntry[]>();
  let headerValidated = false;

  for await (const { headers, row } of streamCSV(path)) {
    if (!headerValidated) {
      validateHeaders(headers, DAILY_TRACKS_REQUIRED, "Apple Music - Play History Daily Tracks.csv");
      headerValidated = true;
    }

    const obj = rowToObject(headers, row);
    const trackId = obj["Track Identifier"] ?? "";
    const description = obj["Track Description"] ?? "";
    const playCount = parseInt(obj["Play Count"] ?? "0", 10) || 0;
    const date = obj["Date Played"] ?? "";

    if (!trackId || !date) continue;

    // Extract song name from description ("Artist — Song" or "Artist - Song")
    // The key uses the full description's song portion, but for matching
    // we key by date + song_name from the description
    const songFromDesc = extractSongFromDescription(description);
    const key = `${date}\t${songFromDesc.toLowerCase().trim()}`;

    const entry: DailyTrackEntry = {
      trackIdentifier: trackId,
      trackDescription: description,
      playCount,
      date,
    };

    const existing = map.get(key);
    if (existing) {
      // Only add if this track ID isn't already in the list for this key
      if (!existing.some((e) => e.trackIdentifier === trackId)) {
        existing.push(entry);
      }
    } else {
      map.set(key, [entry]);
    }
  }

  return map;
}

/**
 * Extract the song portion from a Daily Tracks description.
 * Format is typically "Artist - Song" or "Artist — Song".
 */
function extractSongFromDescription(description: string): string {
  // Try em-dash first, then en-dash, then hyphen with spaces
  for (const sep of [" — ", " – ", " - "]) {
    const idx = description.indexOf(sep);
    if (idx !== -1) {
      return description.slice(idx + sep.length);
    }
  }
  return description;
}

// ── Artist recovery lookup ──

/**
 * Build an artist-recovery lookup from Track Play History + Library Tracks.
 * Maps song_lower → Set of artist names for disambiguation.
 */
export async function buildArtistRecoveryLookup(
  tphPath: string,
  libPath: string,
): Promise<Map<string, Set<string>>> {
  const map = new Map<string, Set<string>>();

  // Track Play History: has (Track Identifier, Song Name, Artist Name)
  let headerValidated = false;
  for await (const { headers, row } of streamCSV(tphPath)) {
    if (!headerValidated) {
      validateHeaders(headers, TRACK_PLAY_HISTORY_REQUIRED, "Apple Music - Track Play History.csv");
      headerValidated = true;
    }
    const obj = rowToObject(headers, row);
    const song = (obj["Song Name"] ?? "").toLowerCase().trim();
    const artist = obj["Artist Name"] ?? "";
    if (song && artist) {
      const set = map.get(song) ?? new Set<string>();
      set.add(artist);
      map.set(song, set);
    }
  }

  // Library Tracks JSON: disambiguates (song, album) → artist
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(libPath, "utf-8");
    const tracks = JSON.parse(raw) as Array<{
      Title?: string;
      Artist?: string;
      "Sort Name"?: string;
    }>;
    for (const t of tracks) {
      const song = (t.Title ?? t["Sort Name"] ?? "").toLowerCase().trim();
      const artist = t.Artist ?? "";
      if (song && artist) {
        const set = map.get(song) ?? new Set<string>();
        set.add(artist);
        map.set(song, set);
      }
    }
  } catch {
    // Library Tracks is optional — log and continue
    console.warn(`Warning: could not read Library Tracks at ${libPath}, skipping artist recovery from library`);
  }

  return map;
}

// ── Library album lookup ──

/**
 * Build a trackId → albumName map from Library Tracks JSON.
 * Used by disambiguate() to resolve ambiguous Daily Tracks matches
 * when the Play Activity row has an album name.
 */
export async function buildAlbumLookup(
  libPath: string,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  try {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(libPath, "utf-8");
    const tracks = JSON.parse(raw) as Array<{
      "Purchased Track Identifier"?: number;
      Title?: string;
      Album?: string;
      Artist?: string;
    }>;
    for (const t of tracks) {
      const id = t["Purchased Track Identifier"];
      const album = t.Album;
      if (id && album) {
        map.set(String(id), album);
      }
    }
  } catch {
    // Library Tracks is optional
    console.warn(`Warning: could not read Library Tracks at ${libPath} for album lookup`);
  }
  return map;
}

// ── Track ID recovery ──

/**
 * Recover an Apple track ID for a Play Activity row by joining to the Daily Tracks map.
 * Per decisions doc §D6:
 *   1. Exact date + song match → assign if 1 unique track ID
 *   2. Multiple track IDs → disambiguate by album via Library Tracks
 *   3. No match → try ±1 day window (timezone shifts)
 *   4. Still no match → trackId remains null
 */
export function recoverAppleTrackId(
  row: PlayActivityRow,
  dailyMap: Map<string, DailyTrackEntry[]>,
  albumLookup?: Map<string, string>,
): TrackIdRecoveryResult {
  const songKey = row.songName.toLowerCase().trim();
  const date = row.eventEndTimestamp.slice(0, 10); // YYYY-MM-DD

  // Step 1: exact date match
  const exactKey = `${date}\t${songKey}`;
  const exactCandidates = dailyMap.get(exactKey);

  if (exactCandidates) {
    const result = disambiguate(exactCandidates, row, albumLookup);
    if (result.trackId || result.ambiguous) return result;
  }

  // Step 2: ±1 day window (timezone shifts)
  for (const offset of [-1, 1]) {
    const adjDate = offsetDate(date, offset);
    const adjKey = `${adjDate}\t${songKey}`;
    const adjCandidates = dailyMap.get(adjKey);
    if (adjCandidates) {
      const result = disambiguate(adjCandidates, row, albumLookup);
      if (result.trackId || result.ambiguous) return result;
    }
  }

  return { trackId: null, ambiguous: false };
}

function disambiguate(
  candidates: DailyTrackEntry[],
  row: PlayActivityRow,
  albumLookup?: Map<string, string>,
): TrackIdRecoveryResult {
  // Collect unique track IDs
  const uniqueIds = [...new Set(candidates.map((c) => c.trackIdentifier))];

  if (uniqueIds.length === 1) {
    return { trackId: uniqueIds[0], ambiguous: false };
  }

  // Multiple track IDs — attempt album disambiguation via Library Tracks.
  // If the Play Activity row has an album name and the albumLookup maps
  // a candidate's track ID to a matching album, pick that candidate.
  if (row.albumName && albumLookup && albumLookup.size > 0) {
    const rowAlbumLower = row.albumName.toLowerCase().trim();
    const albumMatches = uniqueIds.filter((id) => {
      const libAlbum = albumLookup.get(id);
      return libAlbum && libAlbum.toLowerCase().trim() === rowAlbumLower;
    });
    if (albumMatches.length === 1) {
      return { trackId: albumMatches[0], ambiguous: false };
    }
  }

  return { trackId: null, ambiguous: true };
}

function offsetDate(dateStr: string, days: number): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ── Cache key generation ──

/**
 * Generate a cache key for the apple_track_matches table.
 * Uses apple_track_id when available, otherwise a text hash.
 */
export function makeCacheKey(
  appleTrackId: string | null,
  songName: string,
  artistName: string,
  albumName: string,
): string {
  if (appleTrackId) {
    return `apple:${appleTrackId}`;
  }
  const hash = createHash("sha1")
    .update(`${songName}|${artistName}|${albumName}`)
    .digest("hex");
  return `text:${hash}`;
}
