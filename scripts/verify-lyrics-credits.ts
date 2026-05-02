#!/usr/bin/env npx tsx
/**
 * verify-lyrics-credits.ts — Coverage report and spot-check for lyrics + credits backfill.
 *
 * Usage:
 *   npx tsx scripts/verify-lyrics-credits.ts
 *
 * Prints:
 * 1. Coverage stats (total URIs, with lyrics, with credits, percentages)
 * 2. Top 20 most-played tracks with lyrics/credits status
 * 3. Top 20 humans by play-weighted credit count
 * 4. 20 random tracks with lyrics (spot-check)
 * 5. 20 random tracks with credits (spot-check)
 */

import { execSync } from "child_process";

const DB_NAME = "spotify-agent-db";

function execD1Query(sql: string): any[] {
  const escaped = sql.replace(/"/g, '\\"');
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command="${escaped}" 2>/dev/null`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = JSON.parse(result);
  return parsed[0]?.results ?? [];
}

function printTable(rows: Record<string, any>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log("  (no results)");
    return;
  }
  const cols = columns ?? Object.keys(rows[0]);
  // Print header
  console.log("  " + cols.map(c => c.padEnd(25)).join(""));
  console.log("  " + cols.map(() => "─".repeat(25)).join(""));
  for (const row of rows) {
    const vals = cols.map(c => {
      const v = row[c];
      if (v == null) return "(null)".padEnd(25);
      const s = String(v);
      return (s.length > 24 ? s.slice(0, 22) + "…" : s).padEnd(25);
    });
    console.log("  " + vals.join(""));
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║       LYRICS & CREDITS VERIFICATION REPORT       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── 1. Coverage stats ──
  console.log("── 1. Coverage Stats ──\n");

  const totalUris = execD1Query("SELECT COUNT(DISTINCT spotify_track_uri) as cnt FROM plays");
  const lyricsOk = execD1Query("SELECT COUNT(*) as cnt FROM track_lyrics WHERE status = 'ok'");
  const lyricsInstrumental = execD1Query("SELECT COUNT(*) as cnt FROM track_lyrics WHERE instrumental = 1");
  const lyricsNotFound = execD1Query("SELECT COUNT(*) as cnt FROM track_lyrics WHERE status = 'not_found'");
  const lyricsError = execD1Query("SELECT COUNT(*) as cnt FROM track_lyrics WHERE status = 'error'");
  const creditsOk = execD1Query("SELECT COUNT(*) as cnt FROM track_credits_status WHERE status = 'ok'");
  const creditsNoRec = execD1Query("SELECT COUNT(*) as cnt FROM track_credits_status WHERE status = 'no_recording'");
  const creditsNoWork = execD1Query("SELECT COUNT(*) as cnt FROM track_credits_status WHERE status = 'no_work'");
  const creditsError = execD1Query("SELECT COUNT(*) as cnt FROM track_credits_status WHERE status = 'error'");
  const isrcCached = execD1Query("SELECT COUNT(*) as cnt FROM track_isrc_cache");
  const isrcWithValue = execD1Query("SELECT COUNT(*) as cnt FROM track_isrc_cache WHERE isrc IS NOT NULL");

  const total = totalUris[0]?.cnt ?? 0;
  const lyOk = lyricsOk[0]?.cnt ?? 0;
  const lyInst = lyricsInstrumental[0]?.cnt ?? 0;
  const lyNotFound = lyricsNotFound[0]?.cnt ?? 0;
  const lyErr = lyricsError[0]?.cnt ?? 0;
  const crOk = creditsOk[0]?.cnt ?? 0;
  const crNoRec = creditsNoRec[0]?.cnt ?? 0;
  const crNoWork = creditsNoWork[0]?.cnt ?? 0;
  const crErr = creditsError[0]?.cnt ?? 0;
  const isrcTotal = isrcCached[0]?.cnt ?? 0;
  const isrcHave = isrcWithValue[0]?.cnt ?? 0;

  console.log(`  Total unique URIs in plays: ${total}`);
  console.log(`  ISRC cache: ${isrcTotal} cached, ${isrcHave} with ISRC (${total > 0 ? Math.round((isrcHave / total) * 100) : 0}%)`);
  console.log("");
  console.log(`  Lyrics:`);
  console.log(`    ok (with lyrics):  ${lyOk} (${Math.round((lyOk / total) * 100)}%)`);
  console.log(`    instrumental:      ${lyInst} (${Math.round((lyInst / total) * 100)}%)`);
  console.log(`    not found:         ${lyNotFound} (${Math.round((lyNotFound / total) * 100)}%)`);
  console.log(`    error:             ${lyErr}`);
  console.log(`    not attempted:     ${total - lyOk - lyInst - lyNotFound - lyErr}`);
  console.log(`    coverage (ok+inst):${Math.round(((lyOk + lyInst) / total) * 100)}%`);
  console.log("");
  console.log(`  Credits:`);
  console.log(`    ok (with credits): ${crOk} (${Math.round((crOk / total) * 100)}%)`);
  console.log(`    no recording:      ${crNoRec} (${Math.round((crNoRec / total) * 100)}%)`);
  console.log(`    no work linked:    ${crNoWork} (${Math.round((crNoWork / total) * 100)}%)`);
  console.log(`    error:             ${crErr}`);
  console.log(`    not attempted:     ${total - crOk - crNoRec - crNoWork - crErr}`);
  console.log(`    coverage (ok):     ${Math.round((crOk / total) * 100)}%`);

  // ── 2. Top 20 most-played tracks with status ──
  console.log("\n── 2. Top 20 Most-Played Tracks ──\n");

  const topPlayed = execD1Query(
    "SELECT p.track_name, p.artist_name, p.plays, COALESCE(l.status, 'none') as lyrics, COALESCE(s.status, 'none') as credits FROM (SELECT spotify_track_uri, track_name, artist_name, COUNT(*) as plays FROM plays GROUP BY spotify_track_uri ORDER BY plays DESC LIMIT 20) p LEFT JOIN track_lyrics l ON l.spotify_track_uri = p.spotify_track_uri LEFT JOIN track_credits_status s ON s.spotify_track_uri = p.spotify_track_uri"
  );
  printTable(topPlayed, ["track_name", "artist_name", "plays", "lyrics", "credits"]);

  // ── 3. Top 20 humans by play-weighted credits ──
  console.log("\n── 3. Top 20 Writers/Producers by Play Count ──\n");

  const topHumans = execD1Query(
    "SELECT tc.person_name, tc.role, COUNT(*) as track_count, SUM(pc.plays) as total_plays FROM track_credits tc JOIN (SELECT spotify_track_uri, COUNT(*) as plays FROM plays GROUP BY spotify_track_uri) pc ON pc.spotify_track_uri = tc.spotify_track_uri GROUP BY tc.person_name, tc.role ORDER BY total_plays DESC LIMIT 20"
  );
  printTable(topHumans, ["person_name", "role", "track_count", "total_plays"]);

  // ── 4. 20 random tracks with lyrics (spot-check) ──
  console.log("\n── 4. Random Lyrics Spot-Check (20 tracks) ──\n");

  const randomLyrics = execD1Query(
    "SELECT track_name, artist_name, SUBSTR(lyrics_plain, 1, 200) as lyrics_preview FROM track_lyrics WHERE status = 'ok' AND lyrics_plain IS NOT NULL ORDER BY RANDOM() LIMIT 20"
  );
  for (const row of randomLyrics) {
    console.log(`  "${row.track_name}" by ${row.artist_name}`);
    console.log(`    ${(row.lyrics_preview ?? "").replace(/\n/g, " / ").slice(0, 150)}`);
    console.log("");
  }

  // ── 5. 20 random tracks with credits (spot-check) ──
  console.log("── 5. Random Credits Spot-Check (20 tracks) ──\n");

  const randomCredits = execD1Query(
    "SELECT p.track_name, p.artist_name, GROUP_CONCAT(tc.person_name || ' (' || tc.role || ')') as credits FROM (SELECT DISTINCT spotify_track_uri, track_name, artist_name FROM plays) p JOIN track_credits tc ON tc.spotify_track_uri = p.spotify_track_uri GROUP BY p.spotify_track_uri ORDER BY RANDOM() LIMIT 20"
  );
  for (const row of randomCredits) {
    console.log(`  "${row.track_name}" by ${row.artist_name}`);
    console.log(`    Credits: ${row.credits}`);
    console.log("");
  }
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
