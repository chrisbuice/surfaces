#!/usr/bin/env npx tsx
/**
 * backfill-credits.ts — Populate track_credits + track_credits_status from MusicBrainz.
 *
 * Usage:
 *   npx tsx scripts/backfill-credits.ts              # full run
 *   npx tsx scripts/backfill-credits.ts --limit 100  # first 100 tracks only
 *
 * Queries plays for distinct URIs not yet in track_credits_status,
 * joins against track_isrc_cache for ISRC, then looks up credits via MusicBrainz.
 *
 * Restart-safe: re-running picks up where it left off.
 * Paces at 1 req/sec hard (enforced by MusicBrainzClient). Each track takes
 * 2-3 requests, so expect ~2-3 sec/track. Full run for 25K tracks ≈ 14 hours.
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync } from "fs";
import { join } from "path";
import { MusicBrainzClient } from "../src/credits/musicbrainz";

const DB_NAME = "spotify-agent-db";
const PROGRESS_INTERVAL = 50;

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
  const tmpFile = join(__dirname, "..", ".tmp-credits.sql");
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
  isrc: string | null;
}

async function main() {
  console.log("=== Credits Backfill ===\n");

  // Get tracks that need credits fetched
  console.log("Querying for tracks needing credits...");
  const queryResult = execD1Query(
    "SELECT p.spotify_track_uri, p.track_name, p.artist_name, c.isrc FROM (SELECT DISTINCT spotify_track_uri, track_name, artist_name FROM plays) p LEFT JOIN track_isrc_cache c ON c.spotify_track_uri = p.spotify_track_uri LEFT JOIN track_credits_status s ON s.spotify_track_uri = p.spotify_track_uri WHERE s.spotify_track_uri IS NULL ORDER BY p.spotify_track_uri"
  );

  const parsed = JSON.parse(queryResult);
  const allTracks: TrackToFetch[] = parsed[0]?.results ?? [];

  const tracks = allTracks.slice(0, limit);
  console.log(`Found ${allTracks.length} tracks needing credits. Processing ${tracks.length}.\n`);

  if (tracks.length === 0) {
    console.log("Nothing to do — all tracks have credits status.");
    return;
  }

  const client = new MusicBrainzClient();
  const now = Math.floor(Date.now() / 1000);

  let okCount = 0;
  let noRecording = 0;
  let noWork = 0;
  let errors = 0;

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];
    const cleanedArtist = cleanArtist(track.artist_name);

    try {
      const result = await client.lookupCredits({
        isrc: track.isrc ?? undefined,
        trackName: track.track_name,
        artistName: cleanedArtist,
      });

      // Write track_credits_status row
      const statusSql = `INSERT OR REPLACE INTO track_credits_status (spotify_track_uri, isrc, mb_recording_id, mb_work_id, status, fetched_at, attempts) VALUES ('${escapeSQL(track.spotify_track_uri)}', ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, ${result.mbRecordingId ? `'${escapeSQL(result.mbRecordingId)}'` : "NULL"}, ${result.mbWorkId ? `'${escapeSQL(result.mbWorkId)}'` : "NULL"}, '${result.status}', ${now}, 1);`;

      // Write track_credits rows if we got credits
      let creditsSql = "";
      if (result.credits.length > 0) {
        const values = result.credits.map(c =>
          `('${escapeSQL(track.spotify_track_uri)}', '${escapeSQL(c.personName)}', '${c.role}', ${c.roleRaw ? `'${escapeSQL(c.roleRaw)}'` : "NULL"}, 'musicbrainz', '${escapeSQL(c.mbArtistId)}', ${result.mbWorkId ? `'${escapeSQL(result.mbWorkId)}'` : "NULL"}, ${result.mbRecordingId ? `'${escapeSQL(result.mbRecordingId)}'` : "NULL"}, ${now})`,
        );
        creditsSql = `INSERT INTO track_credits (spotify_track_uri, person_name, role, role_raw, source, mb_artist_id, mb_work_id, mb_recording_id, fetched_at) VALUES\n${values.join(",\n")};`;
      }

      execD1Write(statusSql + "\n" + creditsSql);

      switch (result.status) {
        case "ok": okCount++; break;
        case "no_recording": noRecording++; break;
        case "no_work": noWork++; break;
        case "error": errors++; break;
      }
    } catch (err) {
      // Write error status so we don't retry immediately
      const errorSql = `INSERT OR REPLACE INTO track_credits_status (spotify_track_uri, isrc, mb_recording_id, mb_work_id, status, fetched_at, attempts) VALUES ('${escapeSQL(track.spotify_track_uri)}', ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, NULL, NULL, 'error', ${now}, 1);`;
      try { execD1Write(errorSql); } catch { /* best effort */ }
      errors++;
      if (errors <= 5) {
        console.log(`  Error on "${track.track_name}": ${(err as Error).message}`);
      }
    }

    // Progress report
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === tracks.length - 1) {
      const pct = Math.round(((i + 1) / tracks.length) * 100);
      const elapsed = Math.round((Date.now() / 1000) - (now - 1));
      const rate = ((i + 1) / elapsed).toFixed(1);
      console.log(`  [${pct}%] ${i + 1}/${tracks.length} — ok:${okCount} no_recording:${noRecording} no_work:${noWork} error:${errors} (${rate} tracks/sec)`);
    }
  }

  console.log("\n=== Credits Backfill Complete ===");
  console.log(`Total processed: ${tracks.length}`);
  console.log(`With credits (ok): ${okCount} (${Math.round((okCount / tracks.length) * 100)}%)`);
  console.log(`No recording found: ${noRecording} (${Math.round((noRecording / tracks.length) * 100)}%)`);
  console.log(`Recording but no work: ${noWork} (${Math.round((noWork / tracks.length) * 100)}%)`);
  console.log(`Errors: ${errors}`);
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
