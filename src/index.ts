import { handleLogin, handleCallback } from "./auth/spotify-oauth";
import { SpotifyClient } from "./spotify/client";
import { handlePoll } from "./tracker/poll";
import { derivePlayEvents } from "./tracker/derive";
import { getRecentPollObservations, getRecentPlayEvents, pruneOldObservations } from "./db/queries";
import { processFeedback } from "./curation/feedback";
import { rebuildAffinities } from "./context/affinity";
import { startSession } from "./curation/agent";
import { rebuildTasteModel } from "./taste/model";
import { runDiscoveryAgent } from "./discovery/agent";
import { getTopFresh, getFreshPoolStats } from "./discovery/pool";

export interface Env {
  DB: D1Database;
  KV: KVNamespace;
  SPOTIFY_CLIENT_ID: string;
  SPOTIFY_CLIENT_SECRET: string;
  SHORTCUT_TOKEN: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      switch (url.pathname) {
        case "/":
          return new Response("spotify-agent is running", { status: 200 });

        case "/auth/login":
          return handleLogin(request, env);

        case "/auth/callback":
          return await handleCallback(request, env);

        case "/me": {
          const spotify = new SpotifyClient(env);
          const profile = await spotify.get<{ display_name: string; id: string }>("/v1/me");
          return Response.json({ display_name: profile.display_name, id: profile.id });
        }

        case "/debug/recent-observations": {
          const obs = await getRecentPollObservations(env.DB, 20);
          return Response.json(obs);
        }

        case "/debug/recent-events": {
          const events = await getRecentPlayEvents(env.DB, 20);
          return Response.json(events);
        }

        case "/debug/derive": {
          const count = await derivePlayEvents(env.DB);
          return Response.json({ derived: count });
        }

        case "/debug/rebuild-taste": {
          const spotify = new SpotifyClient(env);
          const result = await rebuildTasteModel(env.DB, spotify);
          return Response.json(result);
        }

        case "/debug/top-tracks-by-score": {
          const limit = url.searchParams.get("limit") ?? "30";
          const rows = await env.DB.prepare(
            "SELECT track_id, track_name, primary_artist_id, taste_score, in_liked_songs, in_top_tracks_short, in_top_tracks_medium, seasonal_playlist_count, play_count, skip_count FROM track_taste ORDER BY taste_score DESC LIMIT ?"
          ).bind(parseInt(limit)).all();
          return Response.json(rows.results);
        }

        case "/debug/seasonal-playlists": {
          const rows = await env.DB.prepare(
            "SELECT * FROM seasonal_playlists ORDER BY year DESC, season"
          ).all();
          return Response.json(rows.results);
        }

        case "/debug/top-artists": {
          const rows = await env.DB.prepare(
            "SELECT artist_id, artist_name, taste_score, in_top_artists_short, in_top_artists_medium, is_followed, total_plays FROM artist_taste ORDER BY taste_score DESC LIMIT 30"
          ).all();
          return Response.json(rows.results);
        }

        case "/api/start-session": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const spotify = new SpotifyClient(env);
          const body = await request.json() as {
            mode?: string; output?: string; duration_min?: number; device_id?: string;
            fresh_bias?: number; context?: Record<string, unknown>;
          };
          const result = await startSession(env.DB, spotify, {
            mode: body.mode,
            output: body.output as "play_now" | "queue" | "playlist" | undefined,
            durationMin: body.duration_min,
            deviceId: body.device_id,
            freshBias: body.fresh_bias,
            context: body.context ? {
              locationLabel: (body.context.location_label as string) ?? null,
              locationLat: (body.context.location_lat as number) ?? null,
              locationLon: (body.context.location_lon as number) ?? null,
              isInMotion: (body.context.is_in_motion as number) ?? null,
              bluetoothContext: (body.context.bluetooth_context as string) ?? null,
              userNote: (body.context.user_note as string) ?? null,
            } : null,
          });
          return Response.json(result);
        }

        case "/shortcut/start": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          // Bearer token auth
          const authHeader = request.headers.get("Authorization");
          const token = authHeader?.replace("Bearer ", "");
          if (token !== env.SHORTCUT_TOKEN) {
            return new Response("Unauthorized", { status: 401 });
          }
          const spotify = new SpotifyClient(env);
          const shortcutBody = await request.json() as {
            mode?: string; minutes?: number;
            context?: { location_label?: string; location_lat?: number; location_lon?: number;
                        is_in_motion?: number; bluetooth_context?: string; user_note?: string };
          };
          const shortcutResult = await startSession(env.DB, spotify, {
            mode: shortcutBody.mode,
            output: "play_now",
            durationMin: shortcutBody.minutes,
            context: shortcutBody.context ? {
              locationLabel: shortcutBody.context.location_label ?? null,
              locationLat: shortcutBody.context.location_lat ?? null,
              locationLon: shortcutBody.context.location_lon ?? null,
              isInMotion: shortcutBody.context.is_in_motion ?? null,
              bluetoothContext: shortcutBody.context.bluetooth_context ?? null,
              userNote: shortcutBody.context.user_note ?? null,
            } : null,
          });
          return Response.json({
            ok: true,
            summary: `Started ${shortcutResult.mode} session, ${shortcutResult.trackCount} tracks (${shortcutResult.familiarCount} familiar, ${shortcutResult.freshCount} fresh).`,
          });
        }

        case "/debug/rebuild-affinities": {
          const result = await rebuildAffinities(env.DB);
          return Response.json(result);
        }

        case "/debug/track-affinities": {
          const trackId = url.searchParams.get("track_id");
          if (!trackId) return Response.json({ error: "track_id required" });
          const rows = await env.DB.prepare(
            "SELECT * FROM track_context_affinity WHERE track_id = ? ORDER BY dimension, bucket"
          ).bind(trackId).all();
          return Response.json(rows.results);
        }

        case "/debug/run-feedback": {
          const feedbackResult = await processFeedback(env.DB);
          if (!feedbackResult) return Response.json({ message: "No active session" });
          return Response.json(feedbackResult);
        }

        case "/debug/session-biases": {
          // Show context biases applied to the most recent session
          const lastSession = await env.DB.prepare(
            "SELECT session_id, mode, context_snapshot_id FROM sessions ORDER BY invoked_at DESC LIMIT 1"
          ).first<{ session_id: string; mode: string; context_snapshot_id: number | null }>();
          if (!lastSession) return Response.json({ error: "No sessions yet" });

          const snap = lastSession.context_snapshot_id
            ? await env.DB.prepare("SELECT * FROM context_snapshots WHERE id = ?")
                .bind(lastSession.context_snapshot_id).first()
            : null;

          const tracks = await env.DB.prepare(
            "SELECT track_id, source FROM session_tracks WHERE session_id = ? ORDER BY position"
          ).bind(lastSession.session_id).all<{ track_id: string; source: string }>();

          return Response.json({
            sessionId: lastSession.session_id,
            mode: lastSession.mode,
            contextSnapshot: snap,
            tracks: tracks.results,
          });
        }

        case "/debug/last-snapshot": {
          const row = await env.DB.prepare(
            "SELECT * FROM context_snapshots ORDER BY captured_at DESC LIMIT 1"
          ).first();
          if (!row) return Response.json({ error: "No snapshots yet" });
          return Response.json(row);
        }

        case "/debug/run-discovery": {
          const spotify = new SpotifyClient(env);
          const result = await runDiscoveryAgent(env.DB, spotify);
          return Response.json(result);
        }

        case "/debug/discovery-sources": {
          const spotify = new SpotifyClient(env);
          const diag: Record<string, unknown> = {};

          // Test followed artists recent releases
          try {
            const { getFollowedArtists } = await import("./spotify/library");
            const { getArtistRecentReleases } = await import("./spotify/browse");
            const fa = await getFollowedArtists(spotify, 10);
            diag.followedArtists = fa.length;
            const releases: string[] = [];
            for (const a of fa.slice(0, 5)) {
              const r = await getArtistRecentReleases(spotify, a.id, 30);
              if (r.length > 0) releases.push(`${a.name}: ${r.map(x => x.name).join(", ")}`);
            }
            diag.recentReleases = releases.length > 0 ? releases : "none in last 30 days from first 5 artists";
          } catch (e) { diag.followedArtists = { error: String(e) }; }

          // Test editorial playlist search — try multiple
          try {
            const { findPlaylistByName } = await import("./spotify/browse");
            const names = ["New Music Friday", "Fresh Finds", "Pollen", "RADAR"];
            const found: Record<string, unknown> = {};
            for (const name of names) {
              found[name] = await findPlaylistByName(spotify, name);
            }
            diag.editorialPlaylists = found;
          } catch (e) { diag.editorialPlaylists = { error: String(e) }; }

          // Check KV cache
          const cached = await env.KV.get("discovery:editorial_playlist_ids");
          // Test fetching tracks from New Music Friday directly
          diag.note = "Discovery uses search API (playlist-tracks blocked in Dev Mode).";

          return Response.json(diag);
        }

        case "/debug/fresh-pool": {
          const limit = parseInt(url.searchParams.get("limit") ?? "20");
          const entries = await getTopFresh(env.DB, limit);
          return Response.json(entries);
        }

        case "/debug/fresh-pool-stats": {
          const stats = await getFreshPoolStats(env.DB);
          return Response.json(stats);
        }

        case "/debug/all-playlists": {
          const spotify = new SpotifyClient(env);
          const { getUserPlaylists } = await import("./spotify/library");
          const pls = await getUserPlaylists(spotify, 500);
          return Response.json(pls.map(p => ({ id: p.id, name: p.name, tracks: p.tracks?.total ?? 0 })));
        }

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(message, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;

    if (cron === "* * * * *") {
      // Every minute: poll Spotify for currently-playing, then derive events
      await handlePoll(env);
      await derivePlayEvents(env.DB);
    }

    if (cron === "0 5 * * *") {
      // Daily at 5am UTC (1am ET): derive, rebuild taste + affinities, prune
      await derivePlayEvents(env.DB);
      const spotify = new SpotifyClient(env);
      await rebuildTasteModel(env.DB, spotify);
      await rebuildAffinities(env.DB);
      await pruneOldObservations(env.DB, 30 * 24 * 60 * 60);
    }

    if (cron === "0 10 * * *") {
      // Daily at 10am UTC (6am ET): run discovery agent
      const spotify = new SpotifyClient(env);
      await runDiscoveryAgent(env.DB, spotify);
    }

    if (cron === "*/2 * * * *") {
      // Every 2 minutes: check for active session and process feedback
      await processFeedback(env.DB);
    }
  },
} satisfies ExportedHandler<Env>;
