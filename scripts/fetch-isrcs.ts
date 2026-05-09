#!/usr/bin/env npx tsx
/**
 * @deprecated Laptop version — use stack/lyrics-backfill/ on grimmauldplace instead.
 * This version shells out to wrangler and races with the Worker on token refresh.
 *
 * fetch-isrcs.ts — Populate track_isrc_cache from Spotify's single-track endpoint.
 *
 * Usage:
 *   npx tsx scripts/fetch-isrcs.ts              # full run
 *   npx tsx scripts/fetch-isrcs.ts --limit 100  # first 100 uncached URIs only
 *
 * The batch endpoint (/v1/tracks?ids=...) is blocked by Spotify Dev Mode,
 * so we use the single-track endpoint at ~10 req/sec.
 *
 * Idempotent: skips URIs already in track_isrc_cache.
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { getSpotifyAccessToken } from "./lib/spotify-token";

const DB_NAME = "spotify-agent-db";
const RATE_LIMIT_MS = 100; // 10 req/sec
const PROGRESS_INTERVAL = 500;

const args = process.argv.slice(2);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

function execD1Query(sql: string): string {
  // For SELECT queries — use --command with --json, suppress stderr
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}" 2>/dev/null`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  return result;
}

function execD1Write(sql: string): void {
  // For INSERT/UPDATE — use --file (handles large statements), no --json needed
  const tmpFile = join(__dirname, "..", ".tmp-isrc.sql");
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

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  console.log("=== ISRC Backfill ===\n");

  // Get distinct URIs from plays that aren't already cached
  console.log("Querying for uncached track URIs...");
  const queryResult = execD1Query(
    "SELECT DISTINCT p.spotify_track_uri FROM plays p LEFT JOIN track_isrc_cache c ON c.spotify_track_uri = p.spotify_track_uri WHERE c.spotify_track_uri IS NULL ORDER BY p.spotify_track_uri"
  );

  const parsed = JSON.parse(queryResult);
  const allUris: string[] = (parsed[0]?.results ?? []).map((r: { spotify_track_uri: string }) => r.spotify_track_uri);

  const uris = allUris.slice(0, limit);
  console.log(`Found ${allUris.length} uncached URIs. Processing ${uris.length}.\n`);

  if (uris.length === 0) {
    console.log("Nothing to do — all URIs already cached.");
    return;
  }

  // Get token
  const token = await getSpotifyAccessToken();
  console.log("Spotify token acquired.\n");

  let success = 0;
  let noIsrc = 0;
  let errors = 0;
  const now = Math.floor(Date.now() / 1000);

  // Process one at a time with rate limiting
  const batchInserts: string[] = [];
  const BATCH_WRITE_SIZE = 50;

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    const trackId = uri.replace("spotify:track:", "");

    try {
      const resp = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (resp.status === 429) {
        const retryAfter = parseInt(resp.headers.get("Retry-After") ?? "5", 10);
        if (retryAfter > 60) {
          const { setSpotifyCooldown } = await import("./lib/spotify-rate-guard");
          setSpotifyCooldown(retryAfter, "fetch-isrcs");
          console.error(`Spotify 429 with Retry-After ${retryAfter}s — cooldown set, exiting`);
          process.exit(1);
        }
        console.log(`  Rate limited. Waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        i--; // retry this one
        continue;
      }

      if (!resp.ok) {
        errors++;
        if (resp.status === 404) {
          // Track removed from Spotify — cache with null ISRC
          batchInserts.push(
            `('${escapeSQL(uri)}', NULL, NULL, NULL, ${now})`,
          );
          noIsrc++;
        } else {
          console.log(`  Error ${resp.status} for ${trackId}`);
        }
      } else {
        const data = (await resp.json()) as {
          external_ids?: { isrc?: string };
          duration_ms?: number;
          album?: { name?: string };
        };

        const isrc = data.external_ids?.isrc ?? null;
        const durationMs = data.duration_ms ?? null;
        const albumName = data.album?.name ?? null;

        batchInserts.push(
          `('${escapeSQL(uri)}', ${isrc ? `'${escapeSQL(isrc)}'` : "NULL"}, ${durationMs ?? "NULL"}, ${albumName ? `'${escapeSQL(albumName)}'` : "NULL"}, ${now})`,
        );

        if (isrc) success++;
        else noIsrc++;
      }
    } catch (err) {
      errors++;
      console.log(`  Fetch error for ${trackId}:`, (err as Error).message);
    }

    // Write batch to D1 periodically
    if (batchInserts.length >= BATCH_WRITE_SIZE) {
      const sql = `INSERT OR IGNORE INTO track_isrc_cache (spotify_track_uri, isrc, duration_ms, album_name, fetched_at) VALUES ${batchInserts.join(",\n")};`;
      execD1Write(sql);
      batchInserts.length = 0;
    }

    // Progress report
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === uris.length - 1) {
      const pct = Math.round(((i + 1) / uris.length) * 100);
      console.log(`  [${pct}%] ${i + 1}/${uris.length} — ${success} ISRCs, ${noIsrc} missing, ${errors} errors`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  // Flush remaining batch
  if (batchInserts.length > 0) {
    const sql = `INSERT OR IGNORE INTO track_isrc_cache (spotify_track_uri, isrc, duration_ms, album_name, fetched_at) VALUES ${batchInserts.join(",\n")};`;
    execD1Write(sql);
  }

  console.log("\n=== ISRC Backfill Complete ===");
  console.log(`Total processed: ${uris.length}`);
  console.log(`With ISRC: ${success} (${Math.round((success / uris.length) * 100)}%)`);
  console.log(`No ISRC: ${noIsrc}`);
  console.log(`Errors: ${errors}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
