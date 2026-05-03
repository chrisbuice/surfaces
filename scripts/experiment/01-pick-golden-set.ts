/**
 * 01-pick-golden-set.ts
 *
 * Validates that all URIs in golden-set.json exist in track_lyrics with status='ok'.
 * Fetches lyrics_plain for each and writes to golden-set-with-lyrics.json for
 * use in the analysis stage.
 *
 * Usage: npx tsx 01-pick-golden-set.ts
 * Requires: CF_API_TOKEN, CF_ACCOUNT_ID, CF_D1_DATABASE_ID in .env
 */

// TODO: implement
// 1. Read golden-set.json
// 2. For each URI, query track_lyrics for lyrics_plain
// 3. Validate all have lyrics
// 4. Write golden-set-with-lyrics.json (adds lyrics_plain field)

export {};
