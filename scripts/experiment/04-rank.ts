/**
 * 04-rank.ts
 *
 * Computes three rankings of the 200 unheard candidates:
 *   1. lyric_rank — cosine(candidate analysis embedding, obsession centroid)
 *   2. existing_rank — taste_score from D1 (existing system's "you might like this")
 *   3. hybrid_rank — z-normalized average of both
 *
 * Usage: npx tsx 04-rank.ts
 * Requires: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID in .env
 *
 * Output: rankings.csv in the experiment directory
 */

import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname!, ".env") });

// ─── Paths ────────────────────────────────────────────────────────────────────
const EXPERIMENT_DIR = resolve(
  import.meta.dirname!,
  "../../docs/experiments/lyric-analysis-2026-05"
);
const EMBEDDINGS_DIR = resolve(EXPERIMENT_DIR, "embeddings");

// ─── Helpers ──────────────────────────────────────────────────────────────────
function uriToId(uri: string): string {
  return uri.replace("spotify:track:", "");
}

function loadEmbedding(filepath: string): Float32Array | null {
  if (!existsSync(filepath)) return null;
  const buf = readFileSync(filepath);
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

function centroid(embeddings: Float32Array[]): Float32Array {
  if (embeddings.length === 0) throw new Error("No embeddings for centroid");
  const dims = embeddings[0].length;
  const result = new Float32Array(dims);
  for (const emb of embeddings) {
    for (let i = 0; i < dims; i++) {
      result[i] += emb[i];
    }
  }
  for (let i = 0; i < dims; i++) {
    result[i] /= embeddings.length;
  }
  return result;
}

function zNormalize(values: number[]): number[] {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length
  );
  if (std === 0) return values.map(() => 0);
  return values.map((v) => (v - mean) / std);
}

function rankOrder(values: number[], descending = true): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => descending ? b.v - a.v : a.v - b.v);
  const ranks = new Array(values.length);
  for (let r = 0; r < indexed.length; r++) {
    ranks[indexed[r].i] = r + 1;
  }
  return ranks;
}

// ─── D1 query ─────────────────────────────────────────────────────────────────
interface D1Response {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: Array<{ success: boolean; results: Record<string, unknown>[] }>;
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
async function main() {
  // Load obsession seeds
  const seeds = JSON.parse(
    readFileSync(resolve(EXPERIMENT_DIR, "obsession-seeds.json"), "utf-8")
  );
  const seedUris: string[] = seeds.seeds.map((s: any) => s.spotify_track_uri);

  // Load candidates
  const candidatesData = JSON.parse(
    readFileSync(resolve(EXPERIMENT_DIR, "candidates.json"), "utf-8")
  );
  const candidateUris: string[] = candidatesData.candidates.map(
    (c: any) => c.spotify_track_uri
  );

  console.log(`Seeds: ${seedUris.length}, Candidates: ${candidateUris.length}`);

  // Load seed analysis embeddings and compute centroid
  console.log("Computing obsession centroid from seed embeddings...");
  const seedEmbeddings: Float32Array[] = [];
  let seedsMissing = 0;
  for (const uri of seedUris) {
    const emb = loadEmbedding(
      resolve(EMBEDDINGS_DIR, `analysis-${uriToId(uri)}.bin`)
    );
    if (emb) {
      seedEmbeddings.push(emb);
    } else {
      seedsMissing++;
    }
  }
  console.log(
    `  Loaded ${seedEmbeddings.length} seed embeddings (${seedsMissing} missing)`
  );
  const obsessionCentroid = centroid(seedEmbeddings);

  // Load candidate analysis embeddings and compute lyric similarity
  console.log("Computing lyric similarity for candidates...");
  interface CandidateScore {
    uri: string;
    lyricSim: number;
    tasteScore: number;
  }

  const scores: CandidateScore[] = [];
  let candidatesMissing = 0;
  for (const uri of candidateUris) {
    const emb = loadEmbedding(
      resolve(EMBEDDINGS_DIR, `analysis-${uriToId(uri)}.bin`)
    );
    if (!emb) {
      candidatesMissing++;
      continue;
    }
    const sim = cosine(emb, obsessionCentroid);
    scores.push({ uri, lyricSim: sim, tasteScore: 0 });
  }
  console.log(
    `  Scored ${scores.length} candidates (${candidatesMissing} missing embeddings)`
  );

  // Fetch artist-level taste as existing-system proxy.
  // These barely-heard tracks have no track_taste score (never scored by the model).
  // The existing system would rank candidates by primary artist affinity —
  // so we use artist_taste.taste_score looked up via the artist_name in track_lyrics.
  console.log("Fetching artist taste_scores from D1...");

  // Step 1: Get artist_name for each candidate from track_lyrics
  const uriToArtist = new Map<string, string>();
  for (let i = 0; i < scores.length; i += 50) {
    const chunk = scores.slice(i, i + 50).map((s) => s.uri);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await queryD1<{ spotify_track_uri: string; artist_name: string }>(
      `SELECT spotify_track_uri, artist_name FROM track_lyrics WHERE spotify_track_uri IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      if (row.artist_name) uriToArtist.set(row.spotify_track_uri, row.artist_name);
    }
  }

  // Step 2: For each unique artist_name, find their artist_id via plays+track_taste join,
  // then look up artist_taste. Do this in one query per batch.
  const uniqueArtists = [...new Set(uriToArtist.values())];
  const artistNameToScore = new Map<string, number>();

  for (let i = 0; i < uniqueArtists.length; i += 20) {
    const chunk = uniqueArtists.slice(i, i + 20);
    const placeholders = chunk.map(() => "?").join(",");
    // Join: plays.artist_name → track_taste (to get artist_ids JSON) → artist_taste
    const rows = await queryD1<{ artist_name: string; taste_score: number }>(
      `SELECT p.artist_name, MAX(at2.taste_score) as taste_score
       FROM plays p
       INNER JOIN track_taste tt ON tt.track_id = REPLACE(p.spotify_track_uri, 'spotify:track:', '')
       INNER JOIN json_each(tt.artist_ids) je ON 1=1
       INNER JOIN artist_taste at2 ON at2.artist_id = je.value
       WHERE p.artist_name IN (${placeholders})
       GROUP BY p.artist_name`,
      chunk
    );
    for (const row of rows) {
      artistNameToScore.set(row.artist_name, row.taste_score);
    }
  }

  // Fill in taste scores via artist_name lookup
  for (const s of scores) {
    const artistName = uriToArtist.get(s.uri);
    s.tasteScore = artistName ? (artistNameToScore.get(artistName) || 0) : 0;
  }
  const withTaste = scores.filter((s) => s.tasteScore > 0).length;
  console.log(`  ${withTaste}/${scores.length} have artist taste_score > 0`);

  // Compute rankings
  console.log("Computing rankings...");
  const lyricSims = scores.map((s) => s.lyricSim);
  const tasteScores = scores.map((s) => s.tasteScore);

  // Rank: highest similarity/score = rank 1
  const lyricRanks = rankOrder(lyricSims, true);
  const existingRanks = rankOrder(tasteScores, true);

  // Hybrid: z-normalize both scores, average, then rank
  const zLyric = zNormalize(lyricSims);
  const zTaste = zNormalize(tasteScores);
  const hybridScores = zLyric.map((zl, i) => (zl + zTaste[i]) / 2);
  const hybridRanks = rankOrder(hybridScores, true);

  // Write rankings.csv
  const csvLines = [
    "spotify_track_uri,lyric_sim,lyric_rank,taste_score,existing_rank,hybrid_score,hybrid_rank,blind_rating",
  ];
  for (let i = 0; i < scores.length; i++) {
    csvLines.push(
      [
        scores[i].uri,
        lyricSims[i].toFixed(6),
        lyricRanks[i],
        tasteScores[i].toFixed(2),
        existingRanks[i],
        hybridScores[i].toFixed(6),
        hybridRanks[i],
        "", // blind_rating filled in during Stage 3 listening
      ].join(",")
    );
  }

  const outputPath = resolve(EXPERIMENT_DIR, "rankings.csv");
  writeFileSync(outputPath, csvLines.join("\n") + "\n");
  console.log(`\nWrote ${scores.length} rankings to ${outputPath}`);

  // Summary stats
  const topLyric = scores[lyricRanks.indexOf(1)];
  const topExisting = scores[existingRanks.indexOf(1)];
  const topHybrid = scores[hybridRanks.indexOf(1)];
  console.log(`\nTop by lyric similarity: ${topLyric?.uri} (sim=${topLyric?.lyricSim.toFixed(4)})`);
  console.log(`Top by taste_score:      ${topExisting?.uri} (score=${topExisting?.tasteScore.toFixed(2)})`);
  console.log(`Top by hybrid:           ${topHybrid?.uri}`);

  // Show overlap between top-20s
  const lyricTop20 = new Set(
    scores
      .map((_, i) => ({ uri: scores[i].uri, rank: lyricRanks[i] }))
      .filter((x) => x.rank <= 20)
      .map((x) => x.uri)
  );
  const existingTop20 = new Set(
    scores
      .map((_, i) => ({ uri: scores[i].uri, rank: existingRanks[i] }))
      .filter((x) => x.rank <= 20)
      .map((x) => x.uri)
  );
  const overlap = [...lyricTop20].filter((u) => existingTop20.has(u));
  console.log(
    `\nTop-20 overlap (lyric ∩ existing): ${overlap.length}/20 — ${overlap.length === 0 ? "completely different signals!" : overlap.length < 5 ? "mostly different signals" : "significant overlap"}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
