/**
 * phase-isrc.ts — Populate track_isrc_cache from Spotify's single-track endpoint.
 *
 * Uses the D1 HTTP API (not wrangler) and the Worker's token broker (not KV).
 * Idempotent: skips URIs already in track_isrc_cache.
 *
 * Note: Spotify Dev Mode blocks the batch endpoint (/v1/tracks?ids=...),
 * so we use the single-track endpoint at ~10 req/sec.
 */

import { queryD1, writeD1 } from "./lib/d1.js";
import { getSpotifyToken } from "./lib/spotify.js";

const RATE_LIMIT_MS = 100; // 10 req/sec
const PROGRESS_INTERVAL = 500;
const BATCH_WRITE_SIZE = 50;
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1000;

const args = process.argv.slice(3); // skip "node main.ts isrc"
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : Infinity;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeSQL(val: string): string {
  return val.replace(/'/g, "''");
}

interface UriRow {
  spotify_track_uri: string;
}

async function fetchTrackWithRetry(
  trackId: string,
  token: string,
): Promise<{ isrc: string | null; durationMs: number | null; albumName: string | null } | "not_found" | "error"> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.status === 429) {
      if (attempt === MAX_RETRIES) {
        console.error(`  Spotify 429 after ${MAX_RETRIES} retries for ${trackId}`);
        return "error";
      }
      const retryAfter = parseInt(resp.headers.get("Retry-After") ?? "5", 10);
      console.log(`  Spotify 429 — waiting ${retryAfter}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await sleep(retryAfter * 1000);
      continue;
    }

    if (resp.status === 401) {
      // Token expired mid-run — caller should refresh and retry
      throw new Error("TOKEN_EXPIRED");
    }

    if (resp.status === 404) {
      return "not_found";
    }

    if (!resp.ok) {
      console.error(`  Spotify ${resp.status} for ${trackId}`);
      return "error";
    }

    const data = (await resp.json()) as {
      external_ids?: { isrc?: string };
      duration_ms?: number;
      album?: { name?: string };
    };

    return {
      isrc: data.external_ids?.isrc ?? null,
      durationMs: data.duration_ms ?? null,
      albumName: data.album?.name ?? null,
    };
  }

  return "error";
}

async function main() {
  console.log("=== ISRC Backfill (grimmauldplace) ===\n");

  console.log("Querying for uncached track URIs...");
  const rows = await queryD1<UriRow>(
    "SELECT DISTINCT p.spotify_track_uri FROM plays p LEFT JOIN track_isrc_cache c ON c.spotify_track_uri = p.spotify_track_uri WHERE c.spotify_track_uri IS NULL ORDER BY p.spotify_track_uri",
  );

  const allUris = rows.map((r) => r.spotify_track_uri);
  const uris = allUris.slice(0, limit);
  console.log(`Found ${allUris.length} uncached URIs. Processing ${uris.length}.\n`);

  if (uris.length === 0) {
    console.log("Nothing to do — all URIs already cached.");
    return;
  }

  let token = await getSpotifyToken();
  console.log("Spotify token acquired via broker.\n");

  let success = 0;
  let noIsrc = 0;
  let errors = 0;
  const now = Math.floor(Date.now() / 1000);
  const batchInserts: string[] = [];

  for (let i = 0; i < uris.length; i++) {
    const uri = uris[i];
    const trackId = uri.replace("spotify:track:", "");

    try {
      const result = await fetchTrackWithRetry(trackId, token);

      if (result === "error") {
        errors++;
      } else if (result === "not_found") {
        batchInserts.push(
          `('${escapeSQL(uri)}', NULL, NULL, NULL, ${now})`,
        );
        noIsrc++;
      } else {
        batchInserts.push(
          `('${escapeSQL(uri)}', ${result.isrc ? `'${escapeSQL(result.isrc)}'` : "NULL"}, ${result.durationMs ?? "NULL"}, ${result.albumName ? `'${escapeSQL(result.albumName)}'` : "NULL"}, ${now})`,
        );
        if (result.isrc) success++;
        else noIsrc++;
      }
    } catch (err) {
      if ((err as Error).message === "TOKEN_EXPIRED") {
        console.log("  Token expired — refreshing via broker...");
        token = await getSpotifyToken();
        i--; // retry this track
        continue;
      }
      errors++;
      console.error(`  Fetch error for ${trackId}:`, (err as Error).message);
    }

    // Write batch to D1 periodically
    if (batchInserts.length >= BATCH_WRITE_SIZE) {
      const sql = `INSERT OR IGNORE INTO track_isrc_cache (spotify_track_uri, isrc, duration_ms, album_name, fetched_at) VALUES ${batchInserts.join(",\n")};`;
      await writeD1(sql);
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
    await writeD1(sql);
  }

  console.log("\n=== ISRC Backfill Complete ===");
  console.log(`Total processed: ${uris.length}`);
  console.log(`With ISRC: ${success} (${Math.round((success / uris.length) * 100)}%)`);
  console.log(`No ISRC: ${noIsrc}`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
