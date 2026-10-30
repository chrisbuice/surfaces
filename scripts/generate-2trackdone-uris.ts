#!/usr/bin/env npx tsx
/**
 * generate-2trackdone-uris.ts — Generate URI list for the eager lyric-analysis batch.
 *
 * Finds tracks with ≥2 reason_end='trackdone' plays that have lyrics available
 * but no analysis yet. Writes one URI per line to scripts/data/2trackdone-uris.csv.
 *
 * Usage:
 *   npx tsx scripts/generate-2trackdone-uris.ts
 */

import { execSync } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";

const DB_NAME = "spotify-agent-db";
const OUTPUT_PATH = join(__dirname, "data", "2trackdone-uris.csv");

function execD1Query(sql: string): any[] {
  const escaped = sql.replace(/"/g, '\\"');
  const result = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command="${escaped}" 2>/dev/null`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = JSON.parse(result);
  return parsed[0]?.results ?? [];
}

async function main() {
  console.log("Querying for URIs with ≥2 trackdone plays, lyrics available, no analysis...");

  const rows = execD1Query(`
    SELECT l.spotify_track_uri
    FROM track_lyrics l
    LEFT JOIN track_lyric_analysis_status s
      ON s.spotify_track_uri = l.spotify_track_uri
    JOIN (
      SELECT spotify_track_uri
      FROM plays
      WHERE reason_end = 'trackdone'
      GROUP BY spotify_track_uri
      HAVING COUNT(*) >= 2
    ) p ON p.spotify_track_uri = l.spotify_track_uri
    WHERE l.status = 'ok'
      AND l.lyrics_plain IS NOT NULL
      AND s.spotify_track_uri IS NULL
  `);

  if (rows.length === 0) {
    console.log("No tracks found — nothing to do.");
    return;
  }

  const uris = rows.map((r: any) => r.spotify_track_uri);
  writeFileSync(OUTPUT_PATH, uris.join("\n") + "\n");

  console.log(`\nWrote ${uris.length} URIs to ${OUTPUT_PATH}`);
  console.log(`\nSanity check — first 5:`);
  for (const uri of uris.slice(0, 5)) {
    console.log(`  ${uri}`);
  }
  console.log(`\nReady for eager batch submission.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
