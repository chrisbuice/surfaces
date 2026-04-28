/**
 * modes.ts — mode selection logic.
 *
 * If the user specifies a mode, use it. Otherwise infer from current
 * hour of day using mode time windows. In the future this will also
 * use mode_profiles.hour_distribution from D1 for learned inference.
 */

import { MODES, ALL_MODE_NAMES } from "../config";

const USER_TZ = "America/New_York";

/** Infer the best mode for the current time */
export function inferMode(): string {
  const now = new Date();
  const localTime = new Date(now.toLocaleString("en-US", { timeZone: USER_TZ }));
  const hour = localTime.getHours();
  const dayOfWeek = localTime.getDay(); // 0=Sun
  const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;

  // Score each mode by how well the current hour fits its window
  let bestMode = "working"; // fallback
  let bestScore = -1;

  for (const [modeName, config] of Object.entries(MODES)) {
    let score = 0;
    const [startHour, endHour] = config.defaultHours;

    if (hour >= startHour && hour < endHour) {
      // Inside the mode's window — base score
      score = 10;

      // Prefer weekday-only modes on weekdays
      if (config.weekdaysOnly && isWeekday) {
        score += 2;
      } else if (config.weekdaysOnly && !isWeekday) {
        score -= 5; // penalize working mode on weekends
      }

      // Prefer narrower windows (more specific)
      const windowSize = endHour - startHour;
      if (windowSize < 24) {
        score += (24 - windowSize) / 6;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestMode = modeName;
    }
  }

  return bestMode;
}

/** Resolve the mode: use explicit if given, otherwise infer */
export function resolveMode(explicit?: string | null): string {
  if (explicit && ALL_MODE_NAMES.includes(explicit)) {
    return explicit;
  }
  return inferMode();
}
