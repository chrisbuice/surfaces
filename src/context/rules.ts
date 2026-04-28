/**
 * rules.ts — cold-start rule biases per §7 of the plan.
 *
 * These are conservative multipliers applied to track scores based on
 * the current context snapshot. They serve until learned affinities
 * (track_context_affinity) accumulate enough data to take over (M10).
 *
 * Key principle: soft biases only, never hard filters.
 * A wrong context guess produces a slightly-off session, not a broken one.
 */

import type { ContextSnapshot } from "./capture";

export interface ContextBias {
  dimension: string;   // e.g. "daylight_phase", "weather_condition"
  bucket: string;      // e.g. "night", "rain"
  multiplier: number;  // applied to track score
  reason: string;      // human-readable explanation
}

interface TrackSignals {
  playCount: number;
  skipCount: number;
  completeCount: number;
  lastPlayedHour: number | null;
  seasonalPlaylistCount: number;
  currentSeasonPresent: boolean;
  albumId: string | null;
}

/**
 * Compute cold-start context biases for a track given the current snapshot.
 * Returns an array of biases (one per applicable rule). The product of all
 * multipliers is the final context multiplier for this track.
 */
export function getColdStartBiases(
  snapshot: ContextSnapshot,
  mode: string,
  trackSignals: TrackSignals
): ContextBias[] {
  const biases: ContextBias[] = [];

  // ── Night + unwinding/sleeping: favor evening tracks ──
  if (
    snapshot.daylightPhase === "night" &&
    (mode === "unwinding" || mode === "sleeping")
  ) {
    // Favor tracks with low skip rate (comfort picks)
    if (trackSignals.playCount > 0) {
      const skipRate = trackSignals.skipCount / trackSignals.playCount;
      if (skipRate < 0.1) {
        biases.push({
          dimension: "daylight_phase",
          bucket: "night",
          multiplier: 1.15,
          reason: "Night + unwinding: favoring comfort tracks (low skip rate)",
        });
      }
    }
    // Slight penalty for tracks only played during work hours
    if (trackSignals.lastPlayedHour !== null &&
        trackSignals.lastPlayedHour >= 9 && trackSignals.lastPlayedHour <= 17) {
      biases.push({
        dimension: "daylight_phase",
        bucket: "night_work_penalty",
        multiplier: 0.9,
        reason: "Night: de-emphasizing tracks typically played during work hours",
      });
    }
  }

  // ── Morning / pre-dawn + waking_up: favor current season, shorter tracks ──
  if (
    (snapshot.daylightPhase === "pre_dawn" || snapshot.daylightPhase === "morning") &&
    mode === "waking_up"
  ) {
    if (trackSignals.currentSeasonPresent) {
      biases.push({
        dimension: "daylight_phase",
        bucket: "morning",
        multiplier: 1.2,
        reason: "Morning wakeup: favoring current-season playlist tracks",
      });
    }
  }

  // ── Rain / overcast: comfort weighting ──
  if (
    snapshot.weatherCondition === "rain" ||
    snapshot.weatherCondition === "overcast"
  ) {
    if (trackSignals.playCount > 0 && trackSignals.skipCount / trackSignals.playCount < 0.1) {
      biases.push({
        dimension: "weather_condition",
        bucket: snapshot.weatherCondition,
        multiplier: 1.1,
        reason: `${snapshot.weatherCondition}: comfort bias for low-skip tracks`,
      });
    }
  }

  // ── Hot summer day: favor summer seasonal tracks ──
  if (
    snapshot.weatherTempF !== null &&
    snapshot.weatherTempF > 80 &&
    snapshot.daylightPhase === "midday"
  ) {
    if (trackSignals.currentSeasonPresent) {
      biases.push({
        dimension: "weather_condition",
        bucket: "hot_midday",
        multiplier: 1.15,
        reason: "Hot midday: favoring current-season summer tracks",
      });
    }
  }

  // ── Cold weather: favor winter seasonal tracks ──
  if (snapshot.weatherTempF !== null && snapshot.weatherTempF < 35) {
    if (trackSignals.seasonalPlaylistCount > 0) {
      biases.push({
        dimension: "weather_condition",
        bucket: "cold",
        multiplier: 1.1,
        reason: "Cold weather: favoring seasonal playlist tracks",
      });
    }
  }

  // ── Speaker device (not driving): favor album-coherent picks ──
  // This is handled at the selection level, not per-track scoring.
  // We just note it as a bias for the debug output.
  if (snapshot.deviceType === "Speaker" && mode !== "driving") {
    biases.push({
      dimension: "device_type",
      bucket: "Speaker",
      multiplier: 1.0, // neutral — album coherence handled in selection
      reason: "Speaker: background listening context (album coherence preferred)",
    });
  }

  // ── Smartphone + in motion: driving signal ──
  if (snapshot.deviceType === "Smartphone" && snapshot.isInMotion === 1) {
    biases.push({
      dimension: "device_type",
      bucket: "mobile_moving",
      multiplier: 1.1,
      reason: "Mobile + in motion: driving-context bias for high-energy familiar tracks",
    });
    // Extra boost for high-play-count tracks (sing-along anchors)
    if (trackSignals.playCount >= 5) {
      biases.push({
        dimension: "device_type",
        bucket: "mobile_moving_familiar",
        multiplier: 1.1,
        reason: "Mobile + in motion: extra boost for frequently played tracks",
      });
    }
  }

  // ── Bluetooth = car: strong driving signal ──
  if (snapshot.bluetoothContext === "car") {
    biases.push({
      dimension: "bluetooth_context",
      bucket: "car",
      multiplier: 1.15,
      reason: "Car Bluetooth: driving-context bias",
    });
  }

  // ── Calendar: focus event ──
  if (snapshot.calendarEventCategory === "focus") {
    // Favor completed tracks (proven to not distract)
    if (trackSignals.completeCount > 2) {
      biases.push({
        dimension: "calendar_category",
        bucket: "focus",
        multiplier: 1.15,
        reason: "Focus block: favoring tracks with high completion rate",
      });
    }
  }

  // ── Calendar: workout ──
  if (snapshot.calendarEventCategory === "workout") {
    // Lean on top tracks (short-term) — these are familiar, high-energy
    if (trackSignals.playCount >= 3) {
      biases.push({
        dimension: "calendar_category",
        bucket: "workout",
        multiplier: 1.1,
        reason: "Workout: favoring frequently played tracks",
      });
    }
  }

  return biases;
}
