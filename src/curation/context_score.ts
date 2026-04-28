/**
 * context_score.ts — blend cold-start rules with learned affinities
 * into a context multiplier for each track.
 *
 * final_score(track) = taste_score × mode_weight × Π(context_multipliers)
 *
 * For each context dimension, if learned affinity has sample_size >= 5,
 * use the learned multiplier. Otherwise, use the cold-start rule.
 * This lets learned behavior gradually take over as data accumulates.
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

interface LearnedAffinity {
  dimension: string;
  bucket: string;
  affinity: number;
  sample_size: number;
}

export interface ScoredContext {
  multiplier: number;
  biases: ContextBias[];
}

/**
 * Compute the context multiplier for a single track.
 * Blends cold-start rules with learned affinities by sample size.
 */
export function computeContextMultiplier(
  snapshot: ContextSnapshot,
  mode: string,
  track: TrackForContext,
  learnedAffinities?: LearnedAffinity[]
): ScoredContext {
  const coldStartBiases = getColdStartBiases(snapshot, mode, {
    playCount: track.play_count,
    skipCount: track.skip_count,
    completeCount: track.complete_count,
    lastPlayedHour: track.last_played_hour,
    seasonalPlaylistCount: track.seasonal_playlist_count,
    currentSeasonPresent: track.current_season_present === true || (track.current_season_present as unknown as number) === 1,
    albumId: track.album_id,
  });

  const finalBiases: ContextBias[] = [];

  // Build a lookup of learned affinities by dimension
  const learnedMap = new Map<string, LearnedAffinity>();
  if (learnedAffinities) {
    for (const a of learnedAffinities) {
      learnedMap.set(`${a.dimension}:${a.bucket}`, a);
    }
  }

  // For each cold-start bias, check if we have a learned affinity that should replace it
  const processedDimensions = new Set<string>();
  for (const bias of coldStartBiases) {
    const key = `${bias.dimension}:${bias.bucket}`;
    const learned = learnedMap.get(key);

    if (learned && learned.sample_size >= 5) {
      // Learned affinity has enough data — use it instead of cold-start
      finalBiases.push({
        dimension: bias.dimension,
        bucket: bias.bucket,
        multiplier: learned.affinity,
        reason: `Learned: ${bias.dimension}=${bias.bucket} (n=${learned.sample_size}, affinity=${learned.affinity.toFixed(2)})`,
      });
    } else {
      // Not enough learned data — keep cold-start rule
      finalBiases.push(bias);
    }
    processedDimensions.add(key);
  }

  // Also apply any learned affinities for dimensions that don't have cold-start rules
  // (e.g., the user plays certain tracks at specific locations we didn't code rules for)
  if (learnedAffinities) {
    for (const a of learnedAffinities) {
      const key = `${a.dimension}:${a.bucket}`;
      if (!processedDimensions.has(key) && a.sample_size >= 5 && Math.abs(a.affinity - 1.0) > 0.05) {
        // Match against current snapshot
        const snapshotValue = getSnapshotValue(snapshot, a.dimension);
        if (snapshotValue !== null && String(snapshotValue) === a.bucket) {
          finalBiases.push({
            dimension: a.dimension,
            bucket: a.bucket,
            multiplier: a.affinity,
            reason: `Learned: ${a.dimension}=${a.bucket} (n=${a.sample_size}, affinity=${a.affinity.toFixed(2)})`,
          });
        }
      }
    }
  }

  // Product of all multipliers, clamped
  let product = 1.0;
  for (const bias of finalBiases) {
    product *= bias.multiplier;
  }
  product = Math.max(CONTEXT_MULTIPLIER_MIN, Math.min(CONTEXT_MULTIPLIER_MAX, product));

  return { multiplier: product, biases: finalBiases };
}

/** Get the value of a snapshot field by dimension name */
function getSnapshotValue(snapshot: ContextSnapshot, dimension: string): string | number | null {
  switch (dimension) {
    case "daylight_phase": return snapshot.daylightPhase;
    case "weather_condition": return snapshot.weatherCondition;
    case "location_label": return snapshot.locationLabel;
    case "device_type": return snapshot.deviceType;
    case "day_of_week": return snapshot.dayOfWeek;
    case "calendar_category": return snapshot.calendarEventCategory;
    default: return null;
  }
}

/**
 * Summarize which biases were applied across all tracks in a session.
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
