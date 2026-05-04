/**
 * generate-obsession-tier.ts
 *
 * Generates the obsession-tier URI list for the lyrics-analysis eager batch.
 * Per PLAN_LYRICS_TRANSPARENCY_PIVOT.md §8.2:
 *   - Top 500 tracks by track_taste.taste_score
 *   - UNION tracks with ≥10 lifetime plays from plays table
 *   - Deduplicate
 *   - Filter to tracks with lyrics (status='ok' in track_lyrics)
 *
 * Output: stack/lyrics-analysis/obsession-tier.csv (one URI per line, no header)
 *
 * Usage: npx tsx scripts/generate-obsession-tier.ts
 * Requires: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID in scripts/experiment/.env
 */

import { config } from "dotenv";
import { writeFileSync } from "fs";
import { resolve } from "path";

config({ path: resolve(import.meta.dirname!, ".env") });

// ─── D1 query ─────────────────────────────────────────────────────────────

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
  params: (string | number | null)[] = [],
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

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Obsession-tier URI list generator ===\n");

  // Source 1: Top 500 by taste_score
  console.log("Querying top 500 by taste_score...");
  const topTaste = await queryD1<{ uri: string }>(
    "SELECT 'spotify:track:' || track_id AS uri FROM track_taste ORDER BY taste_score DESC LIMIT 500",
  );
  console.log(`  Source 1 (top 500 by taste_score): ${topTaste.length}`);

  // Source 2: Tracks with ≥10 lifetime plays
  console.log("Querying tracks with ≥10 lifetime plays...");
  const frequentPlays = await queryD1<{ uri: string }>(
    "SELECT spotify_track_uri AS uri FROM plays GROUP BY spotify_track_uri HAVING COUNT(*) >= 10",
  );
  console.log(`  Source 2 (≥10 lifetime plays):     ${frequentPlays.length}`);

  // Deduplicate
  const allUris = new Set<string>();
  for (const row of topTaste) allUris.add(row.uri);
  for (const row of frequentPlays) allUris.add(row.uri);
  console.log(`  After dedup:                       ${allUris.size}`);

  // Filter to tracks with lyrics (status='ok')
  console.log("Querying track_lyrics for status='ok' URIs...");
  const lyricsOk = await queryD1<{ uri: string }>(
    "SELECT spotify_track_uri AS uri FROM track_lyrics WHERE status = 'ok'",
  );
  const lyricsSet = new Set(lyricsOk.map((r) => r.uri));

  const finalUris: string[] = [];
  for (const uri of allUris) {
    if (lyricsSet.has(uri)) finalUris.push(uri);
  }
  finalUris.sort(); // deterministic output
  console.log(`  After lyrics filter:               ${finalUris.length}`);

  // Write output
  const outputPath = resolve(import.meta.dirname!, "../../stack/lyrics-analysis/obsession-tier.csv");
  writeFileSync(outputPath, finalUris.join("\n") + "\n");
  console.log(`\nFinal count: ${finalUris.length}`);
  console.log(`Written to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
