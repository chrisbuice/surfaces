#!/usr/bin/env npx tsx
/**
 * analyze-validation.ts — Cross-reference blind ratings with Sonnet lyric analysis.
 *
 * Joins:
 *   blind-ratings.csv (uri → rating)
 *   candidates.json   (uri → track_name, artist_name)
 *   lyrics-analysis-output.csv (track_name, artist_name → analysis features)
 *
 * Outputs correlation statistics: which lyric features predict the 1-5 blind ratings.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load blind ratings ─────────────────────────────────────────────────────
interface BlindRating {
  uri: string;
  rating: number | null;
  skipped: boolean;
}

function loadRatings(path: string): BlindRating[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  return lines.slice(1).map((line) => {
    const [uri, rating, skipped] = line.split(",");
    return {
      uri: uri.trim(),
      rating: rating && rating.trim() ? parseInt(rating.trim(), 10) : null,
      skipped: skipped?.trim() === "true",
    };
  });
}

// ─── Load candidates ────────────────────────────────────────────────────────
interface Candidate {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  play_count: number;
  era_bucket: string;
}

function loadCandidates(path: string): Candidate[] {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  return data.candidates;
}

// ─── Load analysis CSV ──────────────────────────────────────────────────────
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

interface AnalysisRow {
  track_name: string;
  artist_name: string;
  subject_tags: string[];
  tones: string[];
  lyric_intrusion: number;
  narrative_pov: string;
  addressed_to: string;
  tempo_feel: string;
  explicitness: number;
  quotability: number;
  vocab_level: string;
  valence: number;
  arousal: number;
  dominance: number;
  primary_emotion: string;
  intensity: number;
  ambivalence: number;
  rhyme_scheme: string;
}

function loadAnalysis(path: string): AnalysisRow[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map((line) => {
    const fields = parseCSVLine(line);
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = fields[i] ?? ""));

    let feel: any = {};
    try {
      feel = JSON.parse(obj.listener_feel_generic || "{}");
    } catch {}

    let tags: string[] = [];
    try {
      tags = JSON.parse(obj.subject_tags || "[]");
    } catch {}

    let tones: string[] = [];
    try {
      tones = JSON.parse(obj.tones || "[]");
    } catch {}

    return {
      track_name: obj.track_name,
      artist_name: obj.artist_name,
      subject_tags: tags,
      tones: tones,
      lyric_intrusion: parseFloat(obj.lyric_intrusion) || 0,
      narrative_pov: obj.narrative_pov,
      addressed_to: obj.addressed_to,
      tempo_feel: obj.tempo_feel,
      explicitness: parseFloat(obj.explicitness) || 0,
      quotability: parseInt(obj.quotability) || 0,
      vocab_level: obj.vocab_level,
      valence: feel.valence ?? 0,
      arousal: feel.arousal ?? 0,
      dominance: feel.dominance ?? 0,
      primary_emotion: feel.primary_emotion ?? "",
      intensity: feel.intensity ?? 0,
      ambivalence: feel.ambivalence ?? 0,
      rhyme_scheme: obj.rhyme_scheme,
    };
  });
}

// ─── Stats helpers ──────────────────────────────────────────────────────────
function mean(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = mean(x);
  const my = mean(y);
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  const denom = Math.sqrt(dx2 * dy2);
  return denom === 0 ? 0 : num / denom;
}

function groupMean(items: { rating: number; value: string }[]): Map<string, { mean: number; n: number }> {
  const groups = new Map<string, number[]>();
  for (const item of items) {
    const arr = groups.get(item.value) || [];
    arr.push(item.rating);
    groups.set(item.value, arr);
  }
  const result = new Map<string, { mean: number; n: number }>();
  for (const [key, vals] of groups) {
    result.set(key, { mean: mean(vals), n: vals.length });
  }
  return result;
}

// ─── Main ───────────────────────────────────────────────────────────────────
const ratings = loadRatings(resolve(__dirname, "blind-ratings.csv"));
const candidates = loadCandidates(resolve(__dirname, "candidates.json"));
const analysis = loadAnalysis(resolve(process.env.HOME!, "Downloads/lyrics-analysis-output.csv"));

// Build lookup maps
const uriToCandidate = new Map(candidates.map((c) => [c.spotify_track_uri, c]));
const nameToAnalysis = new Map(
  analysis.map((a) => [`${a.track_name.toLowerCase()}|||${a.artist_name.toLowerCase()}`, a]),
);

// Join: rating → candidate → analysis
interface JoinedRow {
  uri: string;
  rating: number;
  track_name: string;
  artist_name: string;
  analysis: AnalysisRow;
  play_count: number;
  era_bucket: string;
}

const joined: JoinedRow[] = [];
let unmatched = 0;

for (const r of ratings) {
  if (r.rating === null || r.skipped) continue;
  const cand = uriToCandidate.get(r.uri);
  if (!cand) continue;
  const key = `${cand.track_name.toLowerCase()}|||${cand.artist_name.toLowerCase()}`;
  const an = nameToAnalysis.get(key);
  if (!an) {
    unmatched++;
    continue;
  }
  joined.push({
    uri: r.uri,
    rating: r.rating,
    track_name: cand.track_name,
    artist_name: cand.artist_name,
    analysis: an,
    play_count: cand.play_count,
    era_bucket: cand.era_bucket,
  });
}

console.log(`\n=== Blind Rating × Lyric Analysis Validation ===\n`);
console.log(`Blind ratings: ${ratings.filter((r) => r.rating !== null).length}`);
console.log(`Analysis rows: ${analysis.length}`);
console.log(`Joined:        ${joined.length}`);
console.log(`Unmatched:     ${unmatched}\n`);

// ─── Rating distribution ────────────────────────────────────────────────────
console.log("── Rating Distribution ──");
for (let r = 1; r <= 5; r++) {
  const count = joined.filter((j) => j.rating === r).length;
  const bar = "█".repeat(Math.round(count / 2));
  console.log(`  ${r}: ${String(count).padStart(3)} ${bar}`);
}
console.log();

// ─── Continuous feature correlations ────────────────────────────────────────
console.log("── Pearson Correlations with Rating ──");
const ratingVals = joined.map((j) => j.rating);

const continuousFeatures: [string, (j: JoinedRow) => number][] = [
  ["valence", (j) => j.analysis.valence],
  ["arousal", (j) => j.analysis.arousal],
  ["dominance", (j) => j.analysis.dominance],
  ["intensity", (j) => j.analysis.intensity],
  ["ambivalence", (j) => j.analysis.ambivalence],
  ["lyric_intrusion", (j) => j.analysis.lyric_intrusion],
  ["explicitness", (j) => j.analysis.explicitness],
  ["quotability", (j) => j.analysis.quotability],
];

const correlations: [string, number][] = [];
for (const [name, getter] of continuousFeatures) {
  const vals = joined.map(getter);
  const r = pearson(vals, ratingVals);
  correlations.push([name, r]);
}
correlations.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));

for (const [name, r] of correlations) {
  const sign = r >= 0 ? "+" : "";
  const strength =
    Math.abs(r) >= 0.3 ? "***" : Math.abs(r) >= 0.2 ? "** " : Math.abs(r) >= 0.1 ? "*  " : "   ";
  console.log(`  ${strength} ${name.padEnd(18)} ${sign}${r.toFixed(3)}`);
}
console.log(`  (* p<0.1-ish at n=${joined.length}; ** moderate; *** notable)\n`);

// ─── Categorical feature breakdowns ─────────────────────────────────────────
console.log("── Mean Rating by Category ──\n");

const categoricalFeatures: [string, (j: JoinedRow) => string][] = [
  ["primary_emotion", (j) => j.analysis.primary_emotion],
  ["addressed_to", (j) => j.analysis.addressed_to],
  ["narrative_pov", (j) => j.analysis.narrative_pov],
  ["tempo_feel", (j) => j.analysis.tempo_feel],
  ["vocab_level", (j) => j.analysis.vocab_level],
  ["era_bucket", (j) => j.era_bucket],
  ["play_count", (j) => String(j.play_count)],
];

for (const [name, getter] of categoricalFeatures) {
  console.log(`  ${name}:`);
  const items = joined.map((j) => ({ rating: j.rating, value: getter(j) }));
  const groups = groupMean(items);
  const sorted = [...groups.entries()].sort((a, b) => b[1].mean - a[1].mean);
  for (const [key, { mean: m, n }] of sorted) {
    if (n < 2) continue;
    const label = String(key ?? "(empty)");
    const bar = "█".repeat(Math.round(m * 3));
    console.log(`    ${label.padEnd(20)} ${m.toFixed(2)} (n=${n}) ${bar}`);
  }
  console.log();
}

// ─── Tone analysis ──────────────────────────────────────────────────────────
console.log("── Mean Rating by Tone (n≥3) ──");
const toneRatings = new Map<string, number[]>();
for (const j of joined) {
  for (const tone of j.analysis.tones) {
    const arr = toneRatings.get(tone) || [];
    arr.push(j.rating);
    toneRatings.set(tone, arr);
  }
}
const toneStats = [...toneRatings.entries()]
  .filter(([, vals]) => vals.length >= 3)
  .map(([tone, vals]) => ({ tone, mean: mean(vals), n: vals.length }))
  .sort((a, b) => b.mean - a.mean);

for (const { tone, mean: m, n } of toneStats) {
  const bar = "█".repeat(Math.round(m * 3));
  console.log(`  ${tone.padEnd(20)} ${m.toFixed(2)} (n=${n}) ${bar}`);
}
console.log();

// ─── Subject tag analysis ───────────────────────────────────────────────────
console.log("── Mean Rating by Subject Tag (n≥2) ──");
const tagRatings = new Map<string, number[]>();
for (const j of joined) {
  for (const tag of j.analysis.subject_tags) {
    const arr = tagRatings.get(tag) || [];
    arr.push(j.rating);
    tagRatings.set(tag, arr);
  }
}
const tagStats = [...tagRatings.entries()]
  .filter(([, vals]) => vals.length >= 2)
  .map(([tag, vals]) => ({ tag, mean: mean(vals), n: vals.length }))
  .sort((a, b) => b.mean - a.mean);

console.log("  Top 10 (highest rated):");
for (const { tag, mean: m, n } of tagStats.slice(0, 10)) {
  console.log(`    ${tag.padEnd(35)} ${m.toFixed(2)} (n=${n})`);
}
console.log("  Bottom 10 (lowest rated):");
for (const { tag, mean: m, n } of tagStats.slice(-10)) {
  console.log(`    ${tag.padEnd(35)} ${m.toFixed(2)} (n=${n})`);
}
console.log();

// ─── High vs Low rating comparison ─────────────────────────────────────────
console.log("── High (4-5) vs Low (1-2) Feature Comparison ──\n");
const high = joined.filter((j) => j.rating >= 4);
const low = joined.filter((j) => j.rating <= 2);

console.log(`  High-rated: ${high.length} tracks    Low-rated: ${low.length} tracks\n`);

for (const [name, getter] of continuousFeatures) {
  const hMean = mean(high.map(getter));
  const lMean = mean(low.map(getter));
  const diff = hMean - lMean;
  const arrow = diff > 0.05 ? "▲" : diff < -0.05 ? "▼" : "≈";
  console.log(
    `  ${name.padEnd(18)} high=${hMean.toFixed(2)}  low=${lMean.toFixed(2)}  diff=${diff > 0 ? "+" : ""}${diff.toFixed(2)} ${arrow}`,
  );
}
console.log();
