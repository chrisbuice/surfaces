/**
 * agent.ts — the curation agent: build a session for a mode.
 *
 * M4: familiar-only sessions. Fresh mixing added in M6.
 * Context multipliers added in M8.
 */

import { MODES, AVG_TRACK_DURATION_MIN, RECENCY_AVOID_COUNT } from "../config";
import { resolveMode } from "./modes";
import { SpotifyClient } from "../spotify/client";
import { playTracks, queueTracks, createPlaylist, getActiveDevice } from "../spotify/playback";

interface StartSessionInput {
  mode?: string | null;
  output?: "play_now" | "queue" | "playlist" | null;
  durationMin?: number | null;
  deviceId?: string | null;
}

interface SessionResult {
  sessionId: string;
  mode: string;
  output: string;
  trackCount: number;
  tracks: Array<{ id: string; name: string; artist: string; source: string }>;
  playlistId?: string;
}

export async function startSession(
  db: D1Database,
  spotify: SpotifyClient,
  input: StartSessionInput
): Promise<SessionResult> {
  const mode = resolveMode(input.mode);
  const modeConfig = MODES[mode];
  const output = input.output ?? modeConfig.defaultOutput;
  const durationMin = input.durationMin ?? modeConfig.defaultDurationMin;
  const targetTrackCount = Math.round(durationMin / AVG_TRACK_DURATION_MIN);

  // ── Build candidate pool from track_taste ──
  // Get recently played track IDs to avoid repeating
  const recentRows = await db.prepare(
    "SELECT DISTINCT track_id FROM play_events ORDER BY started_at DESC LIMIT ?"
  ).bind(RECENCY_AVOID_COUNT).all<{ track_id: string }>();
  const recentIds = new Set(recentRows.results.map(r => r.track_id));

  // Fetch top-scoring familiar tracks
  const candidates = await db.prepare(
    "SELECT track_id, track_name, artist_ids, primary_artist_id, taste_score FROM track_taste WHERE taste_score > 0 ORDER BY taste_score DESC LIMIT 200"
  ).all<{
    track_id: string;
    track_name: string;
    artist_ids: string;
    primary_artist_id: string;
    taste_score: number;
  }>();

  // Filter out recently played
  const pool = candidates.results.filter(t => !recentIds.has(t.track_id));

  if (pool.length === 0) {
    throw new Error("No tracks available for curation. Run /debug/rebuild-taste first.");
  }

  // ── Select tracks with weighted random, avoiding same-artist back-to-back ──
  const selected = selectTracks(pool, targetTrackCount);

  // ── Persist session ──
  const sessionId = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await db.prepare(`
    INSERT INTO sessions (session_id, mode, invoked_at, invoked_via, fresh_ratio_target, duration_target_min, output)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(sessionId, mode, now, "api", 0, durationMin, output).run();

  const trackInserts = selected.map((t, i) =>
    db.prepare(
      "INSERT INTO session_tracks (session_id, position, track_id, source) VALUES (?, ?, ?, ?)"
    ).bind(sessionId, i, t.track_id, "familiar")
  );
  for (let i = 0; i < trackInserts.length; i += 100) {
    await db.batch(trackInserts.slice(i, i + 100));
  }

  // ── Execute output ──
  const trackIds = selected.map(t => t.track_id);

  if (output === "play_now") {
    const device = input.deviceId
      ? undefined // use the provided device
      : (await getActiveDevice(spotify));
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

    return {
      sessionId, mode, output, trackCount: selected.length,
      tracks: selected.map(t => ({
        id: t.track_id, name: t.track_name,
        artist: t.primary_artist_id, source: "familiar",
      })),
      playlistId,
    };
  }

  return {
    sessionId, mode, output, trackCount: selected.length,
    tracks: selected.map(t => ({
      id: t.track_id, name: t.track_name,
      artist: t.primary_artist_id, source: "familiar",
    })),
  };
}

/** Weighted random selection avoiding same-artist back-to-back */
function selectTracks(
  pool: Array<{ track_id: string; track_name: string; primary_artist_id: string; taste_score: number }>,
  count: number
): typeof pool {
  const selected: typeof pool = [];
  const used = new Set<string>();

  for (let i = 0; i < count && pool.length > 0; i++) {
    const lastArtist = selected.length > 0 ? selected[selected.length - 1].primary_artist_id : null;

    // Build weighted candidates, penalizing same-artist-as-last
    const weights = pool
      .filter(t => !used.has(t.track_id))
      .map(t => {
        let weight = Math.max(t.taste_score, 0.1);
        if (t.primary_artist_id === lastArtist) {
          weight *= 0.1; // strong penalty for back-to-back same artist
        }
        return { track: t, weight };
      });

    if (weights.length === 0) break;

    const pick = weightedRandomPick(weights);
    selected.push(pick.track);
    used.add(pick.track.track_id);
  }

  return selected;
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
