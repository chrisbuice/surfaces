/**
 * agent.ts — the curation agent: build a session for a mode.
 *
 * Mixes familiar tracks (from track_taste) with fresh discoveries
 * (from fresh_pool) using the position-based freshness arc.
 * Context multipliers added in M8.
 */

import { MODES, AVG_TRACK_DURATION_MIN, RECENCY_AVOID_COUNT, ACOUSTIC_PROFILE_MIN_SAMPLES } from "../config";
import { resolveMode } from "./modes";
import { shouldBeFresh } from "./arc";
import { SpotifyClient } from "../spotify/client";
import { playTracks, queueTracks, createPlaylist, getActiveDevice } from "../spotify/playback";
import { getTopFresh, markFreshUsed } from "../discovery/pool";
import { captureContext, type ContextInput, type ContextSnapshot } from "../context/capture";
import { computeContextMultiplier, summarizeBiases, type ScoredContext } from "./context_score";
import { computeAcousticFit, type AudioFeatureValues } from "../audio/fit";

interface TrackCandidate {
  track_id: string;
  track_name: string;
  primary_artist_id: string;
  taste_score: number;
  source: string; // "familiar" or "fresh:<source>"
}

interface StartSessionInput {
  mode?: string | null;
  output?: "play_now" | "queue" | "playlist" | null;
  durationMin?: number | null;
  deviceId?: string | null;
  freshBias?: number | null;
  context?: ContextInput | null;
}

interface SessionResult {
  sessionId: string;
  mode: string;
  output: string;
  trackCount: number;
  familiarCount: number;
  freshCount: number;
  tracks: Array<{ id: string; name: string; artist: string; source: string }>;
  contextSummary: {
    daylightPhase: string;
    weatherCondition: string | null;
    tempF: number | null;
    location: string | null;
    biasesApplied: Array<{ dimension: string; bucket: string; reason: string; appliedToTracks: number; avgMultiplier: number }>;
  };
  playlistId?: string;
}

export async function startSession(
  db: D1Database,
  spotify: SpotifyClient,
  input: StartSessionInput,
  kv?: KVNamespace
): Promise<SessionResult> {
  // ── Capture context snapshot ──
  const { snapshotId, snapshot } = await captureContext(
    db, "session_start", input.context ?? {}, kv
  );

  const mode = resolveMode(input.mode);
  const modeConfig = MODES[mode];
  const output = input.output ?? modeConfig.defaultOutput;
  const durationMin = input.durationMin ?? modeConfig.defaultDurationMin;
  const targetTrackCount = Math.round(durationMin / AVG_TRACK_DURATION_MIN);

  // Apply fresh bias to the mode multiplier
  let freshMultiplier = modeConfig.freshMultiplier;
  if (input.freshBias) {
    freshMultiplier = Math.max(0, freshMultiplier + input.freshBias * 0.5);
  }

  // ── Load blocked tracks from the "Blocked" playlist ──
  const blockedIds = new Set<string>();
  if (kv) {
    const blockedPlaylistId = await kv.get("playlist:blocked");
    if (blockedPlaylistId) {
      try {
        const { getPlaylistTracksViaEmbed } = await import("../spotify/embed");
        const { tracks: blockedTracks } = await getPlaylistTracksViaEmbed(blockedPlaylistId, 500);
        for (const t of blockedTracks) {
          blockedIds.add(t.trackId);
        }
      } catch { /* playlist may not exist yet */ }
    }
  }

  // ── Load acoustic profile centroid for this mode ──
  // Try mode-specific centroid first; fall back to 'overall' if undertrained
  let modeCentroid = new Map<string, { mean: number; stddev: number }>();
  try {
    let centroidMode = mode;
    const modeRows = await db.prepare(
      "SELECT dimension, mean, stddev, sample_size FROM acoustic_profile WHERE mode = ?"
    ).bind(mode).all<{ dimension: string; mean: number; stddev: number; sample_size: number }>();

    if (modeRows.results.length > 0 && modeRows.results[0].sample_size >= ACOUSTIC_PROFILE_MIN_SAMPLES) {
      modeCentroid = new Map(modeRows.results.map(r => [r.dimension, { mean: r.mean, stddev: r.stddev }]));
    } else {
      // Fall back to 'overall' centroid
      centroidMode = "overall";
      const overallRows = await db.prepare(
        "SELECT dimension, mean, stddev, sample_size FROM acoustic_profile WHERE mode = 'overall'"
      ).all<{ dimension: string; mean: number; stddev: number; sample_size: number }>();
      if (overallRows.results.length > 0 && overallRows.results[0].sample_size >= ACOUSTIC_PROFILE_MIN_SAMPLES) {
        modeCentroid = new Map(overallRows.results.map(r => [r.dimension, { mean: r.mean, stddev: r.stddev }]));
      }
    }
  } catch { /* no acoustic profile yet — all tracks get fit=1.0 */ }

  // Load audio features for all tracks (used for per-track acoustic fit)
  const audioFeaturesMap = new Map<string, AudioFeatureValues>();
  try {
    const afRows = await db.prepare(
      "SELECT track_id, acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence FROM track_audio_features WHERE acousticness IS NOT NULL"
    ).all<{ track_id: string } & AudioFeatureValues>();
    for (const r of afRows.results) {
      audioFeaturesMap.set(r.track_id, r);
    }
  } catch { /* no features yet */ }

  // Helper: compute acoustic fit for a track (1.0 if no features or no centroid)
  const getAcousticFit = (trackId: string): number => {
    if (modeCentroid.size === 0) return 1.0;
    const features = audioFeaturesMap.get(trackId);
    if (!features) return 1.0;
    return computeAcousticFit(features, modeCentroid);
  };

  // ── Build familiar candidate pool ──
  const recentRows = await db.prepare(
    "SELECT DISTINCT track_id FROM play_events ORDER BY started_at DESC LIMIT ?"
  ).bind(RECENCY_AVOID_COUNT).all<{ track_id: string }>();
  const recentIds = new Set(recentRows.results.map(r => r.track_id));

  const familiarRows = await db.prepare(
    `SELECT track_id, track_name, primary_artist_id, album_id, taste_score,
            play_count, skip_count, complete_count, seasonal_playlist_count,
            current_season_present
     FROM track_taste WHERE taste_score > 0 ORDER BY taste_score DESC LIMIT 200`
  ).all<{
    track_id: string; track_name: string; primary_artist_id: string; album_id: string | null;
    taste_score: number; play_count: number; skip_count: number; complete_count: number;
    seasonal_playlist_count: number; current_season_present: number;
  }>();

  // Load learned affinities (all of them — table is small for a single user)
  const affinityMap = new Map<string, Array<{ dimension: string; bucket: string; affinity: number; sample_size: number }>>();
  try {
    const affinityRows = await db.prepare(
      "SELECT track_id, dimension, bucket, affinity, sample_size FROM track_context_affinity"
    ).all<{
      track_id: string; dimension: string; bucket: string; affinity: number; sample_size: number;
    }>();
    for (const row of affinityRows.results) {
      const list = affinityMap.get(row.track_id) ?? [];
      list.push(row);
      affinityMap.set(row.track_id, list);
    }
  } catch { /* no affinities yet — that's fine */ }

  // Apply context multipliers to familiar tracks (cold-start + learned)
  const allBiases: Array<import("../context/rules").ContextBias> = [];
  const familiarPool: TrackCandidate[] = familiarRows.results
    .filter(t => !recentIds.has(t.track_id) && !blockedIds.has(t.track_id))
    .map(t => {
      const ctx = computeContextMultiplier(snapshot, mode, {
        track_id: t.track_id,
        play_count: t.play_count,
        skip_count: t.skip_count,
        complete_count: t.complete_count,
        last_played_hour: null,
        seasonal_playlist_count: t.seasonal_playlist_count,
        current_season_present: t.current_season_present === 1,
        album_id: t.album_id,
      }, affinityMap.get(t.track_id));
      allBiases.push(...ctx.biases);
      const acousticFit = getAcousticFit(t.track_id);
      return {
        track_id: t.track_id,
        track_name: t.track_name,
        primary_artist_id: t.primary_artist_id,
        taste_score: t.taste_score * ctx.multiplier * acousticFit,
        source: "familiar",
      };
    });

  // ── Build fresh candidate pool ──
  const freshEntries = await getTopFresh(db, 50);
  const freshPool: TrackCandidate[] = freshEntries
    .filter(f => !recentIds.has(f.track_id) && !blockedIds.has(f.track_id))
    .map(f => {
      const acousticFit = getAcousticFit(f.track_id);
      return {
        track_id: f.track_id,
        track_name: f.track_name,
        primary_artist_id: f.primary_artist_id,
        taste_score: f.taste_score * acousticFit,
        source: `fresh:${f.source}`,
      };
    });

  if (familiarPool.length === 0 && mode !== "discover") {
    throw new Error("No tracks available for curation. Run /debug/rebuild-taste first.");
  }
  if (freshPool.length === 0 && mode === "discover") {
    throw new Error("Fresh pool is empty. Run /debug/run-discovery first.");
  }

  // ── Build session position by position ──
  const selected: TrackCandidate[] = [];
  const usedIds = new Set<string>();
  let familiarCount = 0;
  let freshCount = 0;

  for (let i = 0; i < targetTrackCount; i++) {
    const position = targetTrackCount > 1 ? i / (targetTrackCount - 1) : 0;
    // Discover mode: 100% fresh, skip the arc entirely
    const useFresh = mode === "discover"
      ? freshPool.length > 0
      : freshPool.length > 0 && shouldBeFresh(position, freshMultiplier);
    const pool = useFresh ? freshPool : familiarPool;
    const lastArtist = selected.length > 0 ? selected[selected.length - 1].primary_artist_id : null;

    // Weighted pick from the chosen pool
    const weights = pool
      .filter(t => !usedIds.has(t.track_id))
      .map(t => {
        let weight = Math.max(t.taste_score, 0.1);
        if (t.primary_artist_id === lastArtist) weight *= 0.1;
        return { track: t, weight };
      });

    // If chosen pool is empty, fall back to the other pool
    let pick: TrackCandidate | null = null;
    if (weights.length > 0) {
      pick = weightedRandomPick(weights).track;
    } else {
      const fallbackPool = useFresh ? familiarPool : freshPool;
      const fallbackWeights = fallbackPool
        .filter(t => !usedIds.has(t.track_id))
        .map(t => ({ track: t, weight: Math.max(t.taste_score, 0.1) }));
      if (fallbackWeights.length > 0) {
        pick = weightedRandomPick(fallbackWeights).track;
      }
    }

    if (!pick) break;

    selected.push(pick);
    usedIds.add(pick.track_id);
    if (pick.source === "familiar") familiarCount++;
    else freshCount++;
  }

  // ── Persist session ──
  const sessionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const freshRatioTarget = targetTrackCount > 0 ? freshCount / targetTrackCount : 0;

  await db.prepare(`
    INSERT INTO sessions (session_id, mode, invoked_at, invoked_via, fresh_ratio_target, duration_target_min, output, context_snapshot_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(sessionId, mode, now, "api", freshRatioTarget, durationMin, output, snapshotId).run();

  const trackInserts = selected.map((t, i) =>
    db.prepare(
      "INSERT INTO session_tracks (session_id, position, track_id, source) VALUES (?, ?, ?, ?)"
    ).bind(sessionId, i, t.track_id, t.source)
  );
  for (let i = 0; i < trackInserts.length; i += 100) {
    await db.batch(trackInserts.slice(i, i + 100));
  }

  // Mark fresh tracks as queued in the pool
  for (const t of selected) {
    if (t.source !== "familiar") {
      await markFreshUsed(db, t.track_id, "queued");
    }
  }

  // ── Execute output ──
  const trackIds = selected.map(t => t.track_id);

  if (output === "play_now") {
    const device = input.deviceId ? undefined : (await getActiveDevice(spotify));
    const deviceId = input.deviceId ?? device?.id;
    if (!deviceId) {
      throw new Error("No active Spotify device found. Open Spotify and start playing something first.");
    }
    await playTracks(spotify, trackIds, deviceId);
  } else if (output === "queue") {
    const device = await getActiveDevice(spotify);
    await queueTracks(spotify, trackIds, device?.id);
  } else if (output === "playlist") {
    const profile = await spotify.get<{ id: string }>("/v1/me");
    const date = new Date().toISOString().split("T")[0];
    const playlistName = `${mode} — ${date}`;
    const playlistId = await createPlaylist(spotify, profile.id, playlistName, trackIds);
    await db.prepare(
      "UPDATE sessions SET spotify_playlist_id = ? WHERE session_id = ?"
    ).bind(playlistId, sessionId).run();

    return buildResult(selected, sessionId, mode, output, familiarCount, freshCount, snapshot, allBiases, playlistId);
  }

  return buildResult(selected, sessionId, mode, output, familiarCount, freshCount, snapshot, allBiases);
}

function buildResult(
  selected: TrackCandidate[],
  sessionId: string, mode: string, output: string,
  familiarCount: number, freshCount: number,
  snapshot: ContextSnapshot,
  allBiases: Array<import("../context/rules").ContextBias>,
  playlistId?: string
): SessionResult {
  return {
    sessionId, mode, output,
    trackCount: selected.length,
    familiarCount, freshCount,
    tracks: selected.map(t => ({
      id: t.track_id, name: t.track_name, artist: t.primary_artist_id, source: t.source,
    })),
    contextSummary: {
      daylightPhase: snapshot.daylightPhase,
      weatherCondition: snapshot.weatherCondition,
      tempF: snapshot.weatherTempF,
      location: snapshot.locationLabel,
      biasesApplied: summarizeBiases(allBiases),
    },
    ...(playlistId ? { playlistId } : {}),
  };
}

function weightedRandomPick<T>(items: Array<{ track: T; weight: number }>): { track: T; weight: number } {
  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const item of items) {
    rand -= item.weight;
    if (rand <= 0) return item;
  }
  return items[items.length - 1];
}
