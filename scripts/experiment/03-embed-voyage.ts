/**
 * 03-embed-voyage.ts
 *
 * Embeds lyrics_plain and analysis text for all analyzed songs using Voyage-3.5-lite.
 * Outputs Float32Array BLOBs to the embeddings/ directory.
 *
 * Usage: npx tsx 03-embed-voyage.ts [--input=analyses.jsonl]
 * Requires: VOYAGE_API_KEY, CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID in .env
 *
 * Output: embeddings/lyrics-{track_id}.bin, embeddings/analysis-{track_id}.bin
 *         (Float32Array, 1024 dims × 4 bytes = 4KB each for voyage-3.5-lite)
 */

import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname!, ".env") });

// ─── Config ───────────────────────────────────────────────────────────────────
const EXPERIMENT_DIR = resolve(
  import.meta.dirname!,
  "../../docs/experiments/lyric-analysis-2026-05"
);
const EMBEDDINGS_DIR = resolve(EXPERIMENT_DIR, "embeddings");
const VOYAGE_BATCH_SIZE = 128; // Voyage API max per call
const VOYAGE_MODEL = "voyage-3.5-lite";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function pick(obj: any, ...paths: string[]): any {
  for (const path of paths) {
    const v = path.split(".").reduce((a: any, k: string) => a?.[k], obj);
    if (v !== undefined) return v;
  }
  return undefined;
}

function uriToId(uri: string): string {
  return uri.replace("spotify:track:", "");
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
    throw new Error(
      "Missing env: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID"
    );
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

// ─── Voyage API ───────────────────────────────────────────────────────────────
interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Missing VOYAGE_API_KEY in .env");

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: VOYAGE_MODEL,
      input: texts,
      input_type: "document",
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voyage API ${res.status}: ${text}`);
  }

  const resp = (await res.json()) as VoyageResponse;
  return resp.data.map((d) => d.embedding);
}

// ─── Build analysis text for embedding ────────────────────────────────────────
function buildAnalysisText(analysis: any): string {
  const subject = pick(analysis, "subject_paragraph") || "";
  const tones = pick(analysis, "tones");
  const tonesStr = Array.isArray(tones) ? tones.join(" ") : "";
  const emotion =
    pick(analysis, "listener_feel_generic.primary_emotion", "primary_emotion") ||
    "";
  return `${subject} ${tonesStr} ${emotion}`.trim();
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const inputArg = args.find((a) => a.startsWith("--input="));
  const inputFile = inputArg
    ? inputArg.slice("--input=".length)
    : "analyses.jsonl";
  const inputPath = resolve(EXPERIMENT_DIR, inputFile);

  if (!existsSync(inputPath)) {
    console.error(`Input not found: ${inputPath}`);
    console.error("Run 02-analyze-sonnet.ts --poll=... first to download results.");
    process.exit(1);
  }

  // Ensure embeddings dir exists
  if (!existsSync(EMBEDDINGS_DIR)) {
    mkdirSync(EMBEDDINGS_DIR, { recursive: true });
  }

  // Load analyses
  const lines = readFileSync(inputPath, "utf-8").trim().split("\n");
  const analyses: Array<{ uri: string; analysis: any }> = [];
  for (const line of lines) {
    const item = JSON.parse(line);
    if (item.error) continue; // skip failed analyses
    analyses.push({ uri: item.spotify_track_uri, analysis: item.analysis });
  }
  console.log(`Loaded ${analyses.length} analyses from ${inputFile}`);

  // Check which already have embeddings (skip if re-running)
  const todo = analyses.filter((a) => {
    const id = uriToId(a.uri);
    return (
      !existsSync(resolve(EMBEDDINGS_DIR, `analysis-${id}.bin`)) ||
      !existsSync(resolve(EMBEDDINGS_DIR, `lyrics-${id}.bin`))
    );
  });
  console.log(`${todo.length} songs need embeddings (${analyses.length - todo.length} already done)`);

  if (todo.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Fetch lyrics from D1 for the songs we need
  console.log("Fetching lyrics from D1...");
  const uris = todo.map((t) => t.uri);
  const lyricsMap = new Map<string, string>();
  for (let i = 0; i < uris.length; i += 50) {
    const chunk = uris.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await queryD1<{ spotify_track_uri: string; lyrics_plain: string }>(
      `SELECT spotify_track_uri, lyrics_plain FROM track_lyrics WHERE spotify_track_uri IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      if (row.lyrics_plain) lyricsMap.set(row.spotify_track_uri, row.lyrics_plain);
    }
  }
  console.log(`  Got lyrics for ${lyricsMap.size}/${todo.length} songs`);

  // Build text pairs: [analysisText, lyricsText] for each song
  interface EmbedJob {
    uri: string;
    analysisText: string;
    lyricsText: string;
  }

  const jobs: EmbedJob[] = [];
  for (const item of todo) {
    const lyrics = lyricsMap.get(item.uri);
    if (!lyrics) {
      console.warn(`  Skipping ${item.uri}: no lyrics found`);
      continue;
    }
    const analysisText = buildAnalysisText(item.analysis);
    if (!analysisText) {
      console.warn(`  Skipping ${item.uri}: empty analysis text`);
      continue;
    }
    jobs.push({ uri: item.uri, analysisText, lyricsText: lyrics });
  }
  console.log(`\nEmbedding ${jobs.length} songs...`);

  // Embed analysis texts in batches
  console.log("  Embedding analysis texts...");
  const analysisEmbeddings: number[][] = [];
  for (let i = 0; i < jobs.length; i += VOYAGE_BATCH_SIZE) {
    const batch = jobs.slice(i, i + VOYAGE_BATCH_SIZE);
    const texts = batch.map((j) => j.analysisText);
    const embeddings = await embedBatch(texts);
    analysisEmbeddings.push(...embeddings);
    console.log(
      `    ${Math.min(i + VOYAGE_BATCH_SIZE, jobs.length)}/${jobs.length}`
    );
  }

  // Embed lyrics texts in batches
  console.log("  Embedding lyrics texts...");
  const lyricsEmbeddings: number[][] = [];
  for (let i = 0; i < jobs.length; i += VOYAGE_BATCH_SIZE) {
    const batch = jobs.slice(i, i + VOYAGE_BATCH_SIZE);
    // Truncate lyrics to ~8000 chars to stay within Voyage token limits
    const texts = batch.map((j) => j.lyricsText.slice(0, 8000));
    const embeddings = await embedBatch(texts);
    lyricsEmbeddings.push(...embeddings);
    console.log(
      `    ${Math.min(i + VOYAGE_BATCH_SIZE, jobs.length)}/${jobs.length}`
    );
  }

  // Write to disk as Float32Array BLOBs
  console.log("  Writing embeddings to disk...");
  let written = 0;
  for (let i = 0; i < jobs.length; i++) {
    const id = uriToId(jobs[i].uri);

    const analysisBuf = Buffer.from(new Float32Array(analysisEmbeddings[i]).buffer);
    writeFileSync(resolve(EMBEDDINGS_DIR, `analysis-${id}.bin`), analysisBuf);

    const lyricsBuf = Buffer.from(new Float32Array(lyricsEmbeddings[i]).buffer);
    writeFileSync(resolve(EMBEDDINGS_DIR, `lyrics-${id}.bin`), lyricsBuf);

    written++;
  }

  console.log(`\nDone! Wrote ${written} × 2 embedding files to ${EMBEDDINGS_DIR}`);
  console.log(
    `  Dimensions: ${analysisEmbeddings[0]?.length || "?"} (${VOYAGE_MODEL})`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
