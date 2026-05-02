#!/usr/bin/env npx tsx
/**
 * backfill-lyrics.ts — Populate track_lyrics from LRCLIB.
 *
 * Usage:
 *   npx tsx scripts/backfill-lyrics.ts              # full run
 *   npx tsx scripts/backfill-lyrics.ts --limit 100  # first 100 tracks only
 *
 * Queries plays for distinct URIs not yet in track_lyrics (or with status
 * 'error'/'pending'), joins against track_isrc_cache for duration/album,
 * then fetches lyrics from LRCLIB.
 *
 * Restart-safe: re-running picks up where it left off.
 * Paces at 5 req/sec via the LrclibClient's internal throttle.
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { LrclibClient } from "../src/lyrics/lrclib";

const DB_NAME = "spotify-agent-db";
const PROGRESS_INTERVAL = 100;

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

function execD1Query(sql: string): string {
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}" 2>/dev/null`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  return result;
}

function execD1Write(sql: string): void {
  const tmpFile = join(__dirname, "..", ".tmp-lyrics.sql");
  writeFileSync(tmpFile, sql);
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --file=${tmpFile} --remote 2>/dev/null`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
  } finally {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  }
}

function escapeSQL(val: string): string {
  return val.replace(/'/g, "''");
}

/** Strip feat./ft./featuring and parenthetical content from artist name */
function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\s*(feat\.|ft\.|featuring)\s*.*/i, "")
    .trim();
}

interface TrackToFetch {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  duration_ms: number | null;
  isrc: string | null;
}

async function main() {
  console.log("=== Lyrics Backfill ===\n");

  // Get tracks that need lyrics fetched
  console.log("Querying for tracks needing lyrics...");
  const queryResult = execD1Query(
    "SELECT p.spotify_track_uri, p.track_name, p.artist_name, c.album_name, c.duration_ms, c.isrc FROM (SELECT DISTINCT spotify_track_uri, track_name, artist_name FROM plays) p LEFT JOIN track_isrc_cache c ON c.spotify_track_uri = p.spotify_track_uri LEFT JOIN track_lyrics l ON l.spotify_track_uri = p.spotify_track_uri WHERE l.spotify_track_uri IS NULL OR l.status IN ('error', 'pending') ORDER BY p.spotify_track_uri"
  );

  const parsed = JSON.parse(queryResult);
  const allTracks: TrackToFetch[] = parsed[0]?.results ?? [];

  const tracks = allTracks.slice(0, limit);
  console.log(`Found ${allTracks.length} tracks needing lyrics. Processing ${tracks.length}.\n`);

  if (tracks.length === 0) {
    console.log("Nothing to do — all tracks have lyrics status.");
    return;
  }

  const client = new LrclibClient();
  const now = Math.floor(Date.now() / 1000);

  let ok = 0;
  let notFound = 0;
  let instrumental = 0;
  let errors = 0;
  const batchInserts: string[] = [];
  const BATCH_WRITE_SIZE = 25;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const cleanedArtist = cleanArtist(track.artist_name);

    try {
      const result = await client.fetchLyrics({
        trackName: track.track_name,
        artistName: cleanedArtist,
        albumName: track.album_name ?? undefined,
        durationMs: track.duration_ms ?? undefined,
      });

      if (result) {
        const lyricsLength = result.plainLyrics?.length ?? 0;
        batchInserts.push(
          `('${escapeSQL(track.spotify_track_uri)}', '${escapeSQL(track.track_name)}', '${escapeSQL(track.artist_name)}', ${track.album_name ? `'${escapeSQL(track.album_name)}'` : "NULL"}, ${track.duration_ms ?? "NULL"}, ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, ${result.plainLyrics ? `'${escapeSQL(result.plainLyrics)}'` : "NULL"}, ${result.syncedLyrics ? `'${escapeSQL(result.syncedLyrics)}'` : "NULL"}, ${result.instrumental ? 1 : 0}, ${lyricsLength || "NULL"}, 'ok', 'lrclib', '${result.matchMethod}', ${now}, 1)`,
        );
        if (result.instrumental) instrumental++;
        else ok++;
      } else {
        batchInserts.push(
          `('${escapeSQL(track.spotify_track_uri)}', '${escapeSQL(track.track_name)}', '${escapeSQL(track.artist_name)}', ${track.album_name ? `'${escapeSQL(track.album_name)}'` : "NULL"}, ${track.duration_ms ?? "NULL"}, ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, NULL, NULL, 0, NULL, 'not_found', 'lrclib', NULL, ${now}, 1)`,
        );
        notFound++;
      }
    } catch (err) {
      batchInserts.push(
        `('${escapeSQL(track.spotify_track_uri)}', '${escapeSQL(track.track_name)}', '${escapeSQL(track.artist_name)}', ${track.album_name ? `'${escapeSQL(track.album_name)}'` : "NULL"}, ${track.duration_ms ?? "NULL"}, ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, NULL, NULL, 0, NULL, 'error', 'lrclib', NULL, ${now}, 1)`,
      );
      errors++;
      if (errors <= 5) {
        console.log(`  Error on "${track.track_name}": ${(err as Error).message}`);
      }
    }

    // Write batch to D1 periodically
    if (batchInserts.length >= BATCH_WRITE_SIZE) {
      flushBatch(batchInserts);
      batchInserts.length = 0;
    }

    // Progress report
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === tracks.length - 1) {
      const pct = Math.round(((i + 1) / tracks.length) * 100);
      console.log(`  [${pct}%] ${i + 1}/${tracks.length} — ok:${ok} instrumental:${instrumental} not_found:${notFound} error:${errors}`);
    }
  }

  // Flush remaining
  if (batchInserts.length > 0) {
    flushBatch(batchInserts);
  }

  console.log("\n=== Lyrics Backfill Complete ===");
  console.log(`Total processed: ${tracks.length}`);
  console.log(`With lyrics (ok): ${ok} (${Math.round((ok / tracks.length) * 100)}%)`);
  console.log(`Instrumental: ${instrumental} (${Math.round((instrumental / tracks.length) * 100)}%)`);
  console.log(`Not found: ${notFound} (${Math.round((notFound / tracks.length) * 100)}%)`);
  console.log(`Errors: ${errors}`);
  console.log(`Coverage (ok + instrumental): ${Math.round(((ok + instrumental) / tracks.length) * 100)}%`);
}

function flushBatch(inserts: string[]): void {
  const sql = `INSERT OR REPLACE INTO track_lyrics (spotify_track_uri, track_name, artist_name, album_name, duration_ms, isrc, lyrics_plain, lyrics_synced, instrumental, lyrics_length, status, source, match_method, fetched_at, attempts) VALUES\n${inserts.join(",\n")};`;
  execD1Write(sql);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
