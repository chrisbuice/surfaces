/**
 * affinity.ts — learned track-context affinities.
 *
 * Nightly cron rebuilds track_context_affinity from play_event_context.
 * For each (track, dimension, bucket), computes:
 *
 *   affinity = (plays_in_bucket / total_plays_of_track) /
 *              (plays_in_bucket_overall / total_plays_overall)
 *
 * Then smooths toward 1.0 based on sample size:
 *   smoothed = 1 + (affinity - 1) × min(1, sample_size / 10)
 *
 * Clamped to [0.5, 2.0].
 *
 * Dimensions: daylight_phase, weather_condition, location_label,
 *             device_type, day_of_week, calendar_category
 */

const DIMENSIONS: Array<{
  dimension: string;
  snapshotField: string;
}> = [
  { dimension: "daylight_phase", snapshotField: "daylight_phase" },
  { dimension: "weather_condition", snapshotField: "weather_condition" },
  { dimension: "location_label", snapshotField: "location_label" },
  { dimension: "device_type", snapshotField: "device_type" },
  { dimension: "day_of_week", snapshotField: "day_of_week" },
  { dimension: "calendar_category", snapshotField: "calendar_event_category" },
];

export async function rebuildAffinities(db: D1Database): Promise<{
  dimensionsProcessed: number;
  affinitiesWritten: number;
}> {
  const now = Math.floor(Date.now() / 1000);
  let affinitiesWritten = 0;
  let dimensionsProcessed = 0;

  // Get total play count across all context-linked events
  const totalResult = await db.prepare(`
    SELECT COUNT(*) as total FROM play_event_context
  `).first<{ total: number }>();
  const totalPlaysOverall = totalResult?.total ?? 0;

  if (totalPlaysOverall < 10) {
    // Not enough data to compute meaningful affinities
    return { dimensionsProcessed: 0, affinitiesWritten: 0 };
  }

  for (const { dimension, snapshotField } of DIMENSIONS) {
    dimensionsProcessed++;

    // Count plays per bucket for this dimension across all tracks
    const bucketTotals = await db.prepare(`
      SELECT cs.${snapshotField} as bucket, COUNT(*) as count
      FROM play_event_context pec
      JOIN context_snapshots cs ON cs.id = pec.context_snapshot_id
      WHERE cs.${snapshotField} IS NOT NULL
      GROUP BY cs.${snapshotField}
    `).all<{ bucket: string; count: number }>();

    const bucketTotalMap = new Map<string, number>();
    for (const row of bucketTotals.results) {
      bucketTotalMap.set(String(row.bucket), row.count);
    }

    // Count plays per (track, bucket) for this dimension
    const trackBucketCounts = await db.prepare(`
      SELECT pe.track_id, cs.${snapshotField} as bucket, COUNT(*) as count
      FROM play_event_context pec
      JOIN play_events pe ON pe.id = pec.play_event_id
      JOIN context_snapshots cs ON cs.id = pec.context_snapshot_id
      WHERE cs.${snapshotField} IS NOT NULL
        AND pe.classification IN ('completed', 'partial')
      GROUP BY pe.track_id, cs.${snapshotField}
    `).all<{ track_id: string; bucket: string; count: number }>();

    // Get total plays per track (across all contexts)
    const trackTotals = await db.prepare(`
      SELECT pe.track_id, COUNT(*) as total
      FROM play_event_context pec
      JOIN play_events pe ON pe.id = pec.play_event_id
      WHERE pe.classification IN ('completed', 'partial')
      GROUP BY pe.track_id
    `).all<{ track_id: string; total: number }>();

    const trackTotalMap = new Map<string, number>();
    for (const row of trackTotals.results) {
      trackTotalMap.set(row.track_id, row.total);
    }

    // Compute affinities
    const batch: D1PreparedStatement[] = [];
    for (const row of trackBucketCounts.results) {
      const bucketStr = String(row.bucket);
      const trackTotal = trackTotalMap.get(row.track_id) ?? 1;
      const bucketTotal = bucketTotalMap.get(bucketStr) ?? 1;

      // P(track in bucket) / P(bucket overall)
      const trackInBucket = row.count / trackTotal;
      const bucketOverall = bucketTotal / totalPlaysOverall;
      let affinity = bucketOverall > 0 ? trackInBucket / bucketOverall : 1.0;

      // Smooth toward 1.0 based on sample size
      const sampleSize = row.count;
      const smoothing = Math.min(1, sampleSize / 10);
      affinity = 1 + (affinity - 1) * smoothing;

      // Clamp
      affinity = Math.max(0.5, Math.min(2.0, affinity));

      batch.push(
        db.prepare(`
          INSERT INTO track_context_affinity (track_id, dimension, bucket, affinity, sample_size, refreshed_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(track_id, dimension, bucket) DO UPDATE SET
            affinity = excluded.affinity,
            sample_size = excluded.sample_size,
            refreshed_at = excluded.refreshed_at
        `).bind(row.track_id, dimension, bucketStr, affinity, sampleSize, now)
      );
    }

    // Execute in batches of 100
    for (let i = 0; i < batch.length; i += 100) {
      await db.batch(batch.slice(i, i + 100));
    }
    affinitiesWritten += batch.length;
  }

  return { dimensionsProcessed, affinitiesWritten };
}
