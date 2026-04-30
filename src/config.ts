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
    defaultHours: [23, 24], // user reaches for sleep music at 23:30+ ET
    defaultDurationMin: 45,
    defaultOutput: "playlist",
    freshMultiplier: 0.2,
  },
  discover: {
    defaultHours: [0, 24], // any time — manually invoked
    defaultDurationMin: 45,
    defaultOutput: "queue",
    freshMultiplier: 100, // effectively forces 100% fresh via the arc
  },
};

/** Average track duration assumed for calculating track count from minutes */
export const AVG_TRACK_DURATION_MIN = 3.5;

/** How many recently-played tracks to avoid repeating */
export const RECENCY_AVOID_COUNT = 50;

/** Context multiplier clamp range */
export const CONTEXT_MULTIPLIER_MIN = 0.5;
export const CONTEXT_MULTIPLIER_MAX = 2.0;

/**
 * Non-overlapping time windows for acoustic profile centroid assignment (M17).
 * Used ONLY by src/audio/profile.ts — mode inference in modes.ts keeps its
 * own overlapping defaultHours and scoring logic unchanged.
 *
 * Each entry: [startHour, endHour, weekdaysOnly?]
 * When start > end, the window wraps midnight: [start, 24) ∪ [0, end).
 * driving and brainstorming: session-assignment only, no time window.
 */
export const CENTROID_HOUR_WINDOWS: Record<string, [number, number, boolean?]> = {
  waking_up: [6, 9],
  working:   [9, 18, true],
  unwinding: [18, 23],
  sleeping:  [23, 6],  // wraps midnight — user reaches for sleep music at 23:30+ ET
};

/** Minimum sample size for a centroid to be considered trained */
export const ACOUSTIC_PROFILE_MIN_SAMPLES = 10;

/** Acoustic fit multiplier clamp range (M20) */
export const ACOUSTIC_FIT_MIN = 0.7;
export const ACOUSTIC_FIT_MAX = 1.4;

/** Discovery: fraction of fresh_pool reserved for editorial sources */
export const EDITORIAL_RESERVED_RATIO = 0.3;

/** Audio features backfill (M16) */
export const AUDIO_BACKFILL_BATCH_SIZE = 40; // ReccoBeats max per request is 40
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
