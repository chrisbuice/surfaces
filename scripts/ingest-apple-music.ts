#!/usr/bin/env npx tsx
/**
 * ingest-apple-music.ts — One-shot Apple Music listening history ingest.
 *
 * Reads Apple Music export CSVs, recovers Apple track IDs via Daily Tracks,
 * matches to Spotify catalog via ISRC (Stage 1) then text search (Stage 2),
 * and writes to D1 via the HTTP API.
 *
 * Usage:
 *   ingest-apple-music --data-dir=/data/apple-music [--force] [--skip-musicbrainz] [--limit=N]
 *
 * Env vars required:
 *   CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID  (D1 HTTP API)
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET          (Spotify client_credentials)
 */

import { parseArgs } from "node:util";
import {
  parsePlayActivity,
  buildDailyTracksLookup,
  buildArtistRecoveryLookup,
  buildAlbumLookup,
  recoverAppleTrackId,
  makeCacheKey,
  type PlayActivityRow,
} from "./lib/apple-csv-parser";
import { lookupTrack, type ItunesTrack } from "./lib/itunes-lookup";
import { findIsrc } from "./lib/musicbrainz-isrc";
import { searchByIsrc, searchByText, type SpotifyMatchCandidate } from "./lib/spotify-matcher";
import { getSpotifyToken } from "./lib/spotify-auth";
import { queryD1, writeD1, batchWriteD1 } from "../stack/lyrics-backfill/lib/d1";

// ── CLI args ──

const { values: args } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    force: { type: "boolean", default: false },
    "skip-musicbrainz": { type: "boolean", default: false },
    limit: { type: "string" },
  },
});

const DATA_DIR = args["data-dir"];
if (!DATA_DIR) {
  console.error("Usage: ingest-apple-music --data-dir=/path/to/apple-music [--force] [--skip-musicbrainz] [--limit=N]");
  process.exit(1);
}
const FORCE = args.force ?? false;
const SKIP_MB = args["skip-musicbrainz"] ?? false;
const LIMIT = args.limit ? parseInt(args.limit, 10) : undefined;

// ── File paths ──

const PLAY_ACTIVITY_PATH = `${DATA_DIR}/Apple Music Play Activity.csv`;
const DAILY_TRACKS_PATH = `${DATA_DIR}/Apple Music - Play History Daily Tracks.csv`;
const TRACK_PLAY_HISTORY_PATH = `${DATA_DIR}/Apple Music - Track Play History.csv`;
const LIBRARY_TRACKS_PATH = `${DATA_DIR}/Apple Music Library Tracks.json`;

// ── Types ──

interface MatchResult {
  cacheKey: string;
  appleTrackId: string | null;
  bestCandidate: SpotifyMatchCandidate | null;
  allCandidates: SpotifyMatchCandidate[];
  itunesData: ItunesTrack | null;
  isrc: string | null;
  matchStatus: "matched" | "review" | "unmatched";
  originalSongName: string;
  originalArtistName: string;
  originalAlbumName: string;
}

interface PlayEvent {
  row: PlayActivityRow;
  cacheKey: string;
  appleTrackId: string | null;
  ambiguous: boolean;
}

// ── Main ──

async function main() {
  console.log("╔══════════════════════════════════════════╗");
  console.log("║  Apple Music Ingest — Surfaces           ║");
  console.log("╚══════════════════════════════════════════╝");
  console.log(`  Data dir: ${DATA_DIR}`);
  console.log(`  Force: ${FORCE}`);
  console.log(`  Skip MusicBrainz: ${SKIP_MB}`);
  console.log(`  Limit: ${LIMIT ?? "none"}`);
  console.log();

  // ── Idempotency check ──
  const [countRow] = await queryD1<{ count: number }>(
    "SELECT COUNT(*) as count FROM plays WHERE source = 'apple'",
  );
  if (countRow.count > 0 && !FORCE) {
    console.error(`❌ ${countRow.count} Apple rows already exist in plays. Use --force to delete and re-ingest.`);
    process.exit(1);
  }
  if (FORCE && countRow.count > 0) {
    console.log(`  🗑️  --force: deleting ${countRow.count} existing Apple rows...`);
    await writeD1("DELETE FROM plays WHERE source = 'apple'");
    await writeD1("DELETE FROM apple_track_matches");
    console.log("  ✓ Cleared existing Apple data.");
  }

  // ── Step 1: Build Daily Tracks lookup ──
  console.log("\n[Step 1] Building Daily Tracks lookup...");
  const dailyMap = await buildDailyTracksLookup(DAILY_TRACKS_PATH);
  console.log(`  ✓ ${dailyMap.size} unique (date, song) keys`);

  // ── Step 2: Build artist-recovery + album lookups ──
  console.log("[Step 2] Building artist-recovery and album lookups...");
  const artistRecovery = await buildArtistRecoveryLookup(
    TRACK_PLAY_HISTORY_PATH,
    LIBRARY_TRACKS_PATH,
  );
  const albumLookup = await buildAlbumLookup(LIBRARY_TRACKS_PATH);
  console.log(`  ✓ ${artistRecovery.size} songs with artist data`);
  console.log(`  ✓ ${albumLookup.size} tracks with album data (for disambiguation)`);

  // ── Step 3: Parse Play Activity with Option B filter + recover track IDs ──
  console.log("[Step 3] Parsing Play Activity (Option B filter)...");
  const playEvents: PlayEvent[] = [];
  let totalParsed = 0;
  let recovered = 0;
  let ambiguousCount = 0;

  for await (const row of parsePlayActivity(PLAY_ACTIVITY_PATH)) {
    totalParsed++;
    const { trackId, ambiguous } = recoverAppleTrackId(row, dailyMap, albumLookup);
    const cacheKey = makeCacheKey(trackId, row.songName, row.artistName, row.albumName);

    if (trackId) recovered++;
    if (ambiguous) ambiguousCount++;

    playEvents.push({ row, cacheKey, appleTrackId: trackId, ambiguous });
  }
  console.log(`  ✓ ${totalParsed} plays after Option B filter`);
  console.log(`  ✓ ${recovered} with Apple track ID (${(100 * recovered / totalParsed).toFixed(1)}%)`);
  console.log(`  ✓ ${ambiguousCount} ambiguous`);

  // ── Step 4: Group by cache_key → unique tracks ──
  console.log("[Step 4] Grouping by unique track...");
  const trackGroups = new Map<string, PlayEvent[]>();
  for (const pe of playEvents) {
    const group = trackGroups.get(pe.cacheKey) ?? [];
    group.push(pe);
    trackGroups.set(pe.cacheKey, group);
  }
  const uniqueTracks = trackGroups.size;
  console.log(`  ✓ ${uniqueTracks} unique tracks`);

  // ── Step 5: Check for existing matches (resumability) ──
  console.log("[Step 5] Loading existing match cache...");
  const existingMatches = new Map<string, MatchResult>();
  const cachedRows = await queryD1<{
    cache_key: string;
    apple_track_id: string | null;
    spotify_track_uri: string | null;
    spotify_track_name: string | null;
    spotify_artist_name: string | null;
    spotify_album_name: string | null;
    spotify_duration_ms: number | null;
    match_confidence: number | null;
    match_method: string | null;
    match_status: string;
    itunes_artist_name: string | null;
    itunes_track_name: string | null;
    itunes_album_name: string | null;
    itunes_duration_ms: number | null;
    itunes_release_date: string | null;
    itunes_genre: string | null;
    musicbrainz_isrc: string | null;
    original_song_name: string;
    original_artist_name: string | null;
    original_album_name: string | null;
  }>("SELECT * FROM apple_track_matches");
  for (const row of cachedRows) {
    existingMatches.set(row.cache_key, {
      cacheKey: row.cache_key,
      appleTrackId: row.apple_track_id,
      bestCandidate: row.spotify_track_uri
        ? {
            spotifyTrackUri: row.spotify_track_uri,
            trackName: row.spotify_track_name ?? "",
            artistName: row.spotify_artist_name ?? "",
            albumName: row.spotify_album_name ?? "",
            durationMs: row.spotify_duration_ms ?? 0,
            confidence: row.match_confidence ?? 0,
            matchMethod: (row.match_method as "isrc" | "text") ?? "text",
          }
        : null,
      allCandidates: [],
      itunesData: row.itunes_artist_name
        ? {
            artistName: row.itunes_artist_name,
            trackName: row.itunes_track_name ?? "",
            collectionName: row.itunes_album_name ?? "",
            trackTimeMillis: row.itunes_duration_ms ?? 0,
            releaseDate: row.itunes_release_date ?? "",
            primaryGenreName: row.itunes_genre ?? "",
            artistId: 0,
            collectionId: 0,
            previewUrl: null,
          }
        : null,
      isrc: row.musicbrainz_isrc,
      matchStatus: row.match_status as "matched" | "review" | "unmatched",
      originalSongName: row.original_song_name,
      originalArtistName: row.original_artist_name ?? "",
      originalAlbumName: row.original_album_name ?? "",
    });
  }
  console.log(`  ✓ ${existingMatches.size} cached matches`);

  // ── Step 6: Match each unique track ──
  console.log("[Step 6] Matching tracks to Spotify...");
  const matchResults = new Map<string, MatchResult>();
  let processed = 0;
  let skipped = 0;
  const tracksToProcess = LIMIT ? [...trackGroups.entries()].slice(0, LIMIT) : [...trackGroups.entries()];

  for (const [cacheKey, events] of tracksToProcess) {
    // Use cached match if available
    if (existingMatches.has(cacheKey)) {
      matchResults.set(cacheKey, existingMatches.get(cacheKey)!);
      skipped++;
      continue;
    }

    const firstEvent = events[0];
    const result = await matchTrack(firstEvent);
    matchResults.set(cacheKey, result);

    // Write to apple_track_matches immediately (resumability)
    await writeMatchToCache(result);

    processed++;
    if (processed % 500 === 0 || processed === tracksToProcess.length) {
      const total = tracksToProcess.length;
      const via = result.bestCandidate?.matchMethod ?? "none";
      const conf = result.bestCandidate?.confidence?.toFixed(2) ?? "0.00";
      console.log(
        `  [${processed}/${total}] track="${firstEvent.row.songName}" via=${via} confidence=${conf}`,
      );
    }
  }

  console.log(`  ✓ ${processed} newly matched, ${skipped} from cache`);

  // ── Step 7: Write play rows to D1 ──
  console.log("[Step 7] Writing play rows to D1...");
  let rowsWritten = 0;
  const batch: Array<{ sql: string; params: (string | number | null)[] }> = [];

  // Only process events for tracks we matched (respects --limit)
  for (const [cacheKey, events] of tracksToProcess) {
    const match = matchResults.get(cacheKey);
    if (!match) continue;

    for (const event of events) {
      const row = event.row;
      const ts = Math.floor(new Date(row.eventEndTimestamp).getTime() / 1000);
      const d = new Date(row.eventEndTimestamp);
      const year = d.getUTCFullYear();
      const month = d.getUTCMonth() + 1;
      const hour = d.getUTCHours();
      // Approximate US Eastern: UTC - 5 (ignoring DST for simplicity)
      const localHour = (hour - 5 + 24) % 24;
      const minutes = row.playDurationMs / 60000;
      const platform = normalizeApplePlatform(row.deviceType);

      // Resolution order for original_artist_name (decisions doc D6, amendment 3):
      // 1. iTunes Lookup succeeded → use itunes_artist_name
      // 2. Cross-reference returns exactly one artist → use it
      // 3. Fallback → '' (empty string, never null)
      let resolvedOriginalArtist = "";
      if (match.itunesData) {
        resolvedOriginalArtist = match.itunesData.artistName;
      } else if (row.artistName) {
        resolvedOriginalArtist = row.artistName;
      }

      batch.push({
        sql: `INSERT INTO plays (
          ts, platform, ms_played, conn_country, track_name, artist_name,
          album_name, spotify_track_uri, reason_start, reason_end,
          shuffle, offline, year, month, hour, local_hour, minutes,
          source, apple_track_id, match_confidence, match_status,
          original_song_name, original_album_name, original_artist_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          ts,
          platform,
          row.playDurationMs,
          "US", // conn_country — Apple export doesn't have this reliably
          match.bestCandidate?.trackName ?? row.songName,
          match.bestCandidate?.artistName ?? row.artistName,
          match.bestCandidate?.albumName ?? row.albumName,
          match.bestCandidate?.spotifyTrackUri ?? "",
          row.sourceType.toLowerCase(),
          row.endReasonType.toLowerCase(),
          row.shuffle ? 1 : 0,
          row.offline ? 1 : 0,
          year,
          month,
          hour,
          localHour,
          Math.round(minutes * 1000) / 1000,
          "apple",
          event.appleTrackId,
          match.bestCandidate?.confidence ?? null,
          match.matchStatus,
          row.songName,
          row.albumName || null,
          resolvedOriginalArtist,
        ],
      });

      // Flush in batches of 100
      if (batch.length >= 100) {
        await batchWriteD1(batch.splice(0));
        rowsWritten += 100;
        if (rowsWritten % 1000 === 0) {
          console.log(`  ... ${rowsWritten} rows written`);
        }
      }
    }
  }

  // Flush remaining
  if (batch.length > 0) {
    await batchWriteD1(batch.splice(0));
    rowsWritten += batch.length;
  }

  // Count actual rows written
  const [finalCount] = await queryD1<{ count: number }>(
    "SELECT COUNT(*) as count FROM plays WHERE source = 'apple'",
  );

  // ── Step 8: Print summary ──
  const matchedCount = [...matchResults.values()].filter((m) => m.matchStatus === "matched").length;
  const reviewCount = [...matchResults.values()].filter((m) => m.matchStatus === "review").length;
  const unmatchedCount = [...matchResults.values()].filter((m) => m.matchStatus === "unmatched").length;
  const isrcMatches = [...matchResults.values()].filter(
    (m) => m.bestCandidate?.matchMethod === "isrc",
  ).length;
  const textMatches = [...matchResults.values()].filter(
    (m) => m.bestCandidate?.matchMethod === "text" && m.matchStatus === "matched",
  ).length;

  console.log("\n╔══════════════════════════════════════════╗");
  console.log("║  Ingest Summary                          ║");
  console.log("╠══════════════════════════════════════════╣");
  console.log(`║  Play events parsed:     ${totalParsed.toString().padStart(8)}`);
  console.log(`║  Unique tracks:          ${tracksToProcess.length.toString().padStart(8)}`);
  console.log(`║  Track ID recovered:     ${recovered.toString().padStart(8)} (${(100 * recovered / totalParsed).toFixed(1)}%)`);
  console.log(`║  Ambiguous:              ${ambiguousCount.toString().padStart(8)}`);
  console.log("║  ────────────────────────────────────────");
  console.log(`║  ISRC matches:           ${isrcMatches.toString().padStart(8)}`);
  console.log(`║  Text matches (≥0.90):   ${textMatches.toString().padStart(8)}`);
  console.log(`║  Review queue (0.70-0.90):${reviewCount.toString().padStart(7)}`);
  console.log(`║  Unmatched (<0.70):      ${unmatchedCount.toString().padStart(8)}`);
  console.log("║  ────────────────────────────────────────");
  console.log(`║  Plays written to D1:    ${finalCount.count.toString().padStart(8)}`);
  console.log("╚══════════════════════════════════════════╝");
}

// ── Track matching ──

async function matchTrack(event: PlayEvent): Promise<MatchResult> {
  const { row, cacheKey, appleTrackId } = event;
  let itunesData: ItunesTrack | null = null;
  let isrc: string | null = null;
  let bestCandidate: SpotifyMatchCandidate | null = null;
  let allCandidates: SpotifyMatchCandidate[] = [];

  // Stage 1: iTunes Lookup → MusicBrainz ISRC → Spotify ISRC search
  // ISRC short-circuit: Stage 1 success (ISRC match via iTunes Lookup →
  // MusicBrainz → Spotify) returns immediately with confidence = 1.00 and
  // match_method = 'isrc'. Stages 2+ do not run for this track.
  // The cascade is short-circuit, not best-of-N.
  if (appleTrackId) {
    itunesData = await lookupTrack(appleTrackId);

    if (itunesData && !SKIP_MB) {
      isrc = await findIsrc(itunesData.artistName, itunesData.trackName);

      if (isrc) {
        const token = await getSpotifyToken();
        const isrcMatch = await searchByIsrc(isrc, token);
        if (isrcMatch) {
          return {
            cacheKey,
            appleTrackId,
            bestCandidate: isrcMatch,
            allCandidates: [isrcMatch],
            itunesData,
            isrc,
            matchStatus: "matched",
            originalSongName: row.songName,
            originalArtistName: row.artistName,
            originalAlbumName: row.albumName,
          };
        }
      }
    }
  }

  // Stage 2: Text match via Spotify search
  const trackName = itunesData?.trackName ?? row.songName;
  const artistName = itunesData?.artistName ?? row.artistName;
  const albumName = itunesData?.collectionName ?? row.albumName || null;
  const durationMs = itunesData?.trackTimeMillis ?? null;

  const token = await getSpotifyToken();
  allCandidates = await searchByText(trackName, artistName, albumName, durationMs, token);
  bestCandidate = allCandidates[0] ?? null;

  // Stage 3: Bucketize
  let matchStatus: "matched" | "review" | "unmatched";
  if (bestCandidate && bestCandidate.confidence >= 0.90) {
    matchStatus = "matched";
  } else if (bestCandidate && bestCandidate.confidence >= 0.70) {
    matchStatus = "review";
  } else {
    matchStatus = "unmatched";
  }

  return {
    cacheKey,
    appleTrackId,
    bestCandidate,
    allCandidates,
    itunesData,
    isrc,
    matchStatus,
    originalSongName: row.songName,
    originalArtistName: row.artistName,
    originalAlbumName: row.albumName,
  };
}

// ── D1 write helpers ──

async function writeMatchToCache(match: MatchResult): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await writeD1(
    `INSERT OR REPLACE INTO apple_track_matches (
      cache_key, apple_track_id, spotify_track_uri, spotify_track_name,
      spotify_artist_name, spotify_album_name, spotify_duration_ms,
      match_confidence, match_method, match_status,
      itunes_artist_name, itunes_track_name, itunes_album_name,
      itunes_duration_ms, itunes_release_date, itunes_genre,
      musicbrainz_isrc, original_song_name, original_album_name,
      original_artist_name, first_seen_at, last_match_attempt_at,
      match_attempts, reviewed_by_human
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
    [
      match.cacheKey,
      match.appleTrackId,
      match.bestCandidate?.spotifyTrackUri ?? null,
      match.bestCandidate?.trackName ?? null,
      match.bestCandidate?.artistName ?? null,
      match.bestCandidate?.albumName ?? null,
      match.bestCandidate?.durationMs ?? null,
      match.bestCandidate?.confidence ?? null,
      match.bestCandidate?.matchMethod ?? null,
      match.matchStatus,
      match.itunesData?.artistName ?? null,
      match.itunesData?.trackName ?? null,
      match.itunesData?.collectionName ?? null,
      match.itunesData?.trackTimeMillis ?? null,
      match.itunesData?.releaseDate ?? null,
      match.itunesData?.primaryGenreName ?? null,
      match.isrc,
      match.originalSongName,
      match.originalAlbumName || null,
      match.originalArtistName,
      now,
      now,
    ],
  );
}

function normalizeApplePlatform(deviceType: string): string {
  const lower = (deviceType ?? "").toLowerCase();
  if (lower.includes("iphone")) return "apple_iphone";
  if (lower.includes("ipad")) return "apple_ipad";
  if (lower.includes("homepod")) return "apple_homepod";
  if (lower.includes("appletv") || lower.includes("apple tv")) return "apple_appletv";
  if (lower.includes("mac") || lower.includes("osx") || lower.includes("os x")) return "apple_macos";
  if (lower) return `apple_${lower}`;
  return "apple_unknown";
}

// ── Run ──

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
