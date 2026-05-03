/**
 * 00-pick-candidates.ts
 *
 * Pulls 200 barely-heard tracks from D1 (1–3 plays, last heard >1yr ago)
 * with lyrics available. Stratified ~1/3 each at 1, 2, 3 plays.
 * Uses a fixed RNG seed for reproducibility.
 *
 * Usage: npx tsx 00-pick-candidates.ts
 * Requires: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID in .env
 *
 * Output: ../../docs/experiments/lyric-analysis-2026-05/candidates.json
 */

import { config } from "dotenv";
import { writeFileSync } from "fs";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname!, ".env") });

// ─── Config ───────────────────────────────────────────────────────────────────
const RNG_SEED = 20260503; // Fixed seed for reproducibility
const TARGET_PER_BUCKET = 67; // ~200 total across 3 buckets
const CUTOFF_TS = Math.floor(new Date("2025-05-01").getTime() / 1000); // >1yr ago

const OUTPUT_PATH = resolve(
  import.meta.dirname!,
  "../../docs/experiments/lyric-analysis-2026-05/candidates.json"
);

// ─── Seeded RNG (mulberry32) ──────────────────────────────────────────────────
function mulberry32(seed: number) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─── D1 query ─────────────────────────────────────────────────────────────────
interface D1Response {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: Array<{
    success: boolean;
    results: Record<string, unknown>[];
  }>;
}

async function queryD1<T = Record<string, unknown>>(
  sql: string,
  params: (string | number | null)[] = []
): Promise<T[]> {
  const token = process.env.CF_API_TOKEN;
  const accountId = process.env.CF_ACCOUNT_ID;
  const databaseId = process.env.CF_D1_DATABASE_ID;
  if (!token || !accountId || !databaseId) {
    throw new Error("Missing env: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID");
  }

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`D1 HTTP ${res.status}: ${text}`);
  }

  const resp = (await res.json()) as D1Response;
  if (!resp.success || !resp.result?.[0]?.success) {
    throw new Error(`D1 query failed: ${JSON.stringify(resp.errors)}`);
  }
  return resp.result[0].results as T[];
}

// ─── Main ─────────────────────────────────────────────────────────────────────
interface Candidate {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  play_count: number;
  last_played: number;
  last_played_year: number;
  era_bucket: string;
}

function eraBucket(ts: number): string {
  const year = new Date(ts * 1000).getFullYear();
  if (year < 2011) return "pre-2011";
  if (year <= 2015) return "2011-2015";
  if (year <= 2020) return "2016-2020";
  return "2021-2025";
}

async function pullBucket(playCount: number): Promise<Candidate[]> {
  console.log(`  Querying play_count=${playCount}...`);
  const rows = await queryD1<{
    spotify_track_uri: string;
    track_name: string;
    artist_name: string;
    pc: number;
    lp: number;
  }>(
    `SELECT tl.spotify_track_uri, tl.track_name, tl.artist_name, sub.pc, sub.lp
     FROM track_lyrics tl
     INNER JOIN (
       SELECT spotify_track_uri, COUNT(*) as pc, MAX(ts) as lp
       FROM plays
       WHERE spotify_track_uri IS NOT NULL
       GROUP BY spotify_track_uri
       HAVING pc = ? AND lp < ?
     ) sub ON tl.spotify_track_uri = sub.spotify_track_uri
     WHERE tl.status = 'ok' AND tl.instrumental = 0 AND tl.lyrics_length > 100`,
    [playCount, CUTOFF_TS]
  );

  console.log(`    Found ${rows.length} tracks`);
  return rows.map((r) => ({
    spotify_track_uri: r.spotify_track_uri,
    track_name: r.track_name,
    artist_name: r.artist_name,
    play_count: r.pc,
    last_played: r.lp,
    last_played_year: new Date(r.lp * 1000).getFullYear(),
    era_bucket: eraBucket(r.lp),
  }));
}

async function main() {
  console.log("Pulling candidates from D1...");
  const rng = mulberry32(RNG_SEED);

  // Pull all candidates per bucket
  const bucket1 = await pullBucket(1);
  const bucket2 = await pullBucket(2);
  const bucket3 = await pullBucket(3);

  // Shuffle each bucket with seeded RNG, then take TARGET_PER_BUCKET
  const selected1 = shuffle(bucket1, rng).slice(0, TARGET_PER_BUCKET);
  const selected2 = shuffle(bucket2, rng).slice(0, TARGET_PER_BUCKET);
  const selected3 = shuffle(bucket3, rng).slice(0, TARGET_PER_BUCKET);

  // Trim to exactly 200 (67 + 67 + 66)
  const allSelected = [...selected1, ...selected2, ...selected3.slice(0, 66)];

  // Final shuffle for presentation order
  const candidates = shuffle(allSelected, rng);

  // Compute era distribution
  const eraDistribution: Record<string, number> = {};
  for (const c of candidates) {
    eraDistribution[c.era_bucket] = (eraDistribution[c.era_bucket] || 0) + 1;
  }

  const output = {
    description:
      "200 barely-heard tracks (1-3 plays, last heard >1yr ago) for blind rating experiment",
    selection_method:
      "Stratified ~1/3 each at play_count 1, 2, 3. Filtered to track_lyrics.status='ok', non-instrumental, lyrics_length > 100. Shuffled with seeded RNG.",
    rng_seed: RNG_SEED,
    cutoff_date: "2025-05-01",
    generated_at: new Date().toISOString(),
    stats: {
      total: candidates.length,
      by_play_count: {
        "1": selected1.length,
        "2": selected2.length,
        "3": allSelected.length - selected1.length - selected2.length,
      },
      by_era: eraDistribution,
    },
    candidates: candidates.map(({ spotify_track_uri, track_name, artist_name, play_count, last_played, era_bucket }) => ({
      spotify_track_uri,
      track_name,
      artist_name,
      play_count,
      last_played,
      era_bucket,
    })),
  };

  writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2) + "\n");
  console.log(`\nWrote ${candidates.length} candidates to ${OUTPUT_PATH}`);
  console.log(`  By play count: 1=${selected1.length}, 2=${selected2.length}, 3=${allSelected.length - selected1.length - selected2.length}`);
  console.log(`  By era: ${JSON.stringify(eraDistribution)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
