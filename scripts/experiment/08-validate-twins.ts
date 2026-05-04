/**
 * 08-validate-twins.ts
 *
 * Validates whether "analysis" embedding cosine produces coherent lyric twins.
 * Uses existing experiment data: embeddings on disk + analyses.jsonl + rankings.csv.
 *
 * Two tests:
 *   1. Subject coherence (gating): For 20 random seeds, compute 5 nearest neighbors
 *      by analysis embedding cosine. Output a readable report for manual inspection.
 *      Pass threshold: ≥70% coherent+partial twins (human-judged).
 *
 *   2. Rating concordance (informational): Among rated twin pairs, compare mean
 *      absolute rating difference vs random-pair baseline.
 *
 * Usage: npx tsx 08-validate-twins.ts [--seed N]
 * Output: docs/experiments/lyric-analysis-2026-05/twins-validation.md
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────
const EXPERIMENT_DIR = resolve(
  import.meta.dirname!,
  "../../docs/experiments/lyric-analysis-2026-05"
);
const EMBEDDINGS_DIR = resolve(EXPERIMENT_DIR, "embeddings");
const K = 5; // number of nearest neighbors
const SEED_COUNT = 20; // number of seeds for manual inspection

// ─── Args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
const rngSeed = getArg("--seed") ? parseInt(getArg("--seed")!, 10) : 42;

// ─── Helpers ────────────────────────────────────────────────────────────────
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

/** Simple seeded RNG (mulberry32). */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates shuffle with seeded RNG. */
function shuffle<T>(arr: T[], rng: () => number): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ─── Load data ──────────────────────────────────────────────────────────────
interface Analysis {
  uri: string;
  track: string;
  artist: string;
  subject: string;
  tones: string[];
  emotion: string;
}

function loadAnalyses(): Analysis[] {
  const path = resolve(EXPERIMENT_DIR, "analyses.jsonl");
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const result: Analysis[] = [];

  for (const line of lines) {
    const item = JSON.parse(line);
    if (item.error) continue;
    const a = item.analysis;
    result.push({
      uri: item.spotify_track_uri,
      track: a.track || a.track_name || "Unknown",
      artist: a.artist || a.artist_name || "Unknown",
      subject: a.subject_paragraph || "",
      tones: a.tones || [],
      emotion:
        a.listener_feel_generic?.primary_emotion ||
        a.listener_feel_generic?.during?.slice(0, 60) ||
        "",
    });
  }

  return result;
}

function loadRatings(): Map<string, number> {
  const path = resolve(EXPERIMENT_DIR, "rankings.csv");
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const map = new Map<string, number>();

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const uri = cols[0];
    const rating = cols[7] ? parseInt(cols[7], 10) : NaN;
    if (!isNaN(rating)) map.set(uri, rating);
  }

  return map;
}

// ─── Compute twins ──────────────────────────────────────────────────────────
interface Twin {
  uri: string;
  track: string;
  artist: string;
  subject: string;
  tones: string[];
  similarity: number;
  rating: number | null;
}

function findTwins(
  seedUri: string,
  allAnalyses: Analysis[],
  embeddings: Map<string, Float32Array>,
  ratings: Map<string, number>,
): Twin[] {
  const seedEmb = embeddings.get(seedUri);
  if (!seedEmb) return [];

  const scored: Array<{ uri: string; sim: number }> = [];
  for (const a of allAnalyses) {
    if (a.uri === seedUri) continue;
    const emb = embeddings.get(a.uri);
    if (!emb) continue;
    scored.push({ uri: a.uri, sim: cosine(seedEmb, emb) });
  }

  scored.sort((a, b) => b.sim - a.sim);
  const topK = scored.slice(0, K);

  const analysisMap = new Map(allAnalyses.map((a) => [a.uri, a]));

  return topK.map((s) => {
    const a = analysisMap.get(s.uri)!;
    return {
      uri: s.uri,
      track: a.track,
      artist: a.artist,
      subject: a.subject,
      tones: a.tones,
      similarity: s.sim,
      rating: ratings.get(s.uri) ?? null,
    };
  });
}

// ─── Main ───────────────────────────────────────────────────────────────────
function main() {
  console.log("=== Twins Validation ===\n");

  // Load analyses
  const analyses = loadAnalyses();
  console.log(`Loaded ${analyses.length} analyses`);

  // Load embeddings
  const embeddings = new Map<string, Float32Array>();
  let missing = 0;
  for (const a of analyses) {
    const id = uriToId(a.uri);
    const emb = loadEmbedding(resolve(EMBEDDINGS_DIR, `analysis-${id}.bin`));
    if (emb) {
      embeddings.set(a.uri, emb);
    } else {
      missing++;
    }
  }
  console.log(`Loaded ${embeddings.size} embeddings (${missing} missing)`);

  // Load ratings
  const ratings = loadRatings();
  console.log(`Loaded ${ratings.size} blind ratings\n`);

  // Pick 20 random seeds (from all 250, not just rated)
  const rng = mulberry32(rngSeed);
  const withEmbeddings = analyses.filter((a) => embeddings.has(a.uri));
  const seeds = shuffle(withEmbeddings, rng).slice(0, SEED_COUNT);

  // ── Test 1: Subject coherence report ──────────────────────────────────
  const lines: string[] = [];
  lines.push("# Twins Validation Report");
  lines.push("");
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**RNG seed:** ${rngSeed}`);
  lines.push(`**Seeds:** ${SEED_COUNT} random tracks from ${withEmbeddings.length} with embeddings`);
  lines.push(`**K:** ${K} nearest neighbors per seed`);
  lines.push("");
  lines.push("## Test 1: Subject Coherence (manual inspection required)");
  lines.push("");
  lines.push("For each seed, inspect the 5 twins. Score each twin as:");
  lines.push("- **C** (coherent): shares subject matter, tone, or narrative feel");
  lines.push("- **P** (partial): some overlap but different enough to notice");
  lines.push("- **I** (incoherent): no meaningful similarity to the seed");
  lines.push("");
  lines.push("**Pass threshold:** ≥70% C+P across all 100 twin pairs.");
  lines.push("");

  for (let s = 0; s < seeds.length; s++) {
    const seed = seeds[s];
    const twins = findTwins(seed.uri, analyses, embeddings, ratings);
    const seedRating = ratings.get(seed.uri);

    lines.push(`### Seed ${s + 1}: ${seed.track} — ${seed.artist}`);
    if (seedRating !== undefined) lines.push(`Rating: ${seedRating}★`);
    lines.push(`> ${seed.subject.slice(0, 200)}${seed.subject.length > 200 ? "..." : ""}`);
    lines.push(`> Tones: ${seed.tones.join(", ")}`);
    lines.push("");
    lines.push("| # | Track | Artist | Cosine | Tones | Subject (truncated) | Score |");
    lines.push("|---|---|---|---|---|---|---|");

    for (let t = 0; t < twins.length; t++) {
      const tw = twins[t];
      const subj = tw.subject.slice(0, 100).replace(/\|/g, "\\|").replace(/\n/g, " ");
      const tones = tw.tones.slice(0, 3).join(", ");
      const ratingStr = tw.rating !== null ? `${tw.rating}★` : "";
      lines.push(
        `| ${t + 1} | ${tw.track} | ${tw.artist} | ${tw.similarity.toFixed(3)} | ${tones} | ${subj}... | ___ |`
      );
    }
    lines.push("");
  }

  // ── Test 2: Rating concordance ────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## Test 2: Rating Concordance (informational, not gating)");
  lines.push("");

  // For each rated track, find its twins among the rated set
  const ratedUris = [...ratings.keys()];
  let twinPairDiffs: number[] = [];
  let twinPairCount = 0;

  for (const uri of ratedUris) {
    if (!embeddings.has(uri)) continue;
    const twins = findTwins(uri, analyses, embeddings, ratings);
    for (const tw of twins) {
      if (tw.rating !== null) {
        twinPairDiffs.push(Math.abs(ratings.get(uri)! - tw.rating));
        twinPairCount++;
      }
    }
  }

  // Random-pair baseline: sample 1000 random pairs from rated tracks
  const randomDiffs: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const a = ratedUris[Math.floor(rng() * ratedUris.length)];
    const b = ratedUris[Math.floor(rng() * ratedUris.length)];
    if (a !== b) {
      randomDiffs.push(Math.abs(ratings.get(a)! - ratings.get(b)!));
    }
  }

  const twinMeanDiff =
    twinPairDiffs.length > 0
      ? (twinPairDiffs.reduce((a, b) => a + b, 0) / twinPairDiffs.length).toFixed(2)
      : "N/A";
  const randomMeanDiff =
    randomDiffs.length > 0
      ? (randomDiffs.reduce((a, b) => a + b, 0) / randomDiffs.length).toFixed(2)
      : "N/A";

  lines.push(`| Metric | Twin pairs | Random pairs |`);
  lines.push(`|---|---|---|`);
  lines.push(`| Count | ${twinPairCount} | ${randomDiffs.length} |`);
  lines.push(`| Mean absolute rating diff | ${twinMeanDiff} | ${randomMeanDiff} |`);
  lines.push("");
  lines.push(
    twinPairCount > 0
      ? `Twin pairs have a mean rating difference of ${twinMeanDiff} vs ${randomMeanDiff} for random pairs. ${
          parseFloat(twinMeanDiff) < parseFloat(randomMeanDiff)
            ? "Twins show slightly more rating concordance than random — a nice signal, but not gating."
            : "No rating concordance advantage for twins over random pairs. Expected — H2 already showed embeddings don't predict taste."
        }`
      : "Not enough twin pairs with ratings to compute concordance."
  );
  lines.push("");

  // ── Summary ───────────────────────────────────────────────────────────
  lines.push("---");
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push("**Test 1:** Fill in the Score column above (C/P/I), then count:");
  lines.push("- Total C+P: ___ / 100");
  lines.push("- **Pass (≥70)?** ___");
  lines.push("");
  lines.push("**Test 2:** Rating concordance reported above (informational only).");
  lines.push("");
  lines.push("**Decision:**");
  lines.push("- If Test 1 passes: ship the dashboard \"vibe twins\" widget.");
  lines.push("- If Test 1 fails: keep `find_similar_lyrics` as MCP-only; don't build the dashboard widget.");

  // Write output
  const outputPath = resolve(EXPERIMENT_DIR, "twins-validation.md");
  writeFileSync(outputPath, lines.join("\n") + "\n");
  console.log(`Report written to ${outputPath}`);
  console.log(`\n${SEED_COUNT} seeds × ${K} twins = ${SEED_COUNT * K} twin pairs to inspect.`);
  console.log(`${twinPairCount} rated twin pairs found for concordance test.`);
}

main();
