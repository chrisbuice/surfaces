/**
 * overrides.ts — Curated acoustic profile overrides for specific modes.
 *
 * The learned profiles converge to near-identical centroids across modes
 * because the time-window assignment (e.g. 23:00–6:00 = sleeping) captures
 * all late-night listening, not just the intended activity. These overrides
 * replace the learned centroid with a curated target that matches the
 * intended vibe.
 *
 * Modes without overrides continue using the learned profile from
 * acoustic_profile table (working, discover) or fall back to 'overall'.
 *
 * stddev controls selectivity: smaller = stricter filtering.
 * A stddev of 0.10 means tracks 1σ away get a noticeable penalty.
 */

export interface CuratedCentroid {
  mean: number;
  stddev: number;
}

export type ModeOverride = Record<string, CuratedCentroid>;

/**
 * Sleeping: calm, quiet, slow. Think acoustic ballads, ambient, soft vocals.
 * Low energy, high acousticness, slow tempo, quiet, subdued mood.
 */
const sleeping: ModeOverride = {
  energy:           { mean: 0.25, stddev: 0.12 },
  acousticness:     { mean: 0.60, stddev: 0.20 },
  danceability:     { mean: 0.40, stddev: 0.12 },
  valence:          { mean: 0.30, stddev: 0.15 },
  tempo:            { mean: 90,   stddev: 15 },
  loudness:         { mean: -12,  stddev: 3 },
  instrumentalness: { mean: 0.15, stddev: 0.20 },
  speechiness:      { mean: 0.04, stddev: 0.03 },
  liveness:         { mean: 0.12, stddev: 0.10 },
};

/**
 * Waking up: empowering, energizing, excite me for the day.
 * High energy, high danceability, happy, loud, upbeat tempo.
 */
const waking_up: ModeOverride = {
  energy:           { mean: 0.78, stddev: 0.10 },
  acousticness:     { mean: 0.10, stddev: 0.10 },
  danceability:     { mean: 0.72, stddev: 0.10 },
  valence:          { mean: 0.65, stddev: 0.15 },
  tempo:            { mean: 120,  stddev: 15 },
  loudness:         { mean: -5.5, stddev: 2 },
  instrumentalness: { mean: 0.02, stddev: 0.05 },
  speechiness:      { mean: 0.06, stddev: 0.05 },
  liveness:         { mean: 0.18, stddev: 0.12 },
};

/**
 * Unwinding: relaxing after the day. Chill but not sleepy.
 * Lower energy, more acoustic, moderate tempo, warm mood.
 */
const unwinding: ModeOverride = {
  energy:           { mean: 0.40, stddev: 0.12 },
  acousticness:     { mean: 0.45, stddev: 0.18 },
  danceability:     { mean: 0.50, stddev: 0.12 },
  valence:          { mean: 0.42, stddev: 0.15 },
  tempo:            { mean: 105,  stddev: 15 },
  loudness:         { mean: -9,   stddev: 2.5 },
  instrumentalness: { mean: 0.08, stddev: 0.12 },
  speechiness:      { mean: 0.05, stddev: 0.04 },
  liveness:         { mean: 0.14, stddev: 0.10 },
};

/**
 * Driving: sing-along energy, road-trip feel. Familiar bangers.
 * High energy, high danceability, loud, uptempo.
 */
const driving: ModeOverride = {
  energy:           { mean: 0.75, stddev: 0.12 },
  acousticness:     { mean: 0.12, stddev: 0.10 },
  danceability:     { mean: 0.68, stddev: 0.12 },
  valence:          { mean: 0.55, stddev: 0.18 },
  tempo:            { mean: 118,  stddev: 18 },
  loudness:         { mean: -6,   stddev: 2.5 },
  instrumentalness: { mean: 0.02, stddev: 0.05 },
  speechiness:      { mean: 0.06, stddev: 0.05 },
  liveness:         { mean: 0.18, stddev: 0.12 },
};

/**
 * Brainstorming: contemplative, thought-provoking, not distracting.
 * Moderate energy, more acoustic/instrumental, mid-tempo, subdued vocals.
 * The kind of music that opens your mind without pulling focus.
 */
const brainstorming: ModeOverride = {
  energy:           { mean: 0.45, stddev: 0.12 },
  acousticness:     { mean: 0.38, stddev: 0.18 },
  danceability:     { mean: 0.45, stddev: 0.12 },
  valence:          { mean: 0.35, stddev: 0.15 },
  tempo:            { mean: 105,  stddev: 18 },
  loudness:         { mean: -9,   stddev: 2.5 },
  instrumentalness: { mean: 0.20, stddev: 0.20 },
  speechiness:      { mean: 0.04, stddev: 0.03 },
  liveness:         { mean: 0.12, stddev: 0.10 },
};

/**
 * Map of mode name → curated override.
 * Modes not in this map use the learned profile from acoustic_profile table.
 */
export const ACOUSTIC_OVERRIDES: Record<string, ModeOverride> = {
  sleeping,
  waking_up,
  unwinding,
  driving,
  brainstorming,
};

/**
 * Get the centroid for a mode. Returns the curated override if one exists,
 * otherwise returns null (caller should load from D1).
 */
export function getOverrideCentroid(mode: string): Map<string, { mean: number; stddev: number }> | null {
  const override = ACOUSTIC_OVERRIDES[mode];
  if (!override) return null;
  return new Map(Object.entries(override));
}
