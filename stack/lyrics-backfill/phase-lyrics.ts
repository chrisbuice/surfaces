/**
 * phase-lyrics.ts — Populate track_lyrics from LRCLIB.
 *
 * Uses the D1 HTTP API (not wrangler). No Spotify calls needed.
 * Restart-safe: skips URIs already in track_lyrics with status != 'error'/'pending'.
 * Paces at 5 req/sec via LrclibClient's internal throttle.
 */

import { queryD1, writeD1 } from "./lib/d1.js";
import { LrclibClient } from "../../src/lyrics/lrclib.js";

const PROGRESS_INTERVAL = 100;
const BATCH_WRITE_SIZE = 25;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

const args = process.argv.slice(3);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

function escapeSQL(val: string): string {
  return val.replace(/'/g, "''");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function fetchWithRetry(
  client: LrclibClient,
  track: TrackToFetch,
): Promise<Awaited<ReturnType<LrclibClient["fetchLyrics"]>>> {
  const cleanedArtist = cleanArtist(track.artist_name);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.fetchLyrics({
        trackName: track.track_name,
        artistName: cleanedArtist,
        albumName: track.album_name ?? undefined,
        durationMs: track.duration_ms ?? undefined,
      });
    } catch (err) {
      const msg = (err as Error).message;
      // Check if the error is a 429 from LRCLIB
      if (msg.includes("429") || msg.toLowerCase().includes("rate")) {
        if (attempt === MAX_RETRIES) throw err;
        const waitMs = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`  LRCLIB 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Unreachable");
}

async function main() {
  console.log("=== Lyrics Backfill (grimmauldplace) ===\n");

  console.log("Querying for tracks needing lyrics...");
  const tracks = await queryD1<TrackToFetch>(
    "SELECT p.spotify_track_uri, p.track_name, p.artist_name, c.album_name, c.duration_ms, c.isrc FROM (SELECT DISTINCT spotify_track_uri, track_name, artist_name FROM plays) p LEFT JOIN track_isrc_cache c ON c.spotify_track_uri = p.spotify_track_uri LEFT JOIN track_lyrics l ON l.spotify_track_uri = p.spotify_track_uri WHERE l.spotify_track_uri IS NULL OR l.status IN ('error', 'pending') ORDER BY p.spotify_track_uri",
  );

  const toProcess = tracks.slice(0, limit);
  console.log(`Found ${tracks.length} tracks needing lyrics. Processing ${toProcess.length}.\n`);

  if (toProcess.length === 0) {
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

  for (let i = 0; i < toProcess.length; i++) {
    const track = toProcess[i];

    try {
      const result = await fetchWithRetry(client, track);

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
      const sql = `INSERT OR REPLACE INTO track_lyrics (spotify_track_uri, track_name, artist_name, album_name, duration_ms, isrc, lyrics_plain, lyrics_synced, instrumental, lyrics_length, status, source, match_method, fetched_at, attempts) VALUES\n${batchInserts.join(",\n")};`;
      await writeD1(sql);
      batchInserts.length = 0;
    }

    // Progress report
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === toProcess.length - 1) {
      const pct = Math.round(((i + 1) / toProcess.length) * 100);
      console.log(`  [${pct}%] ${i + 1}/${toProcess.length} — ok:${ok} instrumental:${instrumental} not_found:${notFound} error:${errors}`);
    }
  }

  // Flush remaining
  if (batchInserts.length > 0) {
    const sql = `INSERT OR REPLACE INTO track_lyrics (spotify_track_uri, track_name, artist_name, album_name, duration_ms, isrc, lyrics_plain, lyrics_synced, instrumental, lyrics_length, status, source, match_method, fetched_at, attempts) VALUES\n${batchInserts.join(",\n")};`;
    await writeD1(sql);
  }

  console.log("\n=== Lyrics Backfill Complete ===");
  console.log(`Total processed: ${toProcess.length}`);
  console.log(`With lyrics (ok): ${ok} (${Math.round((ok / toProcess.length) * 100)}%)`);
  console.log(`Instrumental: ${instrumental} (${Math.round((instrumental / toProcess.length) * 100)}%)`);
  console.log(`Not found: ${notFound} (${Math.round((notFound / toProcess.length) * 100)}%)`);
  console.log(`Errors: ${errors}`);
  console.log(`Coverage (ok + instrumental): ${Math.round(((ok + instrumental) / toProcess.length) * 100)}%`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
