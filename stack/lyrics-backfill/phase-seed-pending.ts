/**
 * phase-seed-pending.ts — Seed `pending` rows in track_lyric_analysis_status
 * for tracks meeting the ≥2-trackdone threshold that don't yet have analysis.
 *
 * Idempotent: INSERT OR IGNORE skips URIs that already have a status row.
 *
 * Usage:
 *   tsx main.ts seed-pending [--limit N] [--dry-run]
 */

import { queryD1, writeD1 } from "./lib/d1.js";

const args = process.argv.slice(3); // skip "node main.ts seed-pending"
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 30;
const dryRun = args.includes("--dry-run");

interface UriRow {
  spotify_track_uri: string;
}

interface StatusCount {
  status: string;
  cnt: number;
}

const SEED_QUERY = `
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
LIMIT ?;
`;

const INSERT_PENDING = `
INSERT OR IGNORE INTO track_lyric_analysis_status
  (spotify_track_uri, status, last_attempted_at, attempts)
VALUES (?, 'pending', ?, 0);
`;

const STATUS_COUNTS_QUERY = `
SELECT status, COUNT(*) as cnt
FROM track_lyric_analysis_status
GROUP BY status;
`;

async function main() {
  console.log(`seed-pending: querying for tracks with ≥2 trackdone, no analysis status...`);

  const candidates = await queryD1<UriRow>(SEED_QUERY, [limit]);
  console.log(`seed-pending: found ${candidates.length} tracks meeting threshold without analysis`);

  if (candidates.length === 0) {
    console.log(`seed-pending: nothing to do.`);
    return;
  }

  if (dryRun) {
    console.log(`seed-pending: --dry-run, no writes`);
    return;
  }

  console.log(`seed-pending: inserting ${candidates.length} pending rows...`);

  const now = Math.floor(Date.now() / 1000);
  let inserted = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < candidates.length; i++) {
    const uri = candidates[i].spotify_track_uri;
    try {
      await writeD1(INSERT_PENDING, [uri, now]);
      inserted++;
    } catch (err: any) {
      // Defensive: INSERT OR IGNORE shouldn't raise UNIQUE, but handle it if D1 does
      if (err?.message?.includes("UNIQUE constraint")) {
        skipped++;
      } else {
        console.error(`  error inserting ${uri}: ${err?.message ?? err}`);
        errors++;
      }
    }

    if ((i + 1) % 10 === 0 || i === candidates.length - 1) {
      const pct = Math.round(((i + 1) / candidates.length) * 100);
      console.log(`  [${pct}%] ${i + 1}/${candidates.length} — inserted:${inserted} skipped:${skipped} errors:${errors}`);
    }
  }

  // Print final status counts
  const counts = await queryD1<StatusCount>(STATUS_COUNTS_QUERY, []);
  const summary = counts.map((r) => `${r.status}=${r.cnt}`).join(" ");
  console.log(`seed-pending: done. Status counts: ${summary}`);

  if (errors > 0) {
    console.error(`seed-pending: ${errors} error(s) encountered, exiting with code 1`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
