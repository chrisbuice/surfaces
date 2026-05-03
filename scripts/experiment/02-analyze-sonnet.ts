/**
 * 02-analyze-sonnet.ts
 *
 * Submits songs to Claude Sonnet 4.6 via the Anthropic Message Batches API
 * using the locked v1 lyric analysis prompt.
 *
 * Usage:
 *   npx tsx 02-analyze-sonnet.ts --input=golden-set --output=analyses-stage1.jsonl
 *   npx tsx 02-analyze-sonnet.ts --input=all --output=analyses.jsonl
 *   npx tsx 02-analyze-sonnet.ts --poll=batch_id --output=analyses-stage1.jsonl
 *
 * --input=golden-set  → reads golden-set.json (30 songs, Stage 1)
 * --input=all         → reads candidates.json + obsession-seeds.json (250 songs, Stage 2)
 * --poll=batch_id     → polls an existing batch and downloads results
 *
 * Requires: ANTHROPIC_API_KEY in .env
 *           CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID in .env (for lyrics fetch)
 *
 * Output: JSONL file where each line is { spotify_track_uri, track_name, artist_name, analysis }
 *         Plus a -readable.md summary for spot-checking.
 */

import { config } from "dotenv";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";
import Anthropic from "@anthropic-ai/sdk";

config({ path: resolve(import.meta.dirname!, ".env") });

// ─── Paths ────────────────────────────────────────────────────────────────────
const EXPERIMENT_DIR = resolve(
  import.meta.dirname!,
  "../../docs/experiments/lyric-analysis-2026-05"
);
const PROMPT_PATH = resolve(EXPERIMENT_DIR, "prompts/lyric-analysis-v1.md");

// ─── Parse args ───────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  let input: "golden-set" | "all" | null = null;
  let output = "analyses-stage1.jsonl";
  let poll: string | null = null;

  for (const arg of args) {
    if (arg.startsWith("--input=")) {
      const val = arg.slice("--input=".length);
      if (val !== "golden-set" && val !== "all") {
        throw new Error(`--input must be 'golden-set' or 'all', got '${val}'`);
      }
      input = val;
    } else if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg.startsWith("--poll=")) {
      poll = arg.slice("--poll=".length);
    }
  }

  return { input, output, poll };
}

// ─── Load prompt ──────────────────────────────────────────────────────────────
function loadPrompt(): { system: string; userTemplate: string } {
  const raw = readFileSync(PROMPT_PATH, "utf-8");

  const sysMatch = raw.match(/## System Prompt\s*\n\s*```\n([\s\S]*?)\n```/);
  if (!sysMatch) throw new Error("Could not parse system prompt from v1.md");

  const userMatch = raw.match(
    /## User Message Template\s*\n\s*```\n([\s\S]*?)\n```/
  );
  if (!userMatch) throw new Error("Could not parse user template from v1.md");

  return { system: sysMatch[1].trim(), userTemplate: userMatch[1].trim() };
}

// ─── D1 query (for fetching lyrics) ──────────────────────────────────────────
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

// ─── Load input songs ─────────────────────────────────────────────────────────
interface Song {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
}

function loadSongs(input: "golden-set" | "all"): Song[] {
  if (input === "golden-set") {
    const data = JSON.parse(
      readFileSync(resolve(EXPERIMENT_DIR, "golden-set.json"), "utf-8")
    );
    return data.songs.map((s: any) => ({
      spotify_track_uri: s.spotify_track_uri,
      track_name: s.track_name,
      artist_name: s.artist_name,
    }));
  } else {
    const candidates = JSON.parse(
      readFileSync(resolve(EXPERIMENT_DIR, "candidates.json"), "utf-8")
    );
    const seeds = JSON.parse(
      readFileSync(resolve(EXPERIMENT_DIR, "obsession-seeds.json"), "utf-8")
    );
    return [
      ...candidates.candidates.map((c: any) => ({
        spotify_track_uri: c.spotify_track_uri,
        track_name: c.track_name,
        artist_name: c.artist_name,
      })),
      ...seeds.seeds.map((s: any) => ({
        spotify_track_uri: s.spotify_track_uri,
        track_name: s.track_name,
        artist_name: s.artist_name,
      })),
    ];
  }
}

// ─── Fetch lyrics from D1 ────────────────────────────────────────────────────
async function fetchLyrics(uris: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();

  // D1 has query size limits; batch in chunks of 50
  for (let i = 0; i < uris.length; i += 50) {
    const chunk = uris.slice(i, i + 50);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await queryD1<{
      spotify_track_uri: string;
      lyrics_plain: string;
    }>(
      `SELECT spotify_track_uri, lyrics_plain FROM track_lyrics WHERE spotify_track_uri IN (${placeholders})`,
      chunk
    );
    for (const row of rows) {
      if (row.lyrics_plain) {
        map.set(row.spotify_track_uri, row.lyrics_plain);
      }
    }
    if (i + 50 < uris.length) {
      console.log(`  Fetched lyrics: ${Math.min(i + 50, uris.length)}/${uris.length}`);
    }
  }

  return map;
}

// ─── Submit batch ─────────────────────────────────────────────────────────────
async function submitBatch(input: "golden-set" | "all", output: string) {
  const outputPath = resolve(EXPERIMENT_DIR, output);

  console.log(`Mode: submit`);
  console.log(`Input: ${input}`);
  console.log(`Output: ${outputPath}`);

  // Load prompt
  const { system, userTemplate } = loadPrompt();
  console.log(`System prompt: ${system.length} chars`);

  // Load songs
  const songs = loadSongs(input);
  console.log(`Songs to analyze: ${songs.length}`);

  // Fetch lyrics
  console.log("Fetching lyrics from D1...");
  const uris = songs.map((s) => s.spotify_track_uri);
  const lyricsMap = await fetchLyrics(uris);
  console.log(`  Got lyrics for ${lyricsMap.size}/${songs.length} songs`);

  // Filter to songs with lyrics
  const songsWithLyrics = songs.filter((s) =>
    lyricsMap.has(s.spotify_track_uri)
  );
  if (songsWithLyrics.length < songs.length) {
    const missing = songs.filter((s) => !lyricsMap.has(s.spotify_track_uri));
    console.warn(
      `  WARNING: ${missing.length} songs missing lyrics:`,
      missing.map((s) => `${s.artist_name} - ${s.track_name}`)
    );
  }

  // Build batch requests
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");

  const client = new Anthropic({ apiKey });

  const requests = songsWithLyrics.map((song) => {
    const lyrics = lyricsMap.get(song.spotify_track_uri)!;
    const userMessage = userTemplate
      .replace("{track_name}", song.track_name)
      .replace("{artist_name}", song.artist_name)
      .replace("{lyrics_plain}", lyrics);

    return {
      custom_id: song.spotify_track_uri,
      params: {
        model: "claude-sonnet-4-6-20250514" as const,
        max_tokens: 2048,
        system,
        messages: [{ role: "user" as const, content: userMessage }],
      },
    };
  });

  console.log(`\nSubmitting batch of ${requests.length} requests...`);
  const batch = await client.messages.batches.create({ requests });

  console.log(`Batch created: ${batch.id}`);
  console.log(`Status: ${batch.processing_status}`);
  console.log(`\nBatch submitted. It will complete within ~24 hours.`);
  console.log(
    `\nTo download results:\n  npx tsx 02-analyze-sonnet.ts --poll=${batch.id} --output=${output}`
  );

  // Track the batch
  const trackingPath = resolve(EXPERIMENT_DIR, ".batch-tracking.json");
  const tracking = existsSync(trackingPath)
    ? JSON.parse(readFileSync(trackingPath, "utf-8"))
    : {};
  tracking[output] = {
    batch_id: batch.id,
    submitted_at: new Date().toISOString(),
    song_count: requests.length,
    status: batch.processing_status,
  };
  writeFileSync(trackingPath, JSON.stringify(tracking, null, 2) + "\n");
}

// ─── Poll and download ────────────────────────────────────────────────────────
async function pollAndDownload(batchId: string, output: string) {
  const outputPath = resolve(EXPERIMENT_DIR, output);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");

  const client = new Anthropic({ apiKey });

  console.log(`Polling batch ${batchId}...`);
  const batch = await client.messages.batches.retrieve(batchId);
  console.log(`Status: ${batch.processing_status}`);
  console.log(`Counts: ${JSON.stringify(batch.request_counts)}`);

  if (batch.processing_status !== "ended") {
    console.log("\nBatch still processing. Try again later.");
    return;
  }

  // Download results
  console.log("\nBatch complete! Downloading results...");
  const results = await client.messages.batches.results(batchId);

  const lines: string[] = [];
  for await (const result of results) {
    if (result.result.type === "succeeded") {
      const content = result.result.message.content[0];
      if (content.type === "text") {
        try {
          const analysis = JSON.parse(content.text);
          lines.push(
            JSON.stringify({
              spotify_track_uri: result.custom_id,
              analysis,
            })
          );
        } catch (e) {
          console.warn(
            `  Parse error for ${result.custom_id}: ${(e as Error).message}`
          );
          lines.push(
            JSON.stringify({
              spotify_track_uri: result.custom_id,
              error: "parse_error",
              raw: content.text.slice(0, 500),
            })
          );
        }
      }
    } else {
      console.warn(`  Failed: ${result.custom_id} — ${result.result.type}`);
      lines.push(
        JSON.stringify({
          spotify_track_uri: result.custom_id,
          error: result.result.type,
        })
      );
    }
  }

  writeFileSync(outputPath, lines.join("\n") + "\n");
  console.log(`\nWrote ${lines.length} results to ${outputPath}`);

  // Write human-readable summary for spot-checking
  const summaryPath = outputPath.replace(".jsonl", "-readable.md");
  const summaryLines: string[] = [
    `# Lyric Analysis Results — ${output}\n`,
    `Batch: ${batchId}`,
    `Songs: ${lines.length}`,
    `Generated: ${new Date().toISOString()}\n`,
    `---\n`,
  ];

  for (const line of lines) {
    const item = JSON.parse(line);
    if (item.error) {
      summaryLines.push(
        `## ❌ ${item.spotify_track_uri}\n\nError: ${item.error}\n\n---\n`
      );
      continue;
    }
    const a = item.analysis;
    summaryLines.push(
      `## ${item.spotify_track_uri}\n`,
      `**Subject:** ${a.subject_paragraph}\n`,
      `**Tags:** ${(a.subject_tags || []).join(", ")}`,
      `**Tones:** ${(a.tones || []).join(", ")}`,
      `**Feel:** ${a.listener_feel_generic?.primary_emotion || "?"} (valence=${a.listener_feel_generic?.valence}, arousal=${a.listener_feel_generic?.arousal}, intensity=${a.listener_feel_generic?.intensity})`,
      `**POV:** ${a.narrative_pov} → ${a.addressed_to} | ${a.time_frame}`,
      `**Arc:** ${a.story_arc}`,
      `**Narrator:** ${a.narrator_reliability}`,
      `**Delivery:** ${(a.vocal_delivery_inferred || []).join(", ")}`,
      `**Tempo/Energy:** ${a.tempo_feel} | ${a.energy_curve} | range=${a.dynamic_range}`,
      `**Vocab:** ${a.vocab_level} | Quotability=${a.quotability}/10`,
      `**Structure:** ${a.structure_signature} | repetition=${a.repetition_density}`,
      `\n---\n`
    );
  }

  writeFileSync(summaryPath, summaryLines.join("\n"));
  console.log(`Wrote readable summary to ${summaryPath}`);
}

// ─── Entry ────────────────────────────────────────────────────────────────────
const { input, output, poll } = parseArgs();

if (poll) {
  await pollAndDownload(poll, output);
} else if (input) {
  await submitBatch(input, output);
} else {
  console.error(
    "Usage:\n" +
      "  Submit:  npx tsx 02-analyze-sonnet.ts --input=golden-set --output=analyses-stage1.jsonl\n" +
      "  Poll:    npx tsx 02-analyze-sonnet.ts --poll=BATCH_ID --output=analyses-stage1.jsonl"
  );
  process.exit(1);
}
