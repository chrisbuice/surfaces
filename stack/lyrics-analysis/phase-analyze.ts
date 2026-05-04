/**
 * phase-analyze.ts — Run Sonnet lyric analysis on tracks in D1.
 *
 * Reads lyrics from track_lyrics (status='ok'), sends each to Claude Sonnet 4.6,
 * parses the structured JSON response, writes to track_lyric_analysis + _status.
 *
 * Modes:
 *   --limit N          Process at most N tracks
 *   --uris-file path   Only process URIs listed in this file (one per line, or CSV with uri in first column)
 *   --dry-run          Print what would be processed without calling the API
 *   --batch            Use Anthropic Message Batches API (for large runs)
 *
 * Default (no --batch): synchronous calls, good for validation runs of <200 tracks.
 * With --batch: submits to the Batches API for async processing (up to 10K per batch).
 *
 * Restart-safe: skips URIs already in track_lyric_analysis_status with status='ok'.
 */

import Anthropic from "@anthropic-ai/sdk";
import { queryD1, writeD1, batchWriteD1 } from "./lib/d1.js";
import { SYSTEM_PROMPT, MODEL_ID, ANALYSIS_VERSION, buildUserMessage } from "./prompt.js";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";

// ─── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(3);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
const hasFlag = (name: string) => args.includes(name);

const limit = getArg("--limit") ? parseInt(getArg("--limit")!, 10) : Infinity;
const urisFile = getArg("--uris-file");
const dryRun = hasFlag("--dry-run");
const useBatch = hasFlag("--batch");

// ─── Constants ──────────────────────────────────────────────────────────────
const PROGRESS_INTERVAL = 10;
const MAX_RETRIES = 3;
const THROTTLE_MS = 500; // ~2 req/sec for synchronous mode

// ─── Types ──────────────────────────────────────────────────────────────────
interface TrackWithLyrics {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  lyrics_plain: string;
  lyrics_length: number;
}

interface AnalysisResult {
  subject_paragraph: string;
  subject_tags: string[];
  listener_feel_generic: {
    valence: number;
    arousal: number;
    dominance: number;
    primary_emotion: string;
    secondary_emotions: string[];
    intensity: number;
    ambivalence: number;
  };
  tones: string[];
  language: string;
  narrative_pov: string;
  addressed_to: string;
  time_frame: string;
  story_arc: string;
  narrator_reliability: string;
  vocal_delivery_inferred: string[];
  tempo_feel: string;
  energy_curve: string;
  dynamic_range: string;
  vocab_level: string;
  slang_era: string[];
  references_json: {
    people: string[];
    places: string[];
    brands: string[];
    works: string[];
  };
  explicitness: number;
  content_flags: string[];
  quotability: number;
  rhyme_scheme: string;
  repetition_density: number;
  chorus_verse_balance: number;
  line_length_variance: number;
  has_bridge: boolean;
  structure_signature: string;
  lyric_intrusion: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function parseUrisFile(path: string): Set<string> {
  const content = readFileSync(path, "utf-8");
  const uris = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Handle CSV: take first column if it looks like a URI
    const first = trimmed.split(",")[0].trim();
    if (first.startsWith("spotify:track:")) {
      uris.add(first);
    }
  }
  return uris;
}

/** Validate the JSON response has the required shape. */
function validateAnalysis(obj: unknown): obj is AnalysisResult {
  if (typeof obj !== "object" || obj === null) return false;
  const a = obj as Record<string, unknown>;
  return (
    typeof a.subject_paragraph === "string" &&
    Array.isArray(a.subject_tags) &&
    typeof a.listener_feel_generic === "object" &&
    a.listener_feel_generic !== null &&
    Array.isArray(a.tones) &&
    typeof a.language === "string" &&
    typeof a.narrative_pov === "string"
  );
}

// ─── D1 writes ──────────────────────────────────────────────────────────────

/** Coerce undefined → null so D1 param bindings never receive undefined. */
function safeParams(params: unknown[]): (string | number | null)[] {
  return params.map(v => v === undefined ? null : v) as (string | number | null)[];
}

async function writeAnalysis(uri: string, analysis: AnalysisResult, lyricsHash: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);

  await batchWriteD1([
    {
      sql: `INSERT OR REPLACE INTO track_lyric_analysis (
        spotify_track_uri, subject_paragraph, subject_tags,
        listener_feel_generic, tones, language,
        narrative_pov, addressed_to, time_frame, story_arc, narrator_reliability,
        vocal_delivery_inferred, tempo_feel, energy_curve, dynamic_range,
        vocab_level, slang_era, references_json, explicitness, content_flags,
        quotability, rhyme_scheme, repetition_density, chorus_verse_balance,
        line_length_variance, has_bridge, structure_signature, lyric_intrusion,
        analyzed_at, analysis_version, model_id, lyrics_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: safeParams([
        uri,
        analysis.subject_paragraph,
        JSON.stringify(analysis.subject_tags),
        JSON.stringify(analysis.listener_feel_generic),
        JSON.stringify(analysis.tones),
        analysis.language,
        analysis.narrative_pov,
        analysis.addressed_to,
        analysis.time_frame,
        analysis.story_arc,
        analysis.narrator_reliability,
        JSON.stringify(analysis.vocal_delivery_inferred),
        analysis.tempo_feel,
        analysis.energy_curve,
        analysis.dynamic_range,
        analysis.vocab_level,
        JSON.stringify(analysis.slang_era),
        JSON.stringify(analysis.references_json),
        analysis.explicitness,
        JSON.stringify(analysis.content_flags),
        analysis.quotability,
        analysis.rhyme_scheme,
        analysis.repetition_density,
        analysis.chorus_verse_balance,
        analysis.line_length_variance,
        analysis.has_bridge ? 1 : 0,
        analysis.structure_signature,
        analysis.lyric_intrusion,
        now,
        ANALYSIS_VERSION,
        MODEL_ID,
        lyricsHash,
      ]),
    },
    {
      sql: `INSERT OR REPLACE INTO track_lyric_analysis_status (
        spotify_track_uri, status, last_attempted_at, attempts
      ) VALUES (?, 'ok', ?, 1)`,
      params: [uri, now],
    },
  ]);
}

async function writeError(uri: string, error: string, attempts: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await writeD1(
    `INSERT OR REPLACE INTO track_lyric_analysis_status (
      spotify_track_uri, status, last_attempted_at, attempts, last_error
    ) VALUES (?, 'parse_error', ?, ?, ?)`,
    [uri, now, attempts, error],
  );
}

// ─── Synchronous analysis (validation runs) ─────────────────────────────────
async function analyzeSynchronous(client: Anthropic, tracks: TrackWithLyrics[]): Promise<void> {
  const stats = { ok: 0, error: 0, skipped: 0 };
  const startTime = Date.now();

  for (let i = 0; i < tracks.length; i++) {
    const track = tracks[i];

    if ((i + 1) % PROGRESS_INTERVAL === 0 || i === 0) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
      const pct = ((i / tracks.length) * 100).toFixed(0);
      console.log(
        `  [${pct}%] ${i}/${tracks.length} — ok:${stats.ok} err:${stats.error} skip:${stats.skipped} — ${elapsed}s`,
      );
    }

    // Skip too-short lyrics
    if (track.lyrics_length < 50) {
      const now = Math.floor(Date.now() / 1000);
      await writeD1(
        `INSERT OR REPLACE INTO track_lyric_analysis_status (spotify_track_uri, status, last_attempted_at, attempts) VALUES (?, 'too_short', ?, 1)`,
        [track.spotify_track_uri, now],
      );
      stats.skipped++;
      continue;
    }

    const lyricsHash = sha256(track.lyrics_plain);
    let lastError = "";

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await client.messages.create({
          model: MODEL_ID,
          max_tokens: 2000,
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: buildUserMessage(track.track_name, track.artist_name, track.lyrics_plain),
            },
          ],
        });

        const text =
          response.content[0].type === "text" ? response.content[0].text : "";

        // Strip markdown fences if the model wraps the JSON
        const cleaned = text.replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
        const parsed = JSON.parse(cleaned);

        if (!validateAnalysis(parsed)) {
          throw new Error("Schema validation failed: missing required fields");
        }

        await writeAnalysis(track.spotify_track_uri, parsed, lyricsHash);
        stats.ok++;
        break;
      } catch (err) {
        lastError = (err as Error).message;
        if (attempt === MAX_RETRIES) {
          console.error(`  FAIL [${attempt}/${MAX_RETRIES}] ${track.track_name} — ${lastError.slice(0, 300)}`);
          await writeError(track.spotify_track_uri, lastError.slice(0, 500), attempt);
          stats.error++;
        } else {
          console.log(`  retry [${attempt}/${MAX_RETRIES}] ${track.track_name} — ${lastError.slice(0, 200)}`);
          await sleep(1000 * attempt);
        }
      }
    }

    await sleep(THROTTLE_MS);
  }

  console.log(`\nDone: ok=${stats.ok} error=${stats.error} skipped=${stats.skipped} total=${tracks.length}`);
}

// ─── Batch analysis (large runs via Anthropic Message Batches API) ──────────
async function analyzeBatch(client: Anthropic, tracks: TrackWithLyrics[]): Promise<void> {
  console.log(`Submitting ${tracks.length} tracks to Message Batches API...`);

  const BATCH_SIZE = 10_000; // Anthropic max per batch
  const chunks: TrackWithLyrics[][] = [];
  for (let i = 0; i < tracks.length; i += BATCH_SIZE) {
    chunks.push(tracks.slice(i, i + BATCH_SIZE));
  }

  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c];
    console.log(`\nBatch ${c + 1}/${chunks.length} (${chunk.length} tracks)`);

    const requests = chunk.map((track) => ({
      custom_id: track.spotify_track_uri,
      params: {
        model: MODEL_ID,
        max_tokens: 2000,
        system: [{ type: "text" as const, text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" as const } }],
        messages: [
          {
            role: "user" as const,
            content: buildUserMessage(track.track_name, track.artist_name, track.lyrics_plain),
          },
        ],
      },
    }));

    const batch = await client.messages.batches.create({ requests });
    console.log(`  Batch submitted: ${batch.id} — status: ${batch.processing_status}`);

    // Write batch ID to a host-mounted path so it survives container exit
    const batchLogPath = `/app/inputs/batch-${c + 1}-${batch.id}.json`;
    writeFileSync(
      batchLogPath,
      JSON.stringify({
        batch_id: batch.id,
        submitted_at: new Date().toISOString(),
        track_count: chunk.length,
        uris: chunk.map((t) => t.spotify_track_uri),
      }),
    );
    console.log(`  Batch log written to ${batchLogPath}`);

    // Poll for completion
    console.log(`  Polling for completion (may take up to 24h)...`);
    let status = batch.processing_status;
    let pollCount = 0;
    while (status === "in_progress") {
      const waitSec = Math.min(30 * Math.pow(1.5, Math.min(pollCount, 10)), 300);
      await sleep(waitSec * 1000);
      const updated = await client.messages.batches.retrieve(batch.id);
      status = updated.processing_status;
      pollCount++;
      const counts = updated.request_counts;
      console.log(
        `  [poll ${pollCount}] ${status} — succeeded:${counts.succeeded} errored:${counts.errored} processing:${counts.processing}`,
      );
    }

    if (status !== "ended") {
      console.error(`  Batch ${batch.id} ended with status: ${status}`);
      continue;
    }

    // Collect results
    console.log(`  Collecting results...`);
    const lyricsHashMap = new Map(chunk.map((t) => [t.spotify_track_uri, sha256(t.lyrics_plain)]));
    let ok = 0;
    let errors = 0;

    for await (const result of client.messages.batches.results(batch.id)) {
      const uri = result.custom_id;
      const hash = lyricsHashMap.get(uri) ?? "";

      if (result.result.type === "succeeded") {
        const msg = result.result.message;
        const text = msg.content[0].type === "text" ? msg.content[0].text : "";
        try {
          const cleaned = text.replace(/^```json\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim();
          const parsed = JSON.parse(cleaned);
          if (!validateAnalysis(parsed)) throw new Error("Schema validation failed");
          await writeAnalysis(uri, parsed, hash);
          ok++;
        } catch (err) {
          await writeError(uri, (err as Error).message.slice(0, 500), 1);
          errors++;
        }
      } else {
        await writeError(uri, `Batch result type: ${result.result.type}`, 1);
        errors++;
      }
    }

    console.log(`  Batch ${c + 1} results: ok=${ok} errors=${errors}`);
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Lyrics Analysis (Sonnet 4.6) ===\n");

  // Build URI filter if provided
  let uriFilter: Set<string> | null = null;
  if (urisFile) {
    uriFilter = parseUrisFile(urisFile);
    console.log(`URI filter: ${uriFilter.size} tracks from ${urisFile}`);
  }

  // Query tracks needing analysis
  console.log("Querying for tracks with lyrics that need analysis...");

  let sql: string;
  let params: (string | number | null)[] = [];

  if (uriFilter && uriFilter.size <= 200) {
    // Small filter: use IN clause
    const placeholders = Array.from(uriFilter).map(() => "?").join(",");
    sql = `
      SELECT tl.spotify_track_uri, tl.track_name, tl.artist_name, tl.lyrics_plain, tl.lyrics_length
      FROM track_lyrics tl
      LEFT JOIN track_lyric_analysis_status tas ON tl.spotify_track_uri = tas.spotify_track_uri
      WHERE tl.status = 'ok'
        AND tl.instrumental = 0
        AND (tas.status IS NULL OR tas.status IN ('parse_error', 'pending'))
        AND tl.spotify_track_uri IN (${placeholders})
      ORDER BY tl.spotify_track_uri
    `;
    params = Array.from(uriFilter);
  } else {
    sql = `
      SELECT tl.spotify_track_uri, tl.track_name, tl.artist_name, tl.lyrics_plain, tl.lyrics_length
      FROM track_lyrics tl
      LEFT JOIN track_lyric_analysis_status tas ON tl.spotify_track_uri = tas.spotify_track_uri
      WHERE tl.status = 'ok'
        AND tl.instrumental = 0
        AND tl.lyrics_length > 50
        AND (tas.status IS NULL OR tas.status IN ('parse_error', 'pending'))
      ORDER BY tl.spotify_track_uri
    `;
  }

  const tracks = await queryD1<TrackWithLyrics>(sql, params);

  // Apply URI filter for large filter sets (couldn't use IN clause)
  let filtered = tracks;
  if (uriFilter && uriFilter.size > 200) {
    filtered = tracks.filter((t) => uriFilter!.has(t.spotify_track_uri));
  }

  // Apply limit
  if (limit < filtered.length) {
    filtered = filtered.slice(0, limit);
  }

  console.log(`Found ${tracks.length} tracks needing analysis, processing ${filtered.length}\n`);

  if (filtered.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  if (dryRun) {
    console.log("DRY RUN — would process:");
    for (const t of filtered.slice(0, 20)) {
      console.log(`  ${t.spotify_track_uri}  ${t.artist_name} — ${t.track_name} (${t.lyrics_length} chars)`);
    }
    if (filtered.length > 20) console.log(`  ... and ${filtered.length - 20} more`);
    return;
  }

  // Initialize Anthropic client
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Missing env: ANTHROPIC_API_KEY");
    process.exit(1);
  }
  const client = new Anthropic({ apiKey });

  if (useBatch) {
    await analyzeBatch(client, filtered);
  } else {
    await analyzeSynchronous(client, filtered);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
