/**
 * arc.ts — position-based freshness curve.
 *
 * Controls how much fresh-pool content appears at each position in a session.
 * The curve starts familiar, peaks in exploration around 75%, and ends known.
 *
 * Each mode has a freshMultiplier that scales the fresh side of the curve:
 *   - sleeping (0.2): almost no fresh
 *   - driving (0.3): very little fresh
 *   - waking_up (0.5): gentle fresh
 *   - unwinding (0.6): moderate fresh
 *   - working (0.8): fair amount of fresh
 *   - brainstorming (1.5): lots of fresh (capped at 0.7)
 */

import { FRESH_ARC } from "../config";

/**
 * Get the fresh ratio at a given position in the session.
 * @param position - 0.0 to 1.0, where 0 is first track and 1 is last
 * @param modeMultiplier - from config.ts, scales the fresh ratio
 * @returns probability (0-1) that this position should be a fresh track
 */
export function getFreshRatio(position: number, modeMultiplier: number): number {
  // Clamp position
  position = Math.max(0, Math.min(1, position));

  // Interpolate the base fresh ratio from the arc curve
  let baseFresh = 0;
  for (let i = 0; i < FRESH_ARC.length - 1; i++) {
    const [pos1, ratio1] = FRESH_ARC[i];
    const [pos2, ratio2] = FRESH_ARC[i + 1];
    if (position >= pos1 && position <= pos2) {
      const t = (position - pos1) / (pos2 - pos1);
      baseFresh = ratio1 + t * (ratio2 - ratio1);
      break;
    }
  }

  // Apply mode multiplier and cap at 0.7
  const adjusted = Math.min(baseFresh * modeMultiplier, 0.7);
  return adjusted;
}

/**
 * Decide whether a given position should be fresh or familiar.
 * Uses weighted random based on the fresh ratio.
 */
export function shouldBeFresh(position: number, modeMultiplier: number): boolean {
  const ratio = getFreshRatio(position, modeMultiplier);
  return Math.random() < ratio;
}
