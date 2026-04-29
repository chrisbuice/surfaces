/**
 * tools.ts — MCP tool definitions and handlers.
 */

import type { Env } from "../index";
import { SpotifyClient } from "../spotify/client";
import { startSession } from "../curation/agent";
import { getTopFresh } from "../discovery/pool";

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export function getToolDefinitions(): McpToolDefinition[] {
  return [
    {
      name: "start_session",
      description: "Start a curated music session. Picks tracks based on your taste profile, listening history, and current context (weather, time of day, location). The user_note field lets you describe what you're doing for better track selection.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["waking_up", "working", "driving", "brainstorming", "unwinding", "sleeping"], description: "Listening mode. If omitted, inferred from time of day and context." },
          duration_min: { type: "number", description: "Session length in minutes. Defaults vary by mode (30-90)." },
          output: { type: "string", enum: ["play_now", "queue", "playlist"], description: "How to deliver tracks. play_now replaces current playback, queue appends, playlist creates a new playlist." },
          fresh_bias: { type: "number", description: "Shift freshness curve: -1 (all familiar) to +1 (more fresh discoveries). Default 0." },
          user_note: { type: "string", description: "Free-text context about what you're doing, e.g. 'long drive home', 'cooking dinner', 'about to sleep'. Stored in the context snapshot and influences track selection." },
        },
      },
    },
    {
      name: "current_session_status",
      description: "Get the status of the most recent curation session: what's playing, which tracks are in the queue, mode, and context biases applied.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "end_session",
      description: "End a curation session. If the session was started with play_now, this also pauses playback.",
      inputSchema: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session to end. If omitted, ends the most recent active session." },
        },
      },
    },
    {
      name: "add_to_seasonal",
      description: "Add a track to the current season's playlist. If no track_id is given, adds whatever is currently playing.",
      inputSchema: {
        type: "object",
        properties: {
          track_id: { type: "string", description: "Spotify track ID. If omitted, uses the currently playing track." },
        },
      },
    },
    {
      name: "get_fresh_pool",
      description: "View the fresh discovery pool — tracks found by the discovery agent that haven't been played yet. These are candidates for upcoming sessions.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "How many tracks to return. Default 20." },
        },
      },
    },
    {
      name: "mark_track",
      description: "Love or block a track. Loved tracks get added to the 'Liked via Agent' playlist and boost similar tracks. Blocked tracks are excluded from all future sessions.",
      inputSchema: {
        type: "object",
        properties: {
          track_id: { type: "string", description: "Spotify track ID to mark." },
          action: { type: "string", enum: ["love", "block"], description: "Whether to love or block the track." },
        },
        required: ["track_id", "action"],
      },
    },
    {
      name: "stats",
      description: "Get listening statistics: total plays, skip rate, top tracks, and fresh discovery adoption rate for a given period.",
      inputSchema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "week", "month"], description: "Time period. Default 'today'." },
        },
      },
    },
    {
      name: "current_context",
      description: "Get the latest context snapshot: weather, temperature, daylight phase, location, device type. This is what the curation agent uses to bias track selection.",
      inputSchema: { type: "object", properties: {} },
    },
  ];
}

export async function callTool(
  name: string,
  args: Record<string, unknown>,
  env: Env
): Promise<unknown> {
  switch (name) {
    case "start_session": {
      const spotify = new SpotifyClient(env);
      const result = await startSession(env.DB, spotify, {
        mode: (args.mode as string) ?? null,
        output: (args.output as "play_now" | "queue" | "playlist") ?? null,
        durationMin: (args.duration_min as number) ?? null,
        freshBias: (args.fresh_bias as number) ?? null,
        context: args.user_note ? { userNote: args.user_note as string } : null,
      }, env.KV);
      return {
        sessionId: result.sessionId,
        mode: result.mode,
        output: result.output,
        trackCount: result.trackCount,
        familiarCount: result.familiarCount,
        freshCount: result.freshCount,
        tracks: result.tracks.map(t => ({ name: t.name, source: t.source })),
        context: result.contextSummary,
      };
    }

    case "current_session_status": {
      const session = await env.DB.prepare(
        "SELECT session_id, mode, invoked_at, output, ended_at, context_snapshot_id FROM sessions ORDER BY invoked_at DESC LIMIT 1"
      ).first<{
        session_id: string; mode: string; invoked_at: number; output: string;
        ended_at: number | null; context_snapshot_id: number | null;
      }>();
      if (!session) return { status: "no_sessions", message: "No sessions have been created yet." };

      const tracks = await env.DB.prepare(
        `SELECT st.position, st.track_id, st.source, st.outcome,
                COALESCE(tt.track_name, fp.track_name) as track_name
         FROM session_tracks st
         LEFT JOIN track_taste tt ON tt.track_id = st.track_id
         LEFT JOIN fresh_pool fp ON fp.track_id = st.track_id
         WHERE st.session_id = ? ORDER BY st.position`
      ).bind(session.session_id).all<{
        position: number; track_id: string; source: string; outcome: string | null; track_name: string | null;
      }>();

      // Get now-playing from Spotify
      let nowPlaying: { trackName: string; artistName: string; trackId: string; progressMs: number; durationMs: number } | null = null;
      try {
        const spotify = new SpotifyClient(env);
        const playing = await spotify.get<{
          is_playing: boolean;
          item: { id: string; name: string; artists: Array<{ name: string }>; duration_ms: number } | null;
          progress_ms: number | null;
        }>("/v1/me/player/currently-playing");
        if (playing?.item) {
          nowPlaying = {
            trackName: playing.item.name,
            artistName: playing.item.artists.map(a => a.name).join(", "),
            trackId: playing.item.id,
            progressMs: playing.progress_ms ?? 0,
            durationMs: playing.item.duration_ms,
          };
        }
      } catch { /* no active playback */ }

      // Find current position in session
      let currentPosition: number | null = null;
      if (nowPlaying) {
        const match = tracks.results.find(t => t.track_id === nowPlaying!.trackId);
        if (match) currentPosition = match.position;
      }

      // Get context biases if available
      let contextInfo: Record<string, unknown> | null = null;
      if (session.context_snapshot_id) {
        const snap = await env.DB.prepare(
          "SELECT daylight_phase, weather_condition, weather_temp_f, location_label, device_type FROM context_snapshots WHERE id = ?"
        ).bind(session.context_snapshot_id).first<{
          daylight_phase: string; weather_condition: string | null; weather_temp_f: number | null;
          location_label: string | null; device_type: string | null;
        }>();
        if (snap) contextInfo = snap;
      }

      const trackList = tracks.results.map(t => ({
        position: t.position + 1,
        name: t.track_name ?? t.track_id,
        source: t.source,
        outcome: t.outcome,
      }));

      return {
        sessionId: session.session_id,
        mode: session.mode,
        output: session.output,
        startedAt: new Date(session.invoked_at * 1000).toISOString(),
        ended: session.ended_at != null,
        trackCount: tracks.results.length,
        currentlyPlaying: nowPlaying ? {
          ...nowPlaying,
          sessionPosition: currentPosition != null ? currentPosition + 1 : null,
        } : null,
        upcoming: currentPosition != null
          ? trackList.filter(t => t.position > currentPosition! + 1)
          : [],
        allTracks: trackList,
        context: contextInfo,
      };
    }

    case "end_session": {
      const targetId = args.session_id as string | undefined;
      const session = targetId
        ? await env.DB.prepare("SELECT session_id, output FROM sessions WHERE session_id = ?").bind(targetId).first<{ session_id: string; output: string }>()
        : await env.DB.prepare("SELECT session_id, output FROM sessions WHERE ended_at IS NULL ORDER BY invoked_at DESC LIMIT 1").first<{ session_id: string; output: string }>();

      if (!session) return { ok: false, error: "No active session found." };

      const now = Math.floor(Date.now() / 1000);
      await env.DB.prepare("UPDATE sessions SET ended_at = ? WHERE session_id = ?").bind(now, session.session_id).run();

      if (session.output === "play_now") {
        try {
          const spotify = new SpotifyClient(env);
          await spotify.put("/v1/me/player/pause");
        } catch { /* may already be paused */ }
      }

      return { ok: true, sessionId: session.session_id, endedAt: new Date(now * 1000).toISOString() };
    }

    case "add_to_seasonal": {
      const spotify = new SpotifyClient(env);
      const currentSeasonal = await env.DB.prepare(
        "SELECT spotify_playlist_id, name FROM seasonal_playlists WHERE is_current = 1 LIMIT 1"
      ).first<{ spotify_playlist_id: string; name: string }>();
      if (!currentSeasonal) return { ok: false, error: "No current seasonal playlist found." };

      let trackId = args.track_id as string | undefined;
      let trackName = trackId ?? "unknown";

      if (!trackId) {
        const playing = await spotify.get<{ item?: { id: string; name: string } }>("/v1/me/player/currently-playing");
        if (!playing?.item) return { ok: false, error: "Nothing is currently playing and no track_id provided." };
        trackId = playing.item.id;
        trackName = playing.item.name;
      }

      await spotify.post(`/v1/playlists/${currentSeasonal.spotify_playlist_id}/items`, {
        uris: [`spotify:track:${trackId}`],
      });
      return { ok: true, trackName, playlist: currentSeasonal.name };
    }

    case "get_fresh_pool": {
      const limit = (args.limit as number) ?? 20;
      const entries = await getTopFresh(env.DB, limit);
      return entries.map(e => ({
        trackId: e.track_id,
        trackName: e.track_name,
        source: e.source_detail ?? e.source,
        tasteScore: e.taste_score,
      }));
    }

    case "mark_track": {
      const trackId = args.track_id as string;
      const action = args.action as "love" | "block";
      if (!trackId || !action) return { ok: false, error: "track_id and action are required." };

      const isBlock = action === "block";
      const kvKey = isBlock ? "playlist:blocked" : "playlist:liked";
      const playlistName = isBlock ? "Blocked" : "Liked via Agent";

      const spotify = new SpotifyClient(env);
      let playlistId = await env.KV.get(kvKey);
      if (!playlistId) {
        const pl = await spotify.post<{ id: string }>("/v1/me/playlists", {
          name: playlistName, public: false,
          description: isBlock
            ? "Tracks blocked from curation agent — do not play"
            : "Tracks liked from the curation agent dashboard",
        });
        playlistId = pl.id;
        await env.KV.put(kvKey, playlistId);
      }

      await spotify.post(`/v1/playlists/${playlistId}/items`, {
        uris: [`spotify:track:${trackId}`],
      });
      return { ok: true, action, trackId, playlist: playlistName };
    }

    case "stats": {
      const period = (args.period as string) ?? "today";
      const now = Math.floor(Date.now() / 1000);
      const since = period === "month" ? now - 30 * 86400
        : period === "week" ? now - 7 * 86400
        : now - 86400;

      const totals = await env.DB.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN classification = 'completed' THEN 1 ELSE 0 END) as completed,
          SUM(CASE WHEN classification = 'skipped' THEN 1 ELSE 0 END) as skipped,
          SUM(CASE WHEN classification = 'replayed' THEN 1 ELSE 0 END) as replayed
        FROM play_events WHERE started_at >= ?
      `).bind(since).first<{ total: number; completed: number; skipped: number; replayed: number }>();

      const total = totals?.total ?? 0;
      const completed = totals?.completed ?? 0;
      const skipped = totals?.skipped ?? 0;

      // Top played tracks
      const topPlayed = await env.DB.prepare(`
        SELECT pe.track_id, COUNT(*) as plays, COALESCE(tt.track_name, po.track_name) as track_name
        FROM play_events pe
        LEFT JOIN track_taste tt ON tt.track_id = pe.track_id
        LEFT JOIN (SELECT track_id, track_name FROM poll_observations WHERE track_name IS NOT NULL GROUP BY track_id) po ON po.track_id = pe.track_id
        WHERE pe.started_at >= ?
        GROUP BY pe.track_id ORDER BY plays DESC LIMIT 10
      `).bind(since).all<{ track_id: string; plays: number; track_name: string | null }>();

      // Fresh plays
      const freshPlays = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM play_events pe
        JOIN session_tracks st ON st.track_id = pe.track_id AND st.session_id = pe.session_id
        WHERE pe.started_at >= ? AND st.source LIKE 'fresh:%'
      `).bind(since).first<{ count: number }>();

      return {
        period,
        totalPlays: total,
        completed,
        skipped,
        replayed: totals?.replayed ?? 0,
        skipRate: total > 0 ? Math.round(skipped / total * 100) + "%" : "0%",
        freshPlays: freshPlays?.count ?? 0,
        freshRatio: total > 0 ? Math.round((freshPlays?.count ?? 0) / total * 100) + "%" : "0%",
        topPlayed: topPlayed.results.map(t => ({
          name: t.track_name ?? t.track_id,
          plays: t.plays,
        })),
      };
    }

    case "current_context": {
      const snap = await env.DB.prepare(
        `SELECT captured_at, daylight_phase, weather_condition, weather_temp_f,
                weather_wind_mph, weather_cloud_pct,
                location_label, location_source, device_type, user_note
         FROM context_snapshots ORDER BY captured_at DESC LIMIT 1`
      ).first<{
        captured_at: number; daylight_phase: string; weather_condition: string | null;
        weather_temp_f: number | null;
        weather_wind_mph: number | null; weather_cloud_pct: number | null;
        location_label: string | null; location_source: string | null;
        device_type: string | null; user_note: string | null;
      }>();
      if (!snap) return { error: "No context snapshots captured yet." };
      return {
        capturedAt: new Date(snap.captured_at * 1000).toISOString(),
        daylightPhase: snap.daylight_phase,
        weather: {
          condition: snap.weather_condition,
          tempF: snap.weather_temp_f,
          windMph: snap.weather_wind_mph,
          cloudPct: snap.weather_cloud_pct,
        },
        location: snap.location_label,
        locationSource: snap.location_source,
        device: snap.device_type,
        userNote: snap.user_note,
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
