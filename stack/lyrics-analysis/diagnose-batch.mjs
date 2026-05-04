/**
 * diagnose-batch.mjs — Inspect a completed batch result stream.
 *
 * Usage (inside container):
 *   node /app/inputs/diagnose-batch.mjs <batch_id>
 *
 * Counts entry types and prints samples of anything unexpected.
 */

import Anthropic from "@anthropic-ai/sdk";

const batchId = process.argv[2];
if (!batchId) {
  console.error("Usage: node diagnose-batch.mjs <batch_id>");
  process.exit(1);
}

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const counts = { total: 0, succeeded: 0, errored: 0, other_type: 0, missing_result: 0 };
const samples_missing = [];
const samples_other = [];

const resultsStream = await client.messages.batches.results(batchId);
for await (const entry of resultsStream) {
  counts.total++;

  if (!entry.result) {
    counts.missing_result++;
    if (samples_missing.length < 5) {
      samples_missing.push(JSON.stringify(entry).slice(0, 500));
    }
    continue;
  }

  const t = entry.result.type;
  if (t === "succeeded") {
    counts.succeeded++;
  } else if (t === "errored") {
    counts.errored++;
    if (samples_other.length < 3) {
      samples_other.push(JSON.stringify(entry).slice(0, 500));
    }
  } else {
    counts.other_type++;
    if (samples_other.length < 3) {
      samples_other.push(JSON.stringify(entry).slice(0, 500));
    }
  }
}

console.log("\n=== Batch Result Stream Diagnosis ===");
console.log(`Batch ID: ${batchId}`);
console.log(`Total entries:    ${counts.total}`);
console.log(`Succeeded:        ${counts.succeeded}`);
console.log(`Errored:          ${counts.errored}`);
console.log(`Other type:       ${counts.other_type}`);
console.log(`Missing 'result': ${counts.missing_result}`);

if (samples_missing.length > 0) {
  console.log("\n--- Samples: missing 'result' ---");
  samples_missing.forEach((s, i) => console.log(`  [${i}] ${s}`));
}
if (samples_other.length > 0) {
  console.log("\n--- Samples: errored / other ---");
  samples_other.forEach((s, i) => console.log(`  [${i}] ${s}`));
}
