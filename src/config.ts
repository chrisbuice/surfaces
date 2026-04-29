/**
 * config.ts — mode definitions, tunable constants.
 *
 * Central place for all the knobs. Each mode has a default time window,
 * session duration, output type, and fresh-arc multiplier.
 */

export interface ModeConfig {
  defaultHours: [number, number]; // [start, end] in 24h local time
  defaultDurationMin: number;
  defaultOutput: "play_now" | "queue" | "playlist";
  freshMultiplier: number; // multiplied against the fresh side of the arc curve
  weekdaysOnly?: boolean;
}

export const MODES: Record<string, ModeConfig> = {
  waking_up: {
    defaultHours: [6, 10],
    defaultDurationMin: 30,
    defaultOutput: "play_now",
    freshMultiplier: 0.5,
  },
  working: {
    defaultHours: [9, 18],
    defaultDurationMin: 90,
    defaultOutput: "play_now",
    freshMultiplier: 0.8,
    weekdaysOnly: true,
  },
  driving: {
    defaultHours: [0, 24], // any time
    defaultDurationMin: 45,
    defaultOutput: "play_now",
    freshMultiplier: 0.3,
  },
  brainstorming: {
    defaultHours: [0, 24],
    defaultDurationMin: 60,
    defaultOutput: "queue",
    freshMultiplier: 1.5,
  },
  unwinding: {
    defaultHours: [19, 23],
    defaultDurationMin: 60,
    defaultOutput: "play_now",
    freshMultiplier: 0.6,
  },
  sleeping: {
    defaultHours: [21, 24],
    defaultDurationMin: 45,
    defaultOutput: "playlist",
    freshMultiplier: 0.2,
  },
};

/** Average track duration assumed for calculating track count from minutes */
export const AVG_TRACK_DURATION_MIN = 3.5;

/** How many recently-played tracks to avoid repeating */
export const RECENCY_AVOID_COUNT = 50;

/** Context multiplier clamp range */
export const CONTEXT_MULTIPLIER_MIN = 0.5;
export const CONTEXT_MULTIPLIER_MAX = 2.0;

/** Audio features backfill (M16) */
export const AUDIO_BACKFILL_BATCH_SIZE = 50;
export const AUDIO_NOT_FOUND_RESCAN_DAYS = 30;

/** Fresh arc: position → fresh ratio (before mode multiplier) */
export const FRESH_ARC: Array<[number, number]> = [
  [0.0, 0.0],   // start: 100% familiar
  [0.25, 0.1],  // warming up
  [0.5, 0.3],   // balanced
  [0.75, 0.5],  // exploration peak
  [0.9, 0.2],   // cool down
  [1.0, 0.0],   // end on something known
];

export const ALL_MODE_NAMES = Object.keys(MODES);
