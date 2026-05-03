/**
 * 03-embed-voyage.ts
 *
 * Embeds lyrics_plain and analysis text for all analyzed songs using Voyage-3.5-lite.
 * Outputs Float32Array BLOBs to the embeddings/ directory.
 *
 * Usage: npx tsx 03-embed-voyage.ts
 * Requires: VOYAGE_API_KEY in .env
 *
 * Output: embeddings/lyrics-{uri_id}.bin, embeddings/analysis-{uri_id}.bin
 */

// TODO: implement
// 1. Read analyses.jsonl (the winning model's output)
// 2. For each song, embed: (a) lyrics_plain, (b) subject_paragraph + tones + emotion JSON
// 3. Write Float32Array(512) to bin files
// 4. Batch in chunks of 128 (Voyage limit)

export {};
