/**
 * phase-embed.ts — Generate Voyage embeddings for analyzed tracks.
 *
 * Reads from track_lyric_analysis + track_lyrics, calls Voyage-3.5-lite,
 * writes Float32Array BLOBs to track_lyric_embedding in D1.
 *
 * Modes:
 *   --limit N          Process at most N tracks
 *   --dry-run          Print what would be processed without calling the API
 *
 * Restart-safe: skips URIs already in track_lyric_embedding with both kinds.
 */

import { queryD1, batchWriteD1 } from "./lib/d1.js";

// ─── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(3);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(name);

const limit = getArg("--limit") ? parseInt(getArg("--limit")!, 10) : Infinity;
const dryRun = hasFlag("--dry-run");

// ─── Constants ──────────────────────────────────────────────────────────────
const VOYAGE_MODEL = "voyage-3.5-lite";
const VOYAGE_BATCH_SIZE = 128;
const LYRICS_TRUNCATE = 8000; // chars, stay within Voyage token limits
const PROGRESS_INTERVAL = 50;

// ─── Types ──────────────────────────────────────────────────────────────────
interface TrackNeedingEmbedding {
  spotify_track_uri: string;
  subject_paragraph: string;
  tones: string; // JSON array
  listener_feel_generic: string; // JSON object
  lyrics_plain: string;
}

interface VoyageResponse {
  data: Array<{ embedding: number[] }>;
  usage: { total_tokens: number };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildAnalysisText(track: TrackNeedingEmbedding): string {
  let tonesStr = "";
  try {
    const tones = JSON.parse(track.tones);
    if (Array.isArray(tones)) tonesStr = tones.join(" ");
  } catch { /* use empty */ }

  let emotion = "";
  try {
    const feel = JSON.parse(track.listener_feel_generic);
    emotion = feel?.primary_emotion || "";
  } catch { /* use empty */ }

  return `${track.subject_paragraph} ${tonesStr} ${emotion}`.trim();
}

// ─── Voyage API ─────────────────────────────────────────────────────────────
async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.VOYAGE_API_KEY;
  if (!apiKey) throw new Error("Missing env: VOYAGE_API_KEY");

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

  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    const waitMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : 5000;
    console.log(`  Voyage 429 — waiting ${Math.round(waitMs / 1000)}s`);
    await sleep(waitMs);
    return embedBatch(texts); // retry once
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Voyage API ${res.status}: ${text}`);
  }

  const resp = (await res.json()) as VoyageResponse;
  return resp.data.map((d) => d.embedding);
}

// ─── D1 writes ──────────────────────────────────────────────────────────────

async function writeEmbeddings(
  uri: string,
  lyricsVec: number[],
  analysisVec: number[],
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  // D1 HTTP API doesn't support raw BLOB bindings easily.
  // We use a hex-encoded x'' literal approach via raw SQL.
  const lyricsHex = Buffer.from(new Float32Array(lyricsVec).buffer).toString("hex");
  const analysisHex = Buffer.from(new Float32Array(analysisVec).buffer).toString("hex");

  await batchWriteD1([
    {
      sql: `INSERT OR REPLACE INTO track_lyric_embedding
        (spotify_track_uri, kind, vector, model, embedded_at)
        VALUES (?, 'lyrics', x'${lyricsHex}', ?, ?)`,
      params: [uri, VOYAGE_MODEL, now],
    },
    {
      sql: `INSERT OR REPLACE INTO track_lyric_embedding
        (spotify_track_uri, kind, vector, model, embedded_at)
        VALUES (?, 'analysis', x'${analysisHex}', ?, ?)`,
      params: [uri, VOYAGE_MODEL, now],
    },
  ]);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Lyrics Embedding (Voyage-3.5-lite) ===\n");

  // Find tracks with analysis but missing embeddings
  console.log("Querying for tracks needing embeddings...");

  const sql = `
    SELECT
      tla.spotify_track_uri,
      tla.subject_paragraph,
      tla.tones,
      tla.listener_feel_generic,
      tl.lyrics_plain
    FROM track_lyric_analysis tla
    JOIN track_lyric_analysis_status tas
      ON tla.spotify_track_uri = tas.spotify_track_uri
      AND tas.status = 'ok'
    JOIN track_lyrics tl
      ON tla.spotify_track_uri = tl.spotify_track_uri
      AND tl.status = 'ok'
    WHERE NOT EXISTS (
      SELECT 1 FROM track_lyric_embedding e
      WHERE e.spotify_track_uri = tla.spotify_track_uri
        AND e.kind = 'lyrics'
    )
    OR NOT EXISTS (
      SELECT 1 FROM track_lyric_embedding e
      WHERE e.spotify_track_uri = tla.spotify_track_uri
        AND e.kind = 'analysis'
    )
    ORDER BY tla.spotify_track_uri
  `;

  let tracks = await queryD1<TrackNeedingEmbedding>(sql);

  // Apply limit
  if (limit < tracks.length) {
    tracks = tracks.slice(0, limit);
  }

  console.log(`Found ${tracks.length} tracks needing embeddings\n`);

  if (tracks.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (dryRun) {
    console.log("DRY RUN — would embed:");
    for (const t of tracks.slice(0, 20)) {
      const preview = t.subject_paragraph.slice(0, 80);
      console.log(`  ${t.spotify_track_uri}  ${preview}...`);
    }
    if (tracks.length > 20) console.log(`  ... and ${tracks.length - 20} more`);
    return;
  }

  // Validate env
  if (!process.env.VOYAGE_API_KEY) {
    console.error("Missing env: VOYAGE_API_KEY");
    process.exit(1);
  }

  // Build texts for embedding
  interface EmbedJob {
    uri: string;
    analysisText: string;
    lyricsText: string;
  }

  const jobs: EmbedJob[] = [];
  for (const track of tracks) {
    const analysisText = buildAnalysisText(track);
    if (!analysisText) {
      console.warn(`  Skipping ${track.spotify_track_uri}: empty analysis text`);
      continue;
    }
    if (!track.lyrics_plain) {
      console.warn(`  Skipping ${track.spotify_track_uri}: no lyrics`);
      continue;
    }
    jobs.push({
      uri: track.spotify_track_uri,
      analysisText,
      lyricsText: track.lyrics_plain.slice(0, LYRICS_TRUNCATE),
    });
  }

  console.log(`Embedding ${jobs.length} tracks (2 vectors each)...\n`);

  const startTime = Date.now();
  let totalTokens = 0;

  // Process in Voyage batch-sized chunks
  for (let i = 0; i < jobs.length; i += VOYAGE_BATCH_SIZE) {
    const chunk = jobs.slice(i, i + VOYAGE_BATCH_SIZE);

    // Embed analysis texts
    const analysisTexts = chunk.map((j) => j.analysisText);
    const analysisEmbeddings = await embedBatch(analysisTexts);

    // Embed lyrics texts
    const lyricsTexts = chunk.map((j) => j.lyricsText);
    const lyricsEmbeddings = await embedBatch(lyricsTexts);

    // Write to D1
    for (let j = 0; j < chunk.length; j++) {
      await writeEmbeddings(
        chunk[j].uri,
        lyricsEmbeddings[j],
        analysisEmbeddings[j],
      );
    }

    const done = Math.min(i + VOYAGE_BATCH_SIZE, jobs.length);
    if (done % PROGRESS_INTERVAL === 0 || done === jobs.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      console.log(`  ${done}/${jobs.length} embedded — ${elapsed}s`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\nDone: ${jobs.length} tracks × 2 embeddings written to D1 in ${elapsed}s`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
