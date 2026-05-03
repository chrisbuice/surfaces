/**
 * 04-rank.ts
 *
 * Computes three rankings of the 200 unheard candidates:
 *   1. lyric_rank — cosine(candidate analysis embedding, obsession centroid)
 *   2. existing_rank — play_count-based affinity (proxy for taste model)
 *   3. hybrid_rank — z-normalized average of both
 *
 * Usage: npx tsx 04-rank.ts
 *
 * Output: rankings.csv (URI, lyric_rank, existing_rank, hybrid_rank, blind_rating placeholder)
 */

// TODO: implement
// 1. Load obsession seed embeddings, compute centroid (mean)
// 2. Load candidate embeddings
// 3. Compute cosine similarity for each candidate → lyric_rank
// 4. Load play counts → existing_rank (or taste_score from D1)
// 5. Z-normalize both, average → hybrid_rank
// 6. Write rankings.csv

export {};
