/**
 * fit.ts — compute acoustic fit between a track and a mode centroid.
 *
 * Acoustic fit measures how well a track's audio features match the
 * statistical profile of what the user typically listens to in a given
 * mode. Used as a multiplier in curation scoring (M20).
 *
 * Formula:
 *   distance = Σ_d ((track_d - mean_d) / max(stddev_d, 0.05))²
 *   normalized = distance / 18     (9 dims × 1.4² ≈ 18)
 *   fit = 1.4 - 0.7 × normalized
 *   clamped to [ACOUSTIC_FIT_MIN, ACOUSTIC_FIT_MAX]
 *
 * Tracks with no audio features default to 1.0 (neutral).
 * Modes with insufficient sample_size fall back to 'overall' centroid.
 */

import { ACOUSTIC_FIT_MIN, ACOUSTIC_FIT_MAX } from "../config";

const DIMENSIONS = [
  "acousticness", "danceability", "energy", "instrumentalness",
  "liveness", "loudness", "speechiness", "tempo", "valence",
] as const;

type Dimension = typeof DIMENSIONS[number];

export interface AudioFeatureValues {
  acousticness: number;
  danceability: number;
  energy: number;
  instrumentalness: number;
  liveness: number;
  loudness: number;
  speechiness: number;
  tempo: number;
  valence: number;
}

export interface CentroidRow {
  dimension: string;
  mean: number;
  stddev: number;
  sample_size: number;
}

// Normalization constant: 9 dimensions × 1.4² stddevs ≈ 18
// A track 1.4σ out on every dimension hits the floor.
const NORMALIZATION = 18;
const STDDEV_FLOOR = 0.05;

/**
 * Compute acoustic fit multiplier for a track against a centroid.
 * Returns a value in [ACOUSTIC_FIT_MIN, ACOUSTIC_FIT_MAX].
 */
export function computeAcousticFit(
  features: AudioFeatureValues,
  centroid: Map<string, { mean: number; stddev: number }>
): number {
  let distance = 0;

  for (const dim of DIMENSIONS) {
    const c = centroid.get(dim);
    if (!c) continue;

    const value = features[dim];
    const stddev = Math.max(c.stddev, STDDEV_FLOOR);
    const z = (value - c.mean) / stddev;
    distance += z * z;
  }

  const normalized = distance / NORMALIZATION;
  const fit = ACOUSTIC_FIT_MAX - (ACOUSTIC_FIT_MAX - ACOUSTIC_FIT_MIN) * normalized;
  return Math.max(ACOUSTIC_FIT_MIN, Math.min(ACOUSTIC_FIT_MAX, fit));
}

/**
 * Identify which dimension contributes most to the fit/misfit.
 * Returns the dimension name and whether it's a positive or negative contributor.
 */
export function dominantDimension(
  features: AudioFeatureValues,
  centroid: Map<string, { mean: number; stddev: number }>
): { dimension: string; direction: "high" | "low" } | null {
  let maxZ2 = 0;
  let maxDim: string | null = null;
  let maxDirection: "high" | "low" = "high";

  for (const dim of DIMENSIONS) {
    const c = centroid.get(dim);
    if (!c) continue;

    const stddev = Math.max(c.stddev, STDDEV_FLOOR);
    const z = (features[dim] - c.mean) / stddev;
    const z2 = z * z;
    if (z2 > maxZ2) {
      maxZ2 = z2;
      maxDim = dim;
      maxDirection = z > 0 ? "high" : "low";
    }
  }

  return maxDim ? { dimension: maxDim, direction: maxDirection } : null;
}
