/**
 * queue.ts — Smart queue generation engine.
 *
 * Generates ranked candidate lists using recency-weighted affinity,
 * never-stale-core boosts, skip exclusion, and mode-specific filtering.
 */

import type { QueueCandidate, QueueResult } from "./types";
import { getTrackAffinity, getLostFavorites, getSkipPenalizedTracks } from "./queries";
import neverStaleCoreData from "./data/never_stale_core.json";
import erasData from "./data/eras.json";

const NEVER_STALE_ARTISTS = new Set(neverStaleCoreData.map((a) => a.artist));
const NEVER_STALE_BOOST = 1.15;
const MAX_PER_ARTIST = 3;
const LOST_FAVORITES_MIX = 0.3;
const AVG_TRACK_MINUTES = 3.5;

interface GenerateQueueOptions {
  mode: "rediscover" | "era" | "morning" | "default";
  seed?: string;
  lengthMin: number;
  eraName?: string;
}

/**
 * Generate a smart queue of tracks.
 */
export async function generateQueue(
  db: D1Database,
  options: GenerateQueueOptions,
): Promise<QueueResult> {
  const { mode, seed, lengthMin, eraName } = options;
  const targetTracks = Math.ceil(lengthMin / AVG_TRACK_MINUTES);

  // Get skip-penalized tracks (≥3 fwdbtn within 30s in past 30 days)
  const penalized = await getSkipPenalizedTracks(db, 3, 30);

  // Get track affinity candidates (fetch more than needed for filtering)
  const candidatePool = await getTrackAffinity(db, targetTracks * 8);

  // Apply never-stale-core boost
  for (const c of candidatePool) {
    if (NEVER_STALE_ARTISTS.has(c.name.split(" - ")[0])) {
      // name is track name, we need artist — but affinity rows don't have artist in the name field
      // We'll handle this via the uri lookup below
    }
  }

  // Build enriched candidates with artist info
  // We need artist names — fetch them from D1
  const enriched: (QueueCandidate & { avgMinutes: number })[] = [];

  for (const c of candidatePool) {
    if (!c.uri) continue;

    // Skip penalized tracks (unless explicitly seeded)
    if (penalized.has(c.uri) && c.uri !== seed) continue;

    // Get artist name for this track
    const trackInfo = await db.prepare(
      "SELECT artist_name, AVG(minutes) as avg_min FROM plays WHERE spotify_track_uri = ? LIMIT 1",
    ).bind(c.uri).first<{ artist_name: string; avg_min: number }>();

    if (!trackInfo) continue;

    const isCore = NEVER_STALE_ARTISTS.has(trackInfo.artist_name);
    const boostedAffinity = isCore ? c.affinity * NEVER_STALE_BOOST : c.affinity;

    let reason = "high recent affinity";
    if (isCore) {
      const coreEntry = neverStaleCoreData.find((a) => a.artist === trackInfo.artist_name);
      reason = `never-stale core (${coreEntry?.years_in_top50 ?? "?"} yrs in top-50)`;
    }

    enriched.push({
      uri: c.uri,
      track: c.name,
      artist: trackInfo.artist_name,
      reason,
      affinityScore: Math.round(boostedAffinity * 100) / 100,
      isNeverStaleCore: isCore,
      avgMinutes: trackInfo.avg_min ?? AVG_TRACK_MINUTES,
    });
  }

  // Apply mode-specific filtering
  let filtered = enriched;

  if (mode === "era" && eraName) {
    const era = erasData.find((e) => e.name === eraName);
    if (era) {
      const eraYears = new Set(era.years);
      // Filter to tracks that have plays in the era's year range
      const eraUris = new Set<string>();
      for (const c of filtered) {
        const hasEraPlay = await db.prepare(
          "SELECT 1 FROM plays WHERE spotify_track_uri = ? AND year IN (" +
          era.years.map(() => "?").join(",") + ") LIMIT 1",
        ).bind(c.uri, ...era.years).first();
        if (hasEraPlay) eraUris.add(c.uri);
      }
      filtered = filtered.filter((c) => eraUris.has(c.uri));
      filtered.forEach((c) => { if (c.reason === "high recent affinity") c.reason = `era match: ${eraName}`; });
    }
  }

  if (mode === "morning") {
    // Re-weight by morning plays (local_hour 6-10)
    for (const c of filtered) {
      const morningCount = await db.prepare(
        "SELECT COUNT(*) as cnt FROM plays WHERE spotify_track_uri = ? AND local_hour BETWEEN 6 AND 10",
      ).bind(c.uri).first<{ cnt: number }>();
      const morningWeight = morningCount?.cnt ?? 0;
      if (morningWeight > 0) {
        c.affinityScore *= (1 + morningWeight * 0.1);
        c.reason = "morning pattern";
      }
    }
    filtered.sort((a, b) => b.affinityScore - a.affinityScore);
  }

  // Seed filtering
  if (seed) {
    // If seed is a track URI, prioritize tracks by the same artist
    if (seed.startsWith("spotify:track:")) {
      const seedArtist = await db.prepare(
        "SELECT artist_name FROM plays WHERE spotify_track_uri = ? LIMIT 1",
      ).bind(seed).first<{ artist_name: string }>();
      if (seedArtist) {
        // Boost same-artist tracks
        filtered.forEach((c) => {
          if (c.artist === seedArtist.artist_name) {
            c.affinityScore *= 1.3;
            if (c.reason === "high recent affinity") c.reason = "seed companion";
          }
        });
        filtered.sort((a, b) => b.affinityScore - a.affinityScore);
      }
    } else {
      // Seed is an artist name — boost that artist
      filtered.forEach((c) => {
        if (c.artist.toLowerCase() === seed.toLowerCase()) {
          c.affinityScore *= 1.3;
          if (c.reason === "high recent affinity") c.reason = "seed companion";
        }
      });
      filtered.sort((a, b) => b.affinityScore - a.affinityScore);
    }
  }

  // Mix in lost favorites for rediscover mode
  let lostFavCandidates: QueueCandidate[] = [];
  if (mode === "rediscover") {
    const lostFavs = await getLostFavorites(db, 20, 2, targetTracks);
    lostFavCandidates = lostFavs
      .filter((lf) => !penalized.has(lf.uri))
      .map((lf) => ({
        uri: lf.uri,
        track: lf.track,
        artist: lf.artist,
        reason: `lost favorite, last heard ${lf.lastPlayed.substring(0, 7)}`,
        affinityScore: lf.lifetimePlays, // use lifetime plays as proxy score
        isNeverStaleCore: NEVER_STALE_ARTISTS.has(lf.artist),
      }));
  }

  // Build final queue with artist dedup (max 3 per artist)
  const artistCounts: Record<string, number> = {};
  const queue: QueueCandidate[] = [];
  let totalMinutes = 0;

  // For rediscover mode, interleave lost favorites at ~30%
  const lostSlots = mode === "rediscover"
    ? Math.round(targetTracks * LOST_FAVORITES_MIX)
    : 0;
  const regularSlots = targetTracks - lostSlots;

  // In rediscover mode, exclude lost-favorite URIs from the regular pool
  // so they don't get duplicated when we interleave them later
  const lostFavUris = new Set(lostFavCandidates.map((lf) => lf.uri));

  // Add regular affinity tracks
  for (const c of filtered) {
    if (queue.length >= regularSlots) break;
    if (lostFavUris.has(c.uri)) continue;
    const count = artistCounts[c.artist] ?? 0;
    if (count >= MAX_PER_ARTIST) continue;
    artistCounts[c.artist] = count + 1;
    queue.push({
      uri: c.uri,
      track: c.track,
      artist: c.artist,
      reason: c.reason,
      affinityScore: c.affinityScore,
      isNeverStaleCore: c.isNeverStaleCore,
    });
    totalMinutes += (c as { avgMinutes?: number }).avgMinutes ?? AVG_TRACK_MINUTES;
  }

  // Interleave lost favorites
  let lfIdx = 0;
  for (let i = 0; i < lostSlots && lfIdx < lostFavCandidates.length; lfIdx++) {
    const lf = lostFavCandidates[lfIdx];
    const count = artistCounts[lf.artist] ?? 0;
    if (count >= MAX_PER_ARTIST) continue;
    if (queue.some((q) => q.uri === lf.uri)) continue;
    artistCounts[lf.artist] = count + 1;
    // Insert at roughly every 3rd position
    const insertPos = Math.min(queue.length, (i + 1) * 3);
    queue.splice(insertPos, 0, lf);
    totalMinutes += AVG_TRACK_MINUTES;
    i++;
  }

  return {
    source: "local_history",
    mode,
    targetMinutes: lengthMin,
    actualMinutes: Math.round(totalMinutes * 10) / 10,
    trackCount: queue.length,
    tracks: queue,
    excluded: {
      skipPenalized: penalized.size,
      reason: "≥3 fwdbtn skips in last 30 days",
    },
  };
}
