#!/usr/bin/env npx tsx
/**
 * retry-apple-matches.ts — Monthly retry for unmatched/review Apple tracks.
 *
 * Re-runs the matching cascade (iTunes Lookup → MusicBrainz ISRC → Spotify)
 * for apple_track_matches rows that haven't been attempted in 30+ days.
 * This is the primary path for ISRC enrichment (see decisions doc D15).
 *
 * Usage:
 *   retry-apple-matches [--limit=N] [--dry-run] [--skip-musicbrainz]
 *
 * Env vars required:
 *   CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID  (D1 HTTP API)
 *   SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET          (Spotify client_credentials)
 *
 * Run from grimmauldplace via cron or systemd timer, monthly.
 */

import { parseArgs } from "node:util";
import { lookupTrack } from "./lib/itunes-lookup";
import { findIsrc } from "./lib/musicbrainz-isrc";
import { searchByIsrc, searchByText, type SpotifyMatchCandidate } from "./lib/spotify-matcher";
import { getSpotifyToken } from "./lib/spotify-auth";
import { queryD1, writeD1 } from "../stack/lyrics-backfill/lib/d1";

// ── CLI args ──

const { values: args } = parseArgs({
  options: {
    limit: { type: "string" },
    "dry-run": { type: "boolean", default: false },
    "skip-musicbrainz": { type: "boolean", default: false },
  },
});

const LIMIT = args.limit ? parseInt(args.limit, 10) : undefined;
const DRY_RUN = args["dry-run"] ?? false;
const SKIP_MB = args["skip-musicbrainz"] ?? false;

// ── Types ──

interface MatchRow {
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
  match_attempts: number;
  musicbrainz_attempts: number;
  musicbrainz_isrc: string | null;
  itunes_artist_name: string | null;
  itunes_track_name: string | null;
  itunes_album_name: string | null;
  itunes_duration_ms: number | null;
  itunes_release_date: string | null;
  itunes_genre: string | null;
  original_song_name: string;
  original_artist_name: string | null;
  original_album_name: string | null;
}

// ── Main ──

async function main() {
  console.log("Apple Match Retry");
  console.log("─────────────────────────");
  console.log(`  Dry run: ${DRY_RUN}`);
  console.log(`  Skip MusicBrainz: ${SKIP_MB}`);
  console.log(`  Limit: ${LIMIT ?? "none"}`);
  console.log();

  // Query eligible rows: unmatched or review, not attempted in 30+ days
  const limitClause = LIMIT ? `LIMIT ${LIMIT}` : "";
  const rows = await queryD1<MatchRow>(`
    SELECT * FROM apple_track_matches
    WHERE match_status IN ('unmatched', 'review')
      AND last_match_attempt_at < strftime('%s', 'now', '-30 days')
    ORDER BY last_match_attempt_at ASC
    ${limitClause}
  `);

  console.log(`Eligible rows: ${rows.length}`);
  if (rows.length === 0) {
    console.log("Nothing to retry.");
    return;
  }

  // Counters
  let retried = 0;
  let newlyMatchedIsrc = 0;
  let newlyMatchedText = 0;
  let stillReview = 0;
  let stillUnmatched = 0;
  let permanentlyUnmatched = 0;

  for (const row of rows) {
    retried++;
    let matched = false;

    // ── Stage 1: ISRC cascade ──
    // Only attempt if: MB not exhausted, no ISRC yet, have an apple_track_id,
    // and --skip-musicbrainz not set
    const mbAttemptsSoFar = row.musicbrainz_attempts ?? 0;
    const shouldTryMb = !SKIP_MB
      && mbAttemptsSoFar < 3
      && row.musicbrainz_isrc == null
      && row.apple_track_id != null;

    if (shouldTryMb) {
      // Use cached iTunes data if present, only call iTunes Lookup if
      // itunes_track_name is null (avoid duplicating work, not skipping)
      let itunesArtist = row.itunes_artist_name;
      let itunesTrack = row.itunes_track_name;
      let itunesAlbum = row.itunes_album_name;
      let itunesDuration = row.itunes_duration_ms;
      let itunesRelease = row.itunes_release_date;
      let itunesGenre = row.itunes_genre;

      if (!itunesTrack && row.apple_track_id) {
        const itunesData = await lookupTrack(row.apple_track_id);
        if (itunesData) {
          itunesArtist = itunesData.artistName;
          itunesTrack = itunesData.trackName;
          itunesAlbum = itunesData.collectionName;
          itunesDuration = itunesData.trackTimeMillis;
          itunesRelease = itunesData.releaseDate;
          itunesGenre = itunesData.primaryGenreName;

          // Cache the iTunes data for future retries
          if (!DRY_RUN) {
            await writeD1(`
              UPDATE apple_track_matches
              SET itunes_artist_name = ?, itunes_track_name = ?,
                  itunes_album_name = ?, itunes_duration_ms = ?,
                  itunes_release_date = ?, itunes_genre = ?
              WHERE cache_key = ?
            `, [itunesArtist, itunesTrack, itunesAlbum, itunesDuration,
                itunesRelease, itunesGenre, row.cache_key]);
          }
        }
      }

      // MusicBrainz ISRC search
      if (itunesArtist && itunesTrack) {
        const isrc = await findIsrc(itunesArtist, itunesTrack);

        if (!DRY_RUN) {
          // Increment musicbrainz_attempts regardless of outcome
          await writeD1(`
            UPDATE apple_track_matches
            SET musicbrainz_attempts = musicbrainz_attempts + 1
                ${isrc ? ", musicbrainz_isrc = ?" : ""}
            WHERE cache_key = ?
          `, isrc ? [isrc, row.cache_key] : [row.cache_key]);
        }

        if (isrc) {
          // ISRC short-circuit: Spotify ISRC search
          const token = await getSpotifyToken();
          const isrcMatch = await searchByIsrc(isrc, token);
          if (isrcMatch) {
            if (!DRY_RUN) {
              await applyMatch(row.cache_key, isrcMatch, "isrc", row.apple_track_id);
            }
            newlyMatchedIsrc++;
            matched = true;
            if (retried % 100 === 0) {
              console.log(`  [${retried}/${rows.length}] "${row.original_song_name}" → ISRC match`);
            }
          }
        }
      } else if (!DRY_RUN) {
        // No iTunes data to search with, still count the MB attempt
        await writeD1(`
          UPDATE apple_track_matches
          SET musicbrainz_attempts = musicbrainz_attempts + 1
          WHERE cache_key = ?
        `, [row.cache_key]);
      }
    }

    // ── Stage 2: Text match fallback ──
    if (!matched) {
      const trackName = row.itunes_track_name ?? row.original_song_name;
      const artistName = row.itunes_artist_name ?? (row.original_artist_name || "");
      const albumName = row.itunes_album_name ?? (row.original_album_name || null);
      const durationMs = row.itunes_duration_ms ?? null;

      const token = await getSpotifyToken();
      const candidates = await searchByText(trackName, artistName, albumName, durationMs, token);
      const best = candidates[0] ?? null;

      const newAttempts = row.match_attempts + 1;

      if (best && best.confidence >= 0.90) {
        if (!DRY_RUN) {
          await applyMatch(row.cache_key, best, "text", row.apple_track_id);
        }
        newlyMatchedText++;
        matched = true;
      } else if (best && best.confidence >= 0.70) {
        if (!DRY_RUN) {
          await updateAttempt(row.cache_key, "review", best, newAttempts);
        }
        stillReview++;
      } else {
        // Permanently unmatched only when BOTH counters exhausted:
        // match_attempts >= 3 AND musicbrainz_attempts >= 3
        const mbAttempts = shouldTryMb
          ? mbAttemptsSoFar + 1
          : mbAttemptsSoFar;
        const shouldPermanent = newAttempts >= 3 && mbAttempts >= 3;

        if (shouldPermanent) {
          if (!DRY_RUN) {
            await writeD1(`
              UPDATE apple_track_matches
              SET match_status = 'permanently_unmatched',
                  match_attempts = ?,
                  last_match_attempt_at = ?
              WHERE cache_key = ?
            `, [newAttempts, now(), row.cache_key]);
          }
          permanentlyUnmatched++;
        } else {
          if (!DRY_RUN) {
            await updateAttempt(row.cache_key, "unmatched", best, newAttempts);
          }
          stillUnmatched++;
        }
      }

      if (retried % 100 === 0 || retried === rows.length) {
        const status = matched ? "matched" : "pending";
        console.log(`  [${retried}/${rows.length}] "${row.original_song_name}" → ${status}`);
      }
    }
  }

  // ── Summary ──
  console.log();
  console.log("Apple Match Retry Summary");
  console.log("─────────────────────────");
  console.log(`  Eligible rows:          ${rows.length}`);
  console.log(`  Retried:                ${retried}`);
  console.log(`  Newly matched (ISRC):   ${newlyMatchedIsrc}`);
  console.log(`  Newly matched (text):   ${newlyMatchedText}`);
  console.log(`  Still review:           ${stillReview}`);
  console.log(`  Still unmatched:        ${stillUnmatched}`);
  console.log(`  Permanently unmatched:  ${permanentlyUnmatched}`);
  if (DRY_RUN) {
    console.log("  (dry run — no D1 writes performed)");
  }
}

// ── Helpers ──

function now(): number {
  return Math.floor(Date.now() / 1000);
}

async function applyMatch(
  cacheKey: string,
  candidate: SpotifyMatchCandidate,
  method: "isrc" | "text",
  appleTrackId: string | null,
): Promise<void> {
  const ts = now();

  // Update match cache
  await writeD1(`
    UPDATE apple_track_matches
    SET spotify_track_uri = ?,
        spotify_track_name = ?,
        spotify_artist_name = ?,
        spotify_album_name = ?,
        spotify_duration_ms = ?,
        match_confidence = ?,
        match_method = ?,
        match_status = 'matched',
        match_attempts = match_attempts + 1,
        last_match_attempt_at = ?
    WHERE cache_key = ?
  `, [
    candidate.spotifyTrackUri, candidate.trackName, candidate.artistName,
    candidate.albumName, candidate.durationMs, candidate.confidence,
    method, ts, cacheKey,
  ]);

  // Backfill affected plays rows
  if (appleTrackId) {
    await writeD1(`
      UPDATE plays
      SET track_name = ?,
          artist_name = ?,
          album_name = ?,
          spotify_track_uri = ?,
          match_confidence = ?,
          match_status = 'matched'
      WHERE source = 'apple' AND apple_track_id = ?
    `, [
      candidate.trackName, candidate.artistName, candidate.albumName,
      candidate.spotifyTrackUri, candidate.confidence, appleTrackId,
    ]);
  }
}

async function updateAttempt(
  cacheKey: string,
  status: string,
  best: SpotifyMatchCandidate | null,
  attempts: number,
): Promise<void> {
  const ts = now();

  if (best) {
    await writeD1(`
      UPDATE apple_track_matches
      SET spotify_track_uri = ?,
          spotify_track_name = ?,
          spotify_artist_name = ?,
          spotify_album_name = ?,
          spotify_duration_ms = ?,
          match_confidence = ?,
          match_method = 'text',
          match_status = ?,
          match_attempts = ?,
          last_match_attempt_at = ?
      WHERE cache_key = ?
    `, [
      best.spotifyTrackUri, best.trackName, best.artistName,
      best.albumName, best.durationMs, best.confidence,
      status, attempts, ts, cacheKey,
    ]);
  } else {
    await writeD1(`
      UPDATE apple_track_matches
      SET match_status = ?,
          match_attempts = ?,
          last_match_attempt_at = ?
      WHERE cache_key = ?
    `, [status, attempts, ts, cacheKey]);
  }
}

// ── Run ──

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
