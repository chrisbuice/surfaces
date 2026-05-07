/**
 * scoring.ts — Pure functions for ripple score, familiarity score, and
 * the New Arrivals / Returning Waves split.
 */

export interface PlayInWindow {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  ts: number; // unix seconds
}

export interface TrackRipple {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  ripple_score: number;
  lifetime_plays: number;
  plays_in_window: number;
  weighted_recent_plays: number;
  first_play_ts: number | null;
  last_play_before_window_ts: number | null;
}

export interface FamiliarityInput {
  artist_lifetime_plays: number;
  all_artists_plays: number[]; // sorted ascending — all artists' pre-window plays
  track_lifetime_plays: number;
  all_tracks_plays: number[]; // sorted ascending — all tracks' pre-window plays
}

export interface RippleWithFamiliarity extends TrackRipple {
  familiarity_score: number;
  album_art_url: string | null;
}

export interface SplitResult {
  new_arrivals: RippleWithFamiliarity[];
  returning_waves: RippleWithFamiliarity[];
}

/**
 * Compute the weighted ripple score for a single track.
 *
 * Weights:
 *   - Plays in last 3 days: 3.0
 *   - Plays in days 4–7: 2.0
 *   - Plays in days 8–14: 1.0
 *
 * Score = weighted_recent_plays / (lifetime_plays + 3)
 */
export function computeRippleScore(
  playsInWindow: number[],  // array of unix-second timestamps of plays within the 14-day window
  lifetimePlays: number,
  windowEnd: number,        // unix seconds — the "now" reference point
): { ripple_score: number; weighted_recent_plays: number; plays_in_window: number } {
  const DAY = 86400;
  let weighted = 0;

  for (const ts of playsInWindow) {
    const daysAgo = (windowEnd - ts) / DAY;
    if (daysAgo <= 3) {
      weighted += 3.0;
    } else if (daysAgo <= 7) {
      weighted += 2.0;
    } else {
      weighted += 1.0;
    }
  }

  const score = weighted / (lifetimePlays + 3);

  return {
    ripple_score: Math.round(score * 100) / 100,
    weighted_recent_plays: Math.round(weighted * 100) / 100,
    plays_in_window: playsInWindow.length,
  };
}

/**
 * Compute familiarity score (0–100) for a track.
 *
 * - Artist familiarity (62.5%): percentile rank of artist's pre-window plays.
 * - Track familiarity (37.5%): percentile rank of track's pre-window plays.
 *
 * The 62.5:37.5 ratio is the original 50:30 artist:track weighting
 * renormalized to sum to 100% after dropping the era component.
 */
export function computeFamiliarityScore(input: FamiliarityInput): number {
  const artistPercentile = percentileRank(input.all_artists_plays, input.artist_lifetime_plays);
  const trackPercentile = percentileRank(input.all_tracks_plays, input.track_lifetime_plays);

  const score = artistPercentile * 0.625 + trackPercentile * 0.375;
  return Math.round(score);
}

/**
 * Percentile rank: what percentage of values in the sorted array are
 * less than or equal to the given value. Returns 0–100.
 */
export function percentileRank(sortedValues: number[], value: number): number {
  if (sortedValues.length === 0) return 50;

  let count = 0;
  for (const v of sortedValues) {
    if (v <= value) count++;
    else break; // sorted, so we can stop early
  }

  return (count / sortedValues.length) * 100;
}

/**
 * Split the top 10 ripples into New Arrivals and Returning Waves.
 *
 * New Arrivals: first_play_ts within last 21 days (tunable threshold).
 * Returning Waves: everything else.
 *
 * Lifetime plays are intentionally not considered — Chris binge-listens
 * to new discoveries, so a track can hit 30 plays within days of first
 * hearing it.
 *
 * Each group sorted by ripple_score descending.
 */
export function splitArrivalsAndWaves(
  ripples: RippleWithFamiliarity[],
  windowEnd: number,
): SplitResult {
  const TWENTY_ONE_DAYS = 21 * 86400;
  const cutoff = windowEnd - TWENTY_ONE_DAYS;

  const new_arrivals: RippleWithFamiliarity[] = [];
  const returning_waves: RippleWithFamiliarity[] = [];

  for (const r of ripples) {
    const isNewArrival =
      r.first_play_ts !== null &&
      r.first_play_ts >= cutoff;

    if (isNewArrival) {
      new_arrivals.push(r);
    } else {
      returning_waves.push(r);
    }
  }

  new_arrivals.sort((a, b) => b.ripple_score - a.ripple_score);
  returning_waves.sort((a, b) => b.ripple_score - a.ripple_score);

  return { new_arrivals, returning_waves };
}
