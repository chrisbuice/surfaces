/**
 * profile.ts — build acoustic preference centroids per mode.
 *
 * For each (mode, dimension), computes weighted mean and stddev from
 * play history joined with track_audio_features. Weights: completed=1.0,
 * replayed=1.5. Skipped/partial events excluded.
 *
 * Mode assignment priority:
 *   1. Session-based: if play_event has session_id, use the session's mode
 *   2. Time-inferred: match hour_of_day against CENTROID_HOUR_WINDOWS
 *   3. Fallback: event contributes to 'overall' only
 *
 * Full recompute each run (upsert all rows). Undertrained centroids
 * (sample_size < threshold) are stored with real values — M20 checks
 * sample_size at read time to decide fallback.
 */

import { CENTROID_HOUR_WINDOWS, ACOUSTIC_PROFILE_MIN_SAMPLES } from "../config";

const DIMENSIONS = [
  "acousticness", "danceability", "energy", "instrumentalness",
  "liveness", "loudness", "speechiness", "tempo", "valence",
] as const;

type Dimension = typeof DIMENSIONS[number];

interface WeightedEvent {
  mode: string;
  weight: number;
  features: Record<Dimension, number>;
}

export interface ProfileResult {
  modesComputed: string[];
  modesInsufficient: Array<{ mode: string; sampleSize: number }>;
  totalEvents: number;
}

export async function rebuildAcousticProfile(db: D1Database): Promise<ProfileResult> {
  const now = Math.floor(Date.now() / 1000);

  // ── Fetch all qualifying events with features ──
  const rows = await db.prepare(`
    SELECT pe.track_id, pe.classification, pe.hour_of_day, pe.day_of_week,
           pe.session_id, s.mode as session_mode,
           af.acousticness, af.danceability, af.energy, af.instrumentalness,
           af.liveness, af.loudness, af.speechiness, af.tempo, af.valence
    FROM play_events pe
    JOIN track_audio_features af ON af.track_id = pe.track_id
      AND af.acousticness IS NOT NULL
    LEFT JOIN sessions s ON s.session_id = pe.session_id
    WHERE pe.classification IN ('completed', 'replayed')
  `).all<{
    track_id: string; classification: string;
    hour_of_day: number; day_of_week: number;
    session_id: string | null; session_mode: string | null;
    acousticness: number; danceability: number; energy: number;
    instrumentalness: number; liveness: number; loudness: number;
    speechiness: number; tempo: number; valence: number;
  }>();

  // ── Assign each event to a mode ──
  const events: WeightedEvent[] = [];

  for (const r of rows.results) {
    const weight = r.classification === "replayed" ? 1.5 : 1.0;
    const features: Record<Dimension, number> = {
      acousticness: r.acousticness, danceability: r.danceability,
      energy: r.energy, instrumentalness: r.instrumentalness,
      liveness: r.liveness, loudness: r.loudness,
      speechiness: r.speechiness, tempo: r.tempo, valence: r.valence,
    };

    // Priority 1: session-based mode
    let mode: string | null = r.session_mode ?? null;

    // Priority 2: time-inferred from non-overlapping centroid windows
    // When start > end, the window wraps midnight: [start, 24) ∪ [0, end)
    if (!mode) {
      for (const [m, [start, end, weekdaysOnly]] of Object.entries(CENTROID_HOUR_WINDOWS)) {
        if (weekdaysOnly && (r.day_of_week === 0 || r.day_of_week === 6)) continue;
        const inWindow = start < end
          ? (r.hour_of_day >= start && r.hour_of_day < end)
          : (r.hour_of_day >= start || r.hour_of_day < end);
        if (inWindow) {
          mode = m;
          break;
        }
      }
    }

    // Named mode event
    if (mode) {
      events.push({ mode, weight, features });
    }

    // ALL completed/replayed events also contribute to 'overall'
    events.push({ mode: "overall", weight, features });
  }

  // ── Compute per-(mode, dimension) statistics ──
  // Group events by mode
  const byMode = new Map<string, WeightedEvent[]>();
  for (const ev of events) {
    const list = byMode.get(ev.mode) ?? [];
    list.push(ev);
    byMode.set(ev.mode, list);
  }

  const batch: D1PreparedStatement[] = [];
  const modesComputed: string[] = [];
  const modesInsufficient: Array<{ mode: string; sampleSize: number }> = [];

  for (const [mode, modeEvents] of byMode) {
    const sampleSize = modeEvents.length;

    for (const dim of DIMENSIONS) {
      // Weighted mean
      let sumW = 0, sumWX = 0;
      for (const ev of modeEvents) {
        sumW += ev.weight;
        sumWX += ev.weight * ev.features[dim];
      }
      const mean = sumW > 0 ? sumWX / sumW : 0;

      // Weighted stddev
      let sumWD2 = 0;
      for (const ev of modeEvents) {
        const d = ev.features[dim] - mean;
        sumWD2 += ev.weight * d * d;
      }
      const stddev = sumW > 0 ? Math.sqrt(sumWD2 / sumW) : 0;

      batch.push(
        db.prepare(`
          INSERT INTO acoustic_profile (mode, dimension, mean, stddev, sample_size, refreshed_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(mode, dimension) DO UPDATE SET
            mean = excluded.mean, stddev = excluded.stddev,
            sample_size = excluded.sample_size, refreshed_at = excluded.refreshed_at
        `).bind(mode, dim, Math.round(mean * 10000) / 10000, Math.round(stddev * 10000) / 10000, sampleSize, now)
      );
    }

    if (sampleSize >= ACOUSTIC_PROFILE_MIN_SAMPLES) {
      modesComputed.push(mode);
    } else {
      modesInsufficient.push({ mode, sampleSize });
    }
  }

  // Write all rows in D1 batch chunks
  for (let i = 0; i < batch.length; i += 100) {
    await db.batch(batch.slice(i, i + 100));
  }

  return {
    modesComputed,
    modesInsufficient,
    totalEvents: rows.results.length,
  };
}
