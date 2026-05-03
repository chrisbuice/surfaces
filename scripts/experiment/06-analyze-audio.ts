/**
 * 07-analyze-audio.ts (optional — Stage 4)
 *
 * Fetches Deezer 30-sec previews via ISRC, sends to Gemini 2.5 Flash
 * for vocal-delivery analysis. Tests H4 (does audio add signal beyond lyrics).
 *
 * Usage: npx tsx 07-analyze-audio.ts
 * Requires: GEMINI_API_KEY in .env
 *
 * Output: audio-features.jsonl in experiment directory
 */

// TODO: implement
// 1. Read obsession seeds + subset of candidates (130 total)
// 2. For each, look up ISRC from track_lyrics
// 3. Fetch Deezer preview URL via https://api.deezer.com/track/isrc:{isrc}
// 4. Download 30-sec MP3
// 5. Send to Gemini 2.5 Flash with audio-analysis prompt
// 6. Parse JSON: vocal delivery, perceived emotion, instrumental density, etc.
// 7. Write audio-features.jsonl

export {};
