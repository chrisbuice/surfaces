/**
 * facts.ts — Hardcoded fact ladder (fallback) and LLM fact generation
 * with validation.
 */

import type { TrackRipple } from "./scoring";

export interface FactInput {
  track_name: string;
  artist_name: string;
  lifetime_plays: number;
  plays_in_window: number;
  weighted_recent_plays: number;
  first_play_ts: number | null;
  last_play_before_window_ts: number | null;
  artist_lifetime_plays: number;
  artist_percentile: number;
  is_new_arrival: boolean;
  window_end: number; // unix seconds
  /** Artist's lifetime plays before this snapshot window (0 = brand new artist) */
  artist_plays_before_window: number;
  /** Track's lifetime plays before this window */
  track_plays_before_window: number;
  /** Average weekly play rate for this track over its lifetime (before window) */
  avg_weekly_rate: number;
}

/**
 * Hardcoded fact ladder. Priority order, first match wins.
 * Returns a short string (always ≤12 words, ≤80 chars).
 */
export function pickHardcodedFact(input: FactInput): string {
  const DAY = 86400;

  // 1. New artist (never heard before this window)
  if (input.artist_plays_before_window === 0) {
    return `first time hearing ${input.artist_name}`;
  }

  // 2. New track from known artist (track had ≤2 plays before window)
  if (input.track_plays_before_window <= 2) {
    return `new from ${input.artist_name}`;
  }

  // 3. Returning after >1 year gap
  if (input.last_play_before_window_ts !== null) {
    const gapDays = (input.window_end - input.last_play_before_window_ts) / DAY;
    if (gapDays > 365) {
      const years = Math.floor(gapDays / 365);
      return `returning after ${years} ${years === 1 ? "year" : "years"}`;
    }
  }

  // 4. Sudden spike (recent plays >= 5x average weekly rate)
  if (input.avg_weekly_rate > 0 && input.plays_in_window >= 5 * input.avg_weekly_rate) {
    const before = input.track_plays_before_window;
    return `${input.plays_in_window} plays this week, ${before} before`;
  }

  // 5. Fallback
  return `${input.plays_in_window} plays in the last two weeks`;
}

// --- LLM fact validation ---

const BLOCKED_PHRASES = [
  /you'?re really into/i,
  /great pick/i,
  /trending now/i,
  /on repeat/i,
  /can'?t stop listening/i,
  /obsessed with/i,
  /banger/i,
  /slaps/i,
  /fire/i,
  /vibes/i,
];

/**
 * Validate an LLM-generated fact string.
 * Returns { valid: true } or { valid: false, reason: string }.
 */
export function validateLLMFact(fact: string): { valid: boolean; reason?: string } {
  // Word count
  const words = fact.trim().split(/\s+/);
  if (words.length > 12) {
    return { valid: false, reason: `too many words (${words.length})` };
  }

  // Character count
  if (fact.length > 80) {
    return { valid: false, reason: `too long (${fact.length} chars)` };
  }

  // No quotation marks
  if (/[""\u201C\u201D]/.test(fact)) {
    return { valid: false, reason: "contains quotation marks" };
  }

  // No emoji
  if (/[\u{1F600}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u.test(fact)) {
    return { valid: false, reason: "contains emoji" };
  }

  // Trailing punctuation: only period allowed
  const trimmed = fact.trim();
  if (trimmed.length > 0) {
    const lastChar = trimmed[trimmed.length - 1];
    if (/[!?;:,]/.test(lastChar)) {
      return { valid: false, reason: `bad trailing punctuation: ${lastChar}` };
    }
  }

  // Blocked phrases
  for (const re of BLOCKED_PHRASES) {
    if (re.test(fact)) {
      return { valid: false, reason: `blocked phrase: ${re.source}` };
    }
  }

  return { valid: true };
}

/**
 * Derive artist relationship tier from pre-window play count.
 * Three tiers validated against actual library distribution:
 *   0 plays → "brand new" (~new discoveries)
 *   1–49   → "trace history" (~11,566 artists, long-tail)
 *   50+    → "established" (~964 artists, top 8%)
 */
export function getArtistRelationship(artistPreWindowPlays: number): string {
  if (artistPreWindowPlays === 0) return "brand new";
  if (artistPreWindowPlays < 50) return "trace history";
  return "established";
}

/**
 * Build the LLM prompt for generating a fact about a rippling track.
 */
export function buildFactPrompt(input: FactInput): { system: string; user: string } {
  const system = `You write one short phrase describing why a friend is playing a specific track right now. You know this friend's full listening history. Be specific to the data. Never generic, never complimentary.

CRITICAL — artist relationship context:
- If artist_relationship is "brand new": you may say "discovered" or "first time hearing" the artist.
- If artist_relationship is "trace history": soft framing — do NOT say "discovered" and do NOT say "long-loved." The listener has barely encountered this artist before.
- If artist_relationship is "established": NEVER frame as discovering the artist. The story is about the TRACK, not the artist. What's notable is why THIS track is getting heavy play right now — is it new? returning? spiking?

VARIETY — pick the most specific angle available:
- If there's a gap (days_since_last_play_before_window), lead with the return.
- If the play count is dramatic (e.g., 20+ in a week), lead with the number.
- If the track is brand new but the artist is established, frame as "new [artist] track" territory.
- If nothing else stands out, describe the listening pattern.
- Do NOT default to "discovered X days ago" unless the artist is genuinely brand new.

Format: exactly one phrase, 6–10 words (hard cap 12). No emoji, no quotation marks. End with a period or no punctuation. Use sentence case: capitalize the first word of each fact and all proper nouns (artists, song titles, places). Do not use all-lowercase.

Examples of good output:
- First Big Thief track to actually stick.
- Back after a two-year gap.
- 9 plays since Tuesday, was background before.
- New T.I. track, immediately on heavy rotation.
- 24 plays in eight days, came from nowhere.
- Quiet Kevin Morby deep cut finally clicked.`;

  const daysSinceFirstPlay = input.first_play_ts
    ? Math.floor((input.window_end - input.first_play_ts) / 86400)
    : null;

  const daysSinceLastPreWindow = input.last_play_before_window_ts
    ? Math.floor((input.window_end - input.last_play_before_window_ts) / 86400)
    : null;

  const data = {
    track: input.track_name,
    artist: input.artist_name,
    lifetime_plays: input.lifetime_plays,
    plays_last_14_days: input.plays_in_window,
    weighted_breakdown: {
      days_1_to_3_weight: 3.0,
      days_4_to_7_weight: 2.0,
      days_8_to_14_weight: 1.0,
      weighted_total: input.weighted_recent_plays,
    },
    days_since_first_play: daysSinceFirstPlay,
    days_since_last_play_before_window: daysSinceLastPreWindow,
    artist_lifetime_plays: input.artist_lifetime_plays,
    artist_plays_before_window: input.artist_plays_before_window,
    track_plays_before_window: input.track_plays_before_window,
    artist_percentile_rank: Math.round(input.artist_percentile),
    artist_relationship: getArtistRelationship(input.artist_plays_before_window),
    classification: input.is_new_arrival ? "new_arrival" : "returning_wave",
  };

  const user = JSON.stringify(data, null, 2);

  return { system, user };
}
