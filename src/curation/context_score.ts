/**
 * context_score.ts — blend cold-start rules (and later learned affinities)
 * into a context multiplier for each track.
 *
 * final_score(track) = taste_score × mode_weight × Π(context_multipliers)
 *
 * Multipliers are clamped to [CONTEXT_MULTIPLIER_MIN, CONTEXT_MULTIPLIER_MAX]
 * so context can nudge but never completely override taste.
 */

import { CONTEXT_MULTIPLIER_MIN, CONTEXT_MULTIPLIER_MAX } from "../config";
import { getColdStartBiases, type ContextBias } from "../context/rules";
import type { ContextSnapshot } from "../context/capture";

interface TrackForContext {
  track_id: string;
  play_count: number;
  skip_count: number;
  complete_count: number;
  last_played_hour: number | null;
  seasonal_playlist_count: number;
  current_season_present: boolean;
  album_id: string | null;
}

export interface ScoredContext {
  multiplier: number;
  biases: ContextBias[];
}

/**
 * Compute the context multiplier for a single track.
 * Returns the clamped product of all applicable biases.
 */
export function computeContextMultiplier(
  snapshot: ContextSnapshot,
  mode: string,
  track: TrackForContext
): ScoredContext {
  const biases = getColdStartBiases(snapshot, mode, {
    playCount: track.play_count,
    skipCount: track.skip_count,
    completeCount: track.complete_count,
    lastPlayedHour: track.last_played_hour,
    seasonalPlaylistCount: track.seasonal_playlist_count,
    currentSeasonPresent: track.current_season_present === true || (track.current_season_present as unknown as number) === 1,
    albumId: track.album_id,
  });

  // Product of all multipliers
  let product = 1.0;
  for (const bias of biases) {
    product *= bias.multiplier;
  }

  // Clamp
  product = Math.max(CONTEXT_MULTIPLIER_MIN, Math.min(CONTEXT_MULTIPLIER_MAX, product));

  return { multiplier: product, biases };
}

/**
 * Summarize which biases were applied across all tracks in a session.
 * Returns unique biases with counts.
 */
export function summarizeBiases(
  allBiases: ContextBias[]
): Array<{ dimension: string; bucket: string; reason: string; appliedToTracks: number; avgMultiplier: number }> {
  const grouped = new Map<string, { biases: ContextBias[]; count: number }>();

  for (const b of allBiases) {
    const key = `${b.dimension}:${b.bucket}`;
    const group = grouped.get(key) ?? { biases: [], count: 0 };
    group.biases.push(b);
    group.count++;
    grouped.set(key, group);
  }

  return Array.from(grouped.entries()).map(([, group]) => {
    const first = group.biases[0];
    const avgMult = group.biases.reduce((s, b) => s + b.multiplier, 0) / group.biases.length;
    return {
      dimension: first.dimension,
      bucket: first.bucket,
      reason: first.reason,
      appliedToTracks: group.count,
      avgMultiplier: Math.round(avgMult * 1000) / 1000,
    };
  });
}
