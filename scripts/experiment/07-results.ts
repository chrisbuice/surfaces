/**
 * 07-results.ts
 *
 * Final statistics for the lyric analysis experiment.
 *
 * Pipeline:
 *   1. Load rankings.csv (lyric_rank, existing_rank, hybrid_rank — produced by 04-rank.ts)
 *   2. Load blind-ratings.csv (uri → 1-5 rating, possibly partial)
 *   3. Merge: write blind_rating column back into rankings.csv
 *   4. Compute Spearman rank correlation for each of the three rankings vs ratings
 *   5. Compute mean rating of each ranking's top-20 and bottom-20
 *   6. Compute distribution of high (4-5) ratings across top-20 of each ranking
 *   7. Tabulate H1–H4 pass/fail
 *   8. Write results.md
 *
 * Usage: npx tsx 07-results.ts
 *
 * Notes:
 *   - The plan target was 200 blind ratings. With fewer ratings the math still works
 *     but treat the result as directional, not final.
 *   - "Skipped" rows (couldn't form an opinion) are excluded from all statistics.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const EXPERIMENT_DIR = resolve(__dirname, "../../docs/experiments/lyric-analysis-2026-05");
const RANKINGS_PATH = resolve(EXPERIMENT_DIR, "rankings.csv");
const BLIND_RATINGS_PATH = resolve(__dirname, "blind-ratings.csv");
const RESULTS_PATH = resolve(EXPERIMENT_DIR, "results.md");

// ─── CSV helpers ────────────────────────────────────────────────────────────

interface RankingRow {
  uri: string;
  lyric_sim: number;
  lyric_rank: number;
  taste_score: number;
  existing_rank: number;
  hybrid_score: number;
  hybrid_rank: number;
  blind_rating: number | null;
}

interface BlindRow {
  uri: string;
  rating: number | null; // null = skipped or unrated
}

function parseRankings(path: string): RankingRow[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const out: RankingRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 7) continue;
    const ratingStr = cols[7]?.trim();
    out.push({
      uri: cols[0].trim(),
      lyric_sim: parseFloat(cols[1]),
      lyric_rank: parseInt(cols[2], 10),
      taste_score: parseFloat(cols[3]),
      existing_rank: parseInt(cols[4], 10),
      hybrid_score: parseFloat(cols[5]),
      hybrid_rank: parseInt(cols[6], 10),
      blind_rating: ratingStr ? parseInt(ratingStr, 10) : null,
    });
  }
  return out;
}

function parseBlindRatings(path: string): BlindRow[] {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  const out: BlindRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < 3) continue;
    const uri = cols[0].trim();
    const ratingStr = cols[1]?.trim();
    const skipped = cols[2]?.trim() === "true";
    out.push({
      uri,
      rating: !skipped && ratingStr ? parseInt(ratingStr, 10) : null,
    });
  }
  return out;
}

function writeRankings(path: string, rows: RankingRow[]): void {
  const header = "spotify_track_uri,lyric_sim,lyric_rank,taste_score,existing_rank,hybrid_score,hybrid_rank,blind_rating";
  const lines = rows.map((r) =>
    [
      r.uri,
      r.lyric_sim.toFixed(6),
      r.lyric_rank,
      r.taste_score.toFixed(2),
      r.existing_rank,
      r.hybrid_score.toFixed(6),
      r.hybrid_rank,
      r.blind_rating === null ? "" : r.blind_rating,
    ].join(",")
  );
  writeFileSync(path, [header, ...lines].join("\n") + "\n");
}

// ─── Statistics ─────────────────────────────────────────────────────────────

/**
 * Spearman rank correlation. Both inputs are arrays of equal length.
 * Returns [rho, n].
 */
function spearman(rankingX: number[], ratingY: number[]): { rho: number; n: number } {
  if (rankingX.length !== ratingY.length) throw new Error("length mismatch");
  const n = rankingX.length;
  if (n < 2) return { rho: NaN, n };

  const rankX = toRanks(rankingX);
  const rankY = toRanks(ratingY);

  let sumDsq = 0;
  for (let i = 0; i < n; i++) {
    const d = rankX[i] - rankY[i];
    sumDsq += d * d;
  }
  // Standard Spearman formula (with average ranks for ties handled by toRanks)
  const meanX = (n + 1) / 2;
  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = rankX[i] - meanX;
    const dy = rankY[i] - meanX;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }
  const denom = Math.sqrt(varX * varY);
  return { rho: denom === 0 ? 0 : cov / denom, n };
}

/** Convert raw values into average-ranks (handles ties). Higher value = lower rank number = better. */
function toRanks(values: number[]): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => b.v - a.v); // descending — highest value gets rank 1
  const ranks = new Array(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // +1 for 1-indexed
    for (let k = i; k <= j; k++) {
      ranks[indexed[k].i] = avgRank;
    }
    i = j + 1;
  }
  return ranks;
}

/** Rough two-sided p-value for Spearman rho via Student-t approximation. */
function spearmanP(rho: number, n: number): number {
  if (n < 3 || !Number.isFinite(rho) || Math.abs(rho) >= 1) return NaN;
  const t = rho * Math.sqrt((n - 2) / (1 - rho * rho));
  // Two-sided p from t-distribution survival; simple Abramowitz & Stegun 26.7.8 approximation
  return 2 * studentTSurvival(Math.abs(t), n - 2);
}

function studentTSurvival(t: number, df: number): number {
  // Series approx good enough for df > 10. Falls back to normal at high df.
  const x = df / (df + t * t);
  return 0.5 * incompleteBetaApprox(x, df / 2, 0.5);
}

function incompleteBetaApprox(x: number, a: number, b: number): number {
  // Crude continued-fraction-free approximation: only used for diagnostic p-value.
  // For decision-making, treat |rho| and n directly rather than relying on this.
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  // Simpson's rule on the integrand
  const f = (t: number) => Math.pow(t, a - 1) * Math.pow(1 - t, b - 1);
  const N = 200;
  const h = x / N;
  let sum = f(1e-10) + f(x);
  for (let i = 1; i < N; i++) {
    const t = i * h;
    sum += (i % 2 === 0 ? 2 : 4) * f(t);
  }
  const numerator = (h / 3) * sum;
  // Normalize by Beta(a,b)
  const beta = gammaApprox(a) * gammaApprox(b) / gammaApprox(a + b);
  return numerator / beta;
}

function gammaApprox(z: number): number {
  // Stirling for small/medium z
  const g = 7;
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gammaApprox(1 - z));
  z -= 1;
  let x = c[0];
  for (let i = 1; i < g + 2; i++) x += c[i] / (z + i);
  const t = z + g + 0.5;
  return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
}

function mean(arr: number[]): number {
  if (arr.length === 0) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  console.log("Loading rankings.csv...");
  const rankings = parseRankings(RANKINGS_PATH);
  console.log(`  ${rankings.length} candidates`);

  console.log("Loading blind-ratings.csv...");
  const blindRows = parseBlindRatings(BLIND_RATINGS_PATH);
  const ratingMap = new Map<string, number>();
  let skipCount = 0;
  for (const r of blindRows) {
    if (r.rating === null) {
      skipCount++;
    } else {
      ratingMap.set(r.uri, r.rating);
    }
  }
  console.log(`  ${ratingMap.size} ratings, ${skipCount} skipped`);

  // Merge
  let merged = 0;
  for (const r of rankings) {
    const rating = ratingMap.get(r.uri);
    if (rating !== undefined) {
      r.blind_rating = rating;
      merged++;
    }
  }
  console.log(`Merged ${merged} ratings into rankings`);

  console.log("Writing back to rankings.csv...");
  writeRankings(RANKINGS_PATH, rankings);

  // Filter to rated rows for analysis
  const rated = rankings.filter((r) => r.blind_rating !== null);
  console.log(`\nAnalyzing on ${rated.length} rated rows`);

  if (rated.length < 20) {
    console.error("Too few ratings to analyze. Need at least 20.");
    process.exit(1);
  }

  // For Spearman: lower rank = better (rank 1 is best). To correlate "low rank = high rating",
  // we negate the rank so higher is better, matching the rating scale's direction.
  const ratings = rated.map((r) => r.blind_rating!);
  const lyricNeg = rated.map((r) => -r.lyric_rank);
  const existingNeg = rated.map((r) => -r.existing_rank);
  const hybridNeg = rated.map((r) => -r.hybrid_rank);

  const lyric = spearman(lyricNeg, ratings);
  const existing = spearman(existingNeg, ratings);
  const hybrid = spearman(hybridNeg, ratings);

  console.log("\n=== Spearman correlations (rank vs blind rating) ===");
  console.log(`  lyric:    rho=${lyric.rho.toFixed(3)}  n=${lyric.n}  p≈${spearmanP(lyric.rho, lyric.n).toFixed(3)}`);
  console.log(`  existing: rho=${existing.rho.toFixed(3)}  n=${existing.n}  p≈${spearmanP(existing.rho, existing.n).toFixed(3)}`);
  console.log(`  hybrid:   rho=${hybrid.rho.toFixed(3)}  n=${hybrid.n}  p≈${spearmanP(hybrid.rho, hybrid.n).toFixed(3)}`);

  // Top-20 / bottom-20 mean-rating analysis (per H3)
  // Note: top-20 is over the FULL 200, but mean-rating uses only the rated subset of those 20.
  function topKMean(rankField: "lyric_rank" | "existing_rank" | "hybrid_rank", k: number): { mean: number; n: number; high: number } {
    const top = [...rankings].sort((a, b) => a[rankField] - b[rankField]).slice(0, k);
    const ratedTop = top.filter((r) => r.blind_rating !== null);
    const ratings = ratedTop.map((r) => r.blind_rating!);
    const high = ratings.filter((r) => r >= 4).length;
    return { mean: mean(ratings), n: ratedTop.length, high };
  }
  function bottomKMean(rankField: "lyric_rank" | "existing_rank" | "hybrid_rank", k: number): { mean: number; n: number; low: number } {
    const bottom = [...rankings].sort((a, b) => b[rankField] - a[rankField]).slice(0, k);
    const ratedBot = bottom.filter((r) => r.blind_rating !== null);
    const ratings = ratedBot.map((r) => r.blind_rating!);
    const low = ratings.filter((r) => r <= 2).length;
    return { mean: mean(ratings), n: ratedBot.length, low };
  }

  const lyricTop = topKMean("lyric_rank", 20);
  const existingTop = topKMean("existing_rank", 20);
  const hybridTop = topKMean("hybrid_rank", 20);
  const lyricBot = bottomKMean("lyric_rank", 20);
  const existingBot = bottomKMean("existing_rank", 20);
  const hybridBot = bottomKMean("hybrid_rank", 20);

  console.log("\n=== Top-20 mean rating (n is the rated subset of the top-20) ===");
  console.log(`  lyric:    mean=${lyricTop.mean.toFixed(2)}  n=${lyricTop.n}/20 rated  (${lyricTop.high} were 4-5 stars)`);
  console.log(`  existing: mean=${existingTop.mean.toFixed(2)}  n=${existingTop.n}/20 rated  (${existingTop.high} were 4-5 stars)`);
  console.log(`  hybrid:   mean=${hybridTop.mean.toFixed(2)}  n=${hybridTop.n}/20 rated  (${hybridTop.high} were 4-5 stars)`);

  console.log("\n=== Bottom-20 mean rating ===");
  console.log(`  lyric:    mean=${lyricBot.mean.toFixed(2)}  n=${lyricBot.n}/20 rated  (${lyricBot.low} were 1-2 stars)`);
  console.log(`  existing: mean=${existingBot.mean.toFixed(2)}  n=${existingBot.n}/20 rated  (${existingBot.low} were 1-2 stars)`);
  console.log(`  hybrid:   mean=${hybridBot.mean.toFixed(2)}  n=${hybridBot.n}/20 rated  (${hybridBot.low} were 1-2 stars)`);

  // H2/H3 pass/fail
  const h2Pass = lyric.rho >= 0.20;
  const h3Pass = !isNaN(hybridTop.mean) && !isNaN(existingTop.mean) && hybridTop.mean - existingTop.mean >= 0.4;

  console.log("\n=== Hypothesis check ===");
  console.log(`  H1 (specificity/tone/emotion match) — graded by inspection in earlier stage`);
  console.log(`  H2 (lyric_rank rho ≥ 0.20):              ${h2Pass ? "PASS" : "FAIL"}  (rho=${lyric.rho.toFixed(3)})`);
  console.log(`  H3 (hybrid top-20 - existing top-20 ≥ 0.4): ${h3Pass ? "PASS" : "FAIL"}  (delta=${(hybridTop.mean - existingTop.mean).toFixed(2)})`);

  // Write results.md
  const md = buildResultsMarkdown({
    nRated: rated.length,
    nTotal: rankings.length,
    skipCount,
    lyric,
    existing,
    hybrid,
    lyricTop,
    existingTop,
    hybridTop,
    lyricBot,
    existingBot,
    hybridBot,
    h2Pass,
    h3Pass,
  });
  writeFileSync(RESULTS_PATH, md);
  console.log(`\nWrote ${RESULTS_PATH}`);
}

function buildResultsMarkdown(s: {
  nRated: number;
  nTotal: number;
  skipCount: number;
  lyric: { rho: number; n: number };
  existing: { rho: number; n: number };
  hybrid: { rho: number; n: number };
  lyricTop: { mean: number; n: number; high: number };
  existingTop: { mean: number; n: number; high: number };
  hybridTop: { mean: number; n: number; high: number };
  lyricBot: { mean: number; n: number; low: number };
  existingBot: { mean: number; n: number; low: number };
  hybridBot: { mean: number; n: number; low: number };
  h2Pass: boolean;
  h3Pass: boolean;
}): string {
  const targetN = 200;
  const undersampled = s.nRated < 0.75 * targetN;
  const directionalNote = undersampled
    ? `\n> **Note on power:** the plan called for ${targetN} blind ratings; this analysis uses ${s.nRated}. ` +
      `Treat these results as directional rather than final — the Spearman estimates have wider confidence intervals at this n, ` +
      `and rankings near the H2/H3 thresholds should be re-checked after additional ratings come in.\n`
    : "";

  return `# Lyric Analysis Experiment — Results

**Generated:** ${new Date().toISOString()}
**Rated:** ${s.nRated} / ${s.nTotal} candidates  (${s.skipCount} skipped, remainder unrated)
${directionalNote}
## Headline

| Hypothesis | Threshold | Result | Verdict |
|---|---|---|---|
| H2 — lyric ranking correlates with rating | ρ ≥ 0.20 | ρ = ${s.lyric.rho.toFixed(3)} | ${s.h2Pass ? "**PASS**" : "**FAIL**"} |
| H3 — hybrid top-20 beats existing top-20 by ≥ 0.4 stars | Δ ≥ 0.4 | Δ = ${(s.hybridTop.mean - s.existingTop.mean).toFixed(2)} | ${s.h3Pass ? "**PASS**" : "**FAIL**"} |

(H1 was graded by inspection on the 30-song stage-1 golden set and the 91-song production validation; not recomputed here.)

## Spearman rank correlations

Each ranking, when inverted so higher = better, correlated against the 1–5 blind ratings.

| Ranking | ρ | n |
|---|---|---|
| Lyric similarity | ${s.lyric.rho.toFixed(3)} | ${s.lyric.n} |
| Existing taste | ${s.existing.rho.toFixed(3)} | ${s.existing.n} |
| Hybrid (z-avg) | ${s.hybrid.rho.toFixed(3)} | ${s.hybrid.n} |

## Top-20 / bottom-20 means

| Ranking | Top-20 mean rating | Top-20 4-5★ | Bottom-20 mean rating | Bottom-20 1-2★ |
|---|---|---|---|---|
| Lyric similarity | ${s.lyricTop.mean.toFixed(2)} (n=${s.lyricTop.n}) | ${s.lyricTop.high} | ${s.lyricBot.mean.toFixed(2)} (n=${s.lyricBot.n}) | ${s.lyricBot.low} |
| Existing taste | ${s.existingTop.mean.toFixed(2)} (n=${s.existingTop.n}) | ${s.existingTop.high} | ${s.existingBot.mean.toFixed(2)} (n=${s.existingBot.n}) | ${s.existingBot.low} |
| Hybrid | ${s.hybridTop.mean.toFixed(2)} (n=${s.hybridTop.n}) | ${s.hybridTop.high} | ${s.hybridBot.mean.toFixed(2)} (n=${s.hybridBot.n}) | ${s.hybridBot.low} |

n is the rated subset of each top/bottom bucket. With ${s.nRated}/${s.nTotal} candidates rated, expect roughly ${Math.round(20 * s.nRated / s.nTotal)} of any 20-bucket to be rated.

## What this means for Phase 1

${decisionBlock(s.h2Pass, s.h3Pass)}
`;
}

function decisionBlock(h2: boolean, h3: boolean): string {
  if (h2 && h3) {
    return "**H2 and H3 both pass.** Green-light Phase 1 as designed in `PLAN_LYRICS_ANALYSIS_1.md` — full recommender with both ranker and transparency layer. The lyric-similarity centroid is adding signal beyond the existing taste model.";
  }
  if (h2 && !h3) {
    return "**H2 passes, H3 fails.** Lyric ranking correlates with rating but the hybrid ranking doesn't outperform the existing taste model on the top-20 mean. Ship Phase 1 as a *transparency layer only* — queryable analysis fields, \"Why this song?\" panel, lyric-vibe similarity widget — without the standalone ranker. Save the recommender complexity. The lyric-cost-gating question becomes much easier in this branch: only tracks that get queried/displayed earn analysis.";
  }
  if (!h2 && h3) {
    return "**H3 passes despite H2 failing.** Unusual — the hybrid is beating the existing system without lyric similarity itself correlating well. Likely a noise floor issue at this sample size. Re-check after more ratings before committing.";
  }
  return "**H2 and H3 both fail.** Lyric similarity isn't predicting taste at this sample size. Don't ship the recommender. The analysis fields are still queryable and the \"Why this song?\" panel may still be worth shipping on the obsession-tier subset, but the full $148 backfill is not justified. Consider redirecting to Phase 2 (audio enrichment) or shelving until something changes.";
}

main();
