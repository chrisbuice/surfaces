/**
 * 04-loved-line.ts
 *
 * Iterates on the "loved line" prompt — picks the single lyric line most likely
 * to be the reason a listener loves a song. Sends each track sequentially to
 * Sonnet via direct API calls (not batch) for fast turnaround during prompt
 * iteration.
 *
 * Usage:
 *   npx tsx scripts/experiment/04-loved-line.ts --output=loved-lines-v0.jsonl
 *   npx tsx scripts/experiment/04-loved-line.ts --prompt=loved-line-v1.md --output=loved-lines-v1.jsonl
 *
 * Requires: ANTHROPIC_API_KEY, CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID
 *           in scripts/experiment/.env
 *
 * Output:
 *   docs/experiments/loved-line-2026-05/{output}          — JSONL results
 *   docs/experiments/loved-line-2026-05/{output}-readable.md — side-by-side review
 */

import { config } from "dotenv";
import { readFileSync, writeFileSync } from "fs";
import { resolve } from "path";
import Anthropic from "@anthropic-ai/sdk";

config({ path: resolve(import.meta.dirname!, ".env") });

// ─── Paths ────────────────────────────────────────────────────────────────────
const EXPERIMENT_DIR = resolve(
  import.meta.dirname!,
  "../../docs/experiments/loved-line-2026-05"
);
let PROMPT_PATH = resolve(EXPERIMENT_DIR, "prompts/loved-line-v1.md");
const TEST_SET_PATH = resolve(EXPERIMENT_DIR, "test-set.json");

// ─── Parse args ───────────────────────────────────────────────────────────────
function parseArgs(): { output: string } {
  const args = process.argv.slice(2);
  let output: string | null = null;

  for (const arg of args) {
    if (arg.startsWith("--output=")) {
      output = arg.slice("--output=".length);
    } else if (arg.startsWith("--prompt=")) {
      PROMPT_PATH = resolve(EXPERIMENT_DIR, "prompts", arg.slice("--prompt=".length));
    }
  }

  if (!output) {
    console.error(
      "Usage:\n  npx tsx scripts/experiment/04-loved-line.ts --output=loved-lines-v1.jsonl\n" +
      "       npx tsx scripts/experiment/04-loved-line.ts --prompt=loved-line-v0.md --output=loved-lines-v0.jsonl"
    );
    process.exit(1);
  }

  return { output };
}

// ─── Load prompt ──────────────────────────────────────────────────────────────
function loadPrompt(): { system: string; userTemplate: string } {
  const raw = readFileSync(PROMPT_PATH, "utf-8");

  const sysMatch = raw.match(/## System Prompt\s*\n([\s\S]*?)(?=\n## User Message Template)/);
  if (!sysMatch) throw new Error("Could not parse system prompt from prompt file");

  const userMatch = raw.match(
    /## User Message Template\s*\n([\s\S]*?)$/
  );
  if (!userMatch) throw new Error("Could not parse user template from prompt file");

  return { system: sysMatch[1].trim(), userTemplate: userMatch[1].trim() };
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

// ─── Load test set ────────────────────────────────────────────────────────────
interface Song {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
}

function loadTestSet(): Song[] {
  const data = JSON.parse(readFileSync(TEST_SET_PATH, "utf-8"));
  return data.songs;
}

// ─── Fetch lyrics from D1 ────────────────────────────────────────────────────
async function fetchLyrics(uris: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();

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
  }

  return map;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const { output } = parseArgs();
  const outputPath = resolve(EXPERIMENT_DIR, output);
  const readablePath = outputPath.replace(/\.jsonl$/, "") + "-readable.md";

  console.log(`Output: ${outputPath}`);

  // Load prompt
  const { system, userTemplate } = loadPrompt();
  console.log(`System prompt: ${system.length} chars`);

  // Load test set
  const songs = loadTestSet();
  console.log(`Test set: ${songs.length} songs`);

  // Fetch lyrics
  console.log("Fetching lyrics from D1...");
  const uris = songs.map((s) => s.spotify_track_uri);
  const lyricsMap = await fetchLyrics(uris);
  console.log(`  Got lyrics for ${lyricsMap.size}/${songs.length} songs`);

  const songsWithLyrics = songs.filter((s) => lyricsMap.has(s.spotify_track_uri));
  if (songsWithLyrics.length < songs.length) {
    const missing = songs.filter((s) => !lyricsMap.has(s.spotify_track_uri));
    console.warn(
      `  WARNING: ${missing.length} songs missing lyrics:`,
      missing.map((s) => `${s.artist_name} — ${s.track_name}`)
    );
  }

  // Init Anthropic client
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("Missing ANTHROPIC_API_KEY in .env");
  const client = new Anthropic({ apiKey });

  // Process each track sequentially
  const results: Array<{
    spotify_track_uri: string;
    track_name: string;
    artist_name: string;
    lyrics: string;
    analysis: any;
    parse_error?: string;
    raw_response: string;
  }> = [];

  for (let i = 0; i < songsWithLyrics.length; i++) {
    const song = songsWithLyrics[i];
    const lyrics = lyricsMap.get(song.spotify_track_uri)!;
    const userMessage = userTemplate
      .replace("{track_name}", song.track_name)
      .replace("{artist_name}", song.artist_name)
      .replace("{lyrics_plain}", lyrics);

    console.log(
      `  ${i + 1}/${songsWithLyrics.length}: ${song.artist_name} — ${song.track_name}`
    );

    try {
      const response = await client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: userMessage }],
      });

      const content = response.content[0];
      if (content.type !== "text") {
        results.push({
          spotify_track_uri: song.spotify_track_uri,
          track_name: song.track_name,
          artist_name: song.artist_name,
          lyrics,
          analysis: null,
          parse_error: `Unexpected content type: ${content.type}`,
          raw_response: JSON.stringify(response.content),
        });
        continue;
      }

      let text = content.text.trim();
      // Strip markdown code fences if Sonnet wrapped the JSON
      if (text.startsWith("```")) {
        text = text
          .replace(/^```(?:json)?\s*\n?/, "")
          .replace(/\n?```\s*$/, "");
      }

      try {
        const analysis = JSON.parse(text);
        results.push({
          spotify_track_uri: song.spotify_track_uri,
          track_name: song.track_name,
          artist_name: song.artist_name,
          lyrics,
          analysis,
          raw_response: content.text,
        });
      } catch (e) {
        console.warn(`    Parse error: ${(e as Error).message}`);
        results.push({
          spotify_track_uri: song.spotify_track_uri,
          track_name: song.track_name,
          artist_name: song.artist_name,
          lyrics,
          analysis: null,
          parse_error: (e as Error).message,
          raw_response: content.text,
        });
      }
    } catch (e) {
      console.warn(`    API error: ${(e as Error).message}`);
      results.push({
        spotify_track_uri: song.spotify_track_uri,
        track_name: song.track_name,
        artist_name: song.artist_name,
        lyrics,
        analysis: null,
        parse_error: `API error: ${(e as Error).message}`,
        raw_response: "",
      });
    }
  }

  // Write JSONL
  const jsonlLines = results.map((r) =>
    JSON.stringify({
      spotify_track_uri: r.spotify_track_uri,
      track_name: r.track_name,
      artist_name: r.artist_name,
      analysis: r.analysis,
      ...(r.parse_error ? { parse_error: r.parse_error } : {}),
      raw_response: r.raw_response,
    })
  );
  writeFileSync(outputPath, jsonlLines.join("\n") + "\n");
  console.log(`\nWrote ${jsonlLines.length} results to ${outputPath}`);

  // Write readable markdown
  const md: string[] = [
    `# Loved Line Results — ${output}\n`,
    `Prompt: ${PROMPT_PATH.split("/").pop()}`,
    `Songs: ${results.length}`,
    `Generated: ${new Date().toISOString()}\n`,
    `---\n`,
  ];

  for (const r of results) {
    if (r.parse_error || !r.analysis) {
      md.push(
        `## ${r.artist_name} — ${r.track_name}`,
        `**URI:** ${r.spotify_track_uri}`,
        `**Error:** ${r.parse_error}\n`,
        `---\n`
      );
      continue;
    }

    const a = r.analysis;
    const lyricsBlock = r.lyrics
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");

    // Support both v0 (loved_line) and v1+ (loved_passage) schemas
    const passage = a.loved_passage ?? a.loved_line ?? "?";
    const passageBlock = passage.split("\\n").map((l: string) => `> ${l}`).join("\n");
    const why = a.why_this_passage ?? a.why_this_line ?? "?";

    const positionParts: string[] = [];
    if (a.start_position) {
      positionParts.push(a.start_position);
      if (a.end_position && a.end_position !== a.start_position) {
        positionParts.push(`→ ${a.end_position}`);
      }
    } else if (a.line_position) {
      positionParts.push(a.line_position);
    }

    md.push(
      `## ${r.artist_name} — ${r.track_name}`,
      `**URI:** ${r.spotify_track_uri}`,
      `**Confidence:** ${a.confidence ?? "?"}`,
      ...(a.line_count ? [`**Lines:** ${a.line_count}`] : []),
      ``,
      passageBlock,
      ``,
      `*Position:* ${positionParts.join(" ") || "?"}`,
      `*Why:* ${why}`,
      ...(a.runner_up ? [`*Runner-up:* ${a.runner_up}`] : []),
      ``,
      `<details>`,
      `<summary>Lyrics</summary>`,
      ``,
      lyricsBlock,
      ``,
      `</details>`,
      ``,
      `---\n`
    );
  }

  writeFileSync(readablePath, md.join("\n"));
  console.log(`Wrote readable summary to ${readablePath}`);
}

main();
