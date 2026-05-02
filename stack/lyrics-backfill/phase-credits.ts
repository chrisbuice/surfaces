/**
 * phase-credits.ts — Populate track_credits + track_credits_status from MusicBrainz.
 *
 * Uses the D1 HTTP API (not wrangler). No Spotify calls needed.
 * Restart-safe: skips URIs already in track_credits_status.
 * Paces at 1 req/sec hard (enforced by MusicBrainzClient). Each track takes
 * 2-3 requests, so expect ~2-3 sec/track. Full run for 47K tracks ≈ 26-28 hours.
 */

import { queryD1, writeD1 } from "./lib/d1.js";
import { MusicBrainzClient } from "./lib/musicbrainz.js";

const PROGRESS_INTERVAL = 50;
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
  isrc: string | null;
}

async function lookupWithRetry(
  client: MusicBrainzClient,
  track: TrackToFetch,
): Promise<Awaited<ReturnType<MusicBrainzClient["lookupCredits"]>>> {
  const cleanedArtist = cleanArtist(track.artist_name);

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await client.lookupCredits({
        isrc: track.isrc ?? undefined,
        trackName: track.track_name,
        artistName: cleanedArtist,
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("429") || msg.includes("503") || msg.toLowerCase().includes("rate")) {
        if (attempt === MAX_RETRIES) throw err;
        const waitMs = BASE_DELAY_MS * Math.pow(2, attempt);
        console.log(`  MusicBrainz ${msg.includes("503") ? "503" : "429"} — waiting ${Math.round(waitMs / 1000)}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
        await sleep(waitMs);
        continue;
      }
      throw err;
    }
  }

  throw new Error("Unreachable");
}

async function main() {
  console.log("=== Credits Backfill (grimmauldplace) ===\n");

  console.log("Querying for tracks needing credits...");
  const tracks = await queryD1<TrackToFetch>(
    "SELECT p.spotify_track_uri, p.track_name, p.artist_name, c.isrc FROM (SELECT DISTINCT spotify_track_uri, track_name, artist_name FROM plays) p LEFT JOIN track_isrc_cache c ON c.spotify_track_uri = p.spotify_track_uri LEFT JOIN track_credits_status s ON s.spotify_track_uri = p.spotify_track_uri WHERE s.spotify_track_uri IS NULL ORDER BY p.spotify_track_uri",
  );

  const toProcess = tracks.slice(0, limit);
  console.log(`Found ${tracks.length} tracks needing credits. Processing ${toProcess.length}.\n`);

  if (toProcess.length === 0) {
    console.log("Nothing to do — all tracks have credits status.");
    return;
  }

  const client = new MusicBrainzClient();
  const startTime = Math.floor(Date.now() / 1000);
  const now = startTime;

  let okCount = 0;
  let noRecording = 0;
  let noWork = 0;
  let errors = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const track = toProcess[i];

    try {
      const result = await lookupWithRetry(client, track);

      // Build the status SQL
      const statusSql = `INSERT OR REPLACE INTO track_credits_status (spotify_track_uri, isrc, mb_recording_id, mb_work_id, status, fetched_at, attempts) VALUES ('${escapeSQL(track.spotify_track_uri)}', ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, ${result.mbRecordingId ? `'${escapeSQL(result.mbRecordingId)}'` : "NULL"}, ${result.mbWorkId ? `'${escapeSQL(result.mbWorkId)}'` : "NULL"}, '${result.status}', ${now}, 1);`;

      // Build credits rows if we got them
      let creditsSql = "";
      if (result.credits.length > 0) {
        const values = result.credits.map(
          (c) =>
            `('${escapeSQL(track.spotify_track_uri)}', '${escapeSQL(c.personName)}', '${c.role}', ${c.roleRaw ? `'${escapeSQL(c.roleRaw)}'` : "NULL"}, 'musicbrainz', '${escapeSQL(c.mbArtistId)}', ${result.mbWorkId ? `'${escapeSQL(result.mbWorkId)}'` : "NULL"}, ${result.mbRecordingId ? `'${escapeSQL(result.mbRecordingId)}'` : "NULL"}, ${now})`,
        );
        creditsSql = `\nINSERT INTO track_credits (spotify_track_uri, person_name, role, role_raw, source, mb_artist_id, mb_work_id, mb_recording_id, fetched_at) VALUES\n${values.join(",\n")};`;
      }

      await writeD1(statusSql + creditsSql);

      switch (result.status) {
        case "ok":
          okCount++;
          break;
        case "no_recording":
          noRecording++;
          break;
        case "no_work":
          noWork++;
          break;
        case "error":
          errors++;
          break;
      }
    } catch (err) {
      // Write error status so we don't retry immediately
      try {
        await writeD1(
          `INSERT OR REPLACE INTO track_credits_status (spotify_track_uri, isrc, mb_recording_id, mb_work_id, status, fetched_at, attempts) VALUES ('${escapeSQL(track.spotify_track_uri)}', ${track.isrc ? `'${escapeSQL(track.isrc)}'` : "NULL"}, NULL, NULL, 'error', ${now}, 1);`,
        );
      } catch {
        /* best effort */
      }
      errors++;
      if (errors <= 5) {
        console.log(`  Error on "${track.track_name}": ${(err as Error).message}`);
      }
    }

    // Progress report
    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === toProcess.length - 1) {
      const pct = Math.round(((i + 1) / toProcess.length) * 100);
      const elapsed = Math.floor(Date.now() / 1000) - startTime;
      const rate = elapsed > 0 ? ((i + 1) / elapsed).toFixed(1) : "∞";
      console.log(
        `  [${pct}%] ${i + 1}/${toProcess.length} — ok:${okCount} no_recording:${noRecording} no_work:${noWork} error:${errors} (${rate} tracks/sec)`,
      );
    }
  }

  console.log("\n=== Credits Backfill Complete ===");
  console.log(`Total processed: ${toProcess.length}`);
  console.log(`With credits (ok): ${okCount} (${Math.round((okCount / toProcess.length) * 100)}%)`);
  console.log(`No recording found: ${noRecording} (${Math.round((noRecording / toProcess.length) * 100)}%)`);
  console.log(`Recording but no work: ${noWork} (${Math.round((noWork / toProcess.length) * 100)}%)`);
  console.log(`Errors: ${errors}`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
