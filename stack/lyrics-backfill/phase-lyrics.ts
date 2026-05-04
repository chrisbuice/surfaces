/**
 * phase-lyrics.ts — Populate track_lyrics from LRCLIB.
 *
 * Uses the D1 HTTP API (not wrangler). No Spotify calls needed.
 * Restart-safe: skips URIs already in track_lyrics with status != 'error'/'pending'.
 * Bounded concurrency via p-limit; pacing via per-request jitter + global 429 pause.
 */

import pLimit from "p-limit";
import { queryD1, writeD1 } from "./lib/d1.js";
import { LrclibClient } from "./lib/lrclib.js";

const PROGRESS_INTERVAL = 100;
const BATCH_WRITE_SIZE = 5;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;
const MAX_LYRICS_CHARS = 50_000;

// --- CLI / env config ---
const args = process.argv.slice(3);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

const concIdx = args.indexOf("--concurrency");
const concurrency = concIdx !== -1
  ? parseInt(args[concIdx + 1], 10)
  : parseInt(process.env.LYRICS_CONCURRENCY ?? "2", 10);

// --- Helpers ---

function escapeSQL(val: string): string {
  return val.replace(/'/g, "''");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Random jitter between 50ms and 200ms */
function jitter(): Promise<void> {
  return sleep(50 + Math.random() * 150);
}

/** Strip feat./ft./featuring and parenthetical content from artist name */
function cleanArtist(artist: string): string {
  return artist
    .replace(/\s*\(.*?\)\s*/g, "")
    .replace(/\s*(feat\.|ft\.|featuring)\s*.*/i, "")
    .trim();
}

// --- Global 429 pause state ---
// Consecutive429s increments on any 429, resets to 0 on any successful (non-429) response.
// When it hits 3, globalPauseUntil is set and all workers wait.

let consecutive429s = 0;
let globalPauseUntil = 0;

function record429(waitMs: number): void {
  consecutive429s++;
  if (consecutive429s >= 3) {
    // Double the pause duration for sustained rate limiting
    const pauseMs = waitMs * 2;
    globalPauseUntil = Math.max(globalPauseUntil, Date.now() + pauseMs);
    console.log(`  ⚠ Sustained 429s (${consecutive429s} consecutive) — all workers pausing ${Math.round(pauseMs / 1000)}s`);
  }
}

function recordSuccess(): void {
  consecutive429s = 0;
}

async function waitForGlobalPause(): Promise<void> {
  const remaining = globalPauseUntil - Date.now();
  if (remaining > 0) {
    await sleep(remaining);
  }
}

// --- Types ---

interface TrackToFetch {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string | null;
  duration_ms: number | null;
  isrc: string | null;
}

// --- Fetch with retry + global pause ---

async function fetchWithRetry(
  client: LrclibClient,
  track: TrackToFetch,
): Promise<Awaited<ReturnType<LrclibClient["fetchLyrics"]>>> {
  const cleanedArtist = cleanArtist(track.artist_name);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForGlobalPause();
    await jitter();

    try {
      const result = await client.fetchLyrics({
        trackName: track.track_name,
        artistName: cleanedArtist,
        albumName: track.album_name ?? undefined,
        durationMs: track.duration_ms ?? undefined,
      });
      recordSuccess();
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429") || msg.toLowerCase().includes("rate")) {
        if (attempt === MAX_RETRIES) throw err;
        const waitMs = BASE_DELAY_MS * Math.pow(2, attempt);
        record429(waitMs);
        console.log(`  LRCLIB 429 — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Unreachable");
}

// --- Mutex-protected batch flush ---

const batchInserts: string[] = [];
let flushChain: Promise<void> = Promise.resolve();

function enqueueFlushIfNeeded(): void {
  if (batchInserts.length >= BATCH_WRITE_SIZE) {
    const toFlush = batchInserts.splice(0, batchInserts.length);
    flushChain = flushChain.then(() => flushBatch(toFlush));
  }
}

function enqueueFinalFlush(): Promise<void> {
  if (batchInserts.length > 0) {
    const toFlush = batchInserts.splice(0, batchInserts.length);
    flushChain = flushChain.then(() => flushBatch(toFlush));
  }
  return flushChain;
}

let tooBig = 0;

async function flushBatch(rows: string[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = `INSERT OR REPLACE INTO track_lyrics (spotify_track_uri, track_name, artist_name, album_name, duration_ms, isrc, lyrics_plain, lyrics_synced, instrumental, lyrics_length, status, source, match_method, fetched_at, attempts) VALUES\n${rows.join(",\n")};`;
  try {
    await writeD1(sql);
  } catch (err) {
    const msg = (err as Error).message;
    if (msg.includes("SQLITE_TOOBIG") || msg.includes("statement too long")) {
      // Extract URIs from the batch for logging (first field in each row)
      const uris = rows.map((r) => {
        const match = r.match(/^\('([^']+)'/);
        return match ? match[1] : "unknown";
      });
      console.log(`  ⚠ SQLITE_TOOBIG — skipping batch of ${rows.length}: ${uris.join(", ")}`);
      tooBig += rows.length;
      return;
    }
    throw err;
  }
}

// --- Main ---

async function main() {
  console.log("=== Lyrics Backfill (grimmauldplace) ===");
  console.log(`Concurrency: ${concurrency}\n`);

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
  const total = toProcess.length;

  // Counters (safe: JS is single-threaded, increments are synchronous between awaits)
  let ok = 0;
  let notFound = 0;
  let instrumental = 0;
  let errors = 0;
  let completed = 0;

  const limiter = pLimit(concurrency);

  const tasks = toProcess.map((track) =>
    limiter(async () => {
      try {
        const result = await fetchWithRetry(client, track);

        if (result) {
          const lyricsLength = result.plainLyrics?.length ?? 0;
          let plain = result.plainLyrics;
          let synced = result.syncedLyrics;
          if (plain && plain.length > MAX_LYRICS_CHARS) {
            plain = plain.slice(0, MAX_LYRICS_CHARS) + "\n[TRUNCATED]";
          }
          if (synced && synced.length > MAX_LYRICS_CHARS) {
            synced = synced.slice(0, MAX_LYRICS_CHARS) + "\n[TRUNCATED]";
          }
          batchInserts.push(
            `('${escapeSQL(track.spotify_track_uri)}', '${escapeSQL(track.track_name)}', '${escapeSQL(track.artist_name)}', ${track.album_name ? `'${escapeSQL(track.album_name)}'` : "NULL"}, ${track.duration_ms ?? "NULL"}, ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, ${plain ? `'${escapeSQL(plain)}'` : "NULL"}, ${synced ? `'${escapeSQL(synced)}'` : "NULL"}, ${result.instrumental ? 1 : 0}, ${lyricsLength || "NULL"}, 'ok', 'lrclib', '${result.matchMethod}', ${now}, 1)`,
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

      // Size-triggered flush (mutex-protected)
      enqueueFlushIfNeeded();

      // Progress report
      completed++;
      if (completed % PROGRESS_INTERVAL === 0 || completed === total) {
        const pct = Math.round((completed / total) * 100);
        console.log(`  [${pct}%] ${completed}/${total} — ok:${ok} instrumental:${instrumental} not_found:${notFound} error:${errors}`);
      }
    }),
  );

  await Promise.all(tasks);

  // Final flush — wait for all pending writes to complete
  await enqueueFinalFlush();

  console.log("\n=== Lyrics Backfill Complete ===");
  console.log(`Total processed: ${total}`);
  console.log(`With lyrics (ok): ${ok} (${Math.round((ok / total) * 100)}%)`);
  console.log(`Instrumental: ${instrumental} (${Math.round((instrumental / total) * 100)}%)`);
  console.log(`Not found: ${notFound} (${Math.round((notFound / total) * 100)}%)`);
  console.log(`Errors: ${errors}`);
  console.log(`Too-big skipped: ${tooBig}`);
  console.log(`Coverage (ok + instrumental): ${Math.round(((ok + instrumental) / total) * 100)}%`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
