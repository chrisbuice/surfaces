import { handleLogin, handleCallback } from "./auth/spotify-oauth";
import { SpotifyClient } from "./spotify/client";
import { handlePoll } from "./tracker/poll";
import { derivePlayEvents } from "./tracker/derive";
import { getRecentPollObservations, getRecentPlayEvents, pruneOldObservations } from "./db/queries";
import { processFeedback } from "./curation/feedback";
import { rebuildAffinities } from "./context/affinity";
import { captureContext as captureContextSnapshot, getLatestSnapshotId } from "./context/capture";
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

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    const addCors = (resp: Response): Response => {
      const headers = new Headers(resp.headers);
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    };

    const response = await (async (): Promise<Response> => {
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

        case "/api/now-playing": {
          const spotify = new SpotifyClient(env);
          try {
            const playing = await spotify.get<{
              is_playing: boolean;
              item: { id: string; name: string; artists: Array<{ name: string }>; duration_ms: number } | null;
              progress_ms: number | null;
              device?: { name: string; type: string } | null;
            }>("/v1/me/player/currently-playing");
            if (!playing || !playing.item) {
              return Response.json({ is_playing: false });
            }
            return Response.json({
              is_playing: playing.is_playing,
              track_name: playing.item.name,
              artist_name: playing.item.artists.map(a => a.name).join(", "),
              progress_ms: playing.progress_ms,
              duration_ms: playing.item.duration_ms,
              device_name: playing.device?.name ?? null,
              device_type: playing.device?.type ?? null,
            });
          } catch {
            return Response.json({ is_playing: false });
          }
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
          }, env.KV);
          return Response.json(result);
        }

        case "/shortcut/start":
        case "/shortcut/queue":
        case "/shortcut/save_to_seasonal": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const authHeader = request.headers.get("Authorization");
          const bearerToken = authHeader?.replace("Bearer ", "");
          if (bearerToken !== env.SHORTCUT_TOKEN) {
            return new Response("Unauthorized", { status: 401 });
          }

          const spotify = new SpotifyClient(env);

          // save_to_seasonal: add currently-playing to current season playlist
          if (url.pathname === "/shortcut/save_to_seasonal") {
            const currentSeasonal = await env.DB.prepare(
              "SELECT spotify_playlist_id, name FROM seasonal_playlists WHERE is_current = 1 LIMIT 1"
            ).first<{ spotify_playlist_id: string; name: string }>();
            if (!currentSeasonal) {
              return Response.json({ ok: false, summary: "No current seasonal playlist found." });
            }
            const playing = await spotify.get<{ item?: { id: string; name: string } }>("/v1/me/player/currently-playing");
            if (!playing?.item) {
              return Response.json({ ok: false, summary: "Nothing is currently playing." });
            }
            try {
              await spotify.post(`/v1/playlists/${currentSeasonal.spotify_playlist_id}/items`, {
                uris: [`spotify:track:${playing.item.id}`],
              });
              return Response.json({ ok: true, summary: `Added "${playing.item.name}" to ${currentSeasonal.name}.` });
            } catch {
              return Response.json({ ok: false, summary: "Failed to add track (playlist write blocked in Dev Mode)." });
            }
          }

          // start or queue: build a session
          const shortcutBody = await request.json() as {
            mode?: string; minutes?: number;
            context?: { location_label?: string; location_lat?: number; location_lon?: number;
                        is_in_motion?: number; bluetooth_context?: string; user_note?: string };
          };
          const outputType = url.pathname === "/shortcut/queue" ? "queue" as const : "play_now" as const;
          const shortcutResult = await startSession(env.DB, spotify, {
            mode: shortcutBody.mode,
            output: outputType,
            durationMin: shortcutBody.minutes,
            context: shortcutBody.context ? {
              locationLabel: shortcutBody.context.location_label ?? null,
              locationLat: shortcutBody.context.location_lat ?? null,
              locationLon: shortcutBody.context.location_lon ?? null,
              isInMotion: shortcutBody.context.is_in_motion ?? null,
              bluetoothContext: shortcutBody.context.bluetooth_context ?? null,
              userNote: shortcutBody.context.user_note ?? null,
            } : null,
          }, env.KV);
          const verb = outputType === "queue" ? "Queued" : "Started";
          return Response.json({
            ok: true,
            summary: `${verb} ${shortcutResult.mode} session, ${shortcutResult.trackCount} tracks (${shortcutResult.familiarCount} familiar, ${shortcutResult.freshCount} fresh). ${shortcutResult.contextSummary.weatherCondition ?? ""} ${shortcutResult.contextSummary.tempF ? shortcutResult.contextSummary.tempF + "°F" : ""}`.trim(),
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

        case "/api/like-track":
        case "/api/block-track": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          const { track_id: actionTrackId } = await request.json() as { track_id: string };
          if (!actionTrackId) return Response.json({ ok: false, error: "track_id required" });

          const isBlock = url.pathname === "/api/block-track";
          const kvKey = isBlock ? "playlist:blocked" : "playlist:liked";
          const playlistName = isBlock ? "Blocked" : "Liked via Agent";

          // Get or create the dedicated playlist
          let playlistId = await env.KV.get(kvKey);
          if (!playlistId) {
            try {
              const pl = await spotify.post<{ id: string }>("/v1/me/playlists", {
                name: playlistName, public: false,
                description: isBlock
                  ? "Tracks blocked from curation agent — do not play"
                  : "Tracks liked from the curation agent dashboard",
              });
              playlistId = pl.id;
              await env.KV.put(kvKey, playlistId);
            } catch {
              return Response.json({ ok: false, error: "Failed to create playlist" });
            }
          }

          // Add track to the playlist
          try {
            await spotify.post(`/v1/playlists/${playlistId}/items`, {
              uris: [`spotify:track:${actionTrackId}`],
            });
            return Response.json({ ok: true, playlist: playlistName });
          } catch (e) {
            return Response.json({ ok: false, error: String(e) });
          }
        }

        case "/api/queue-track": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          const { track_id } = await request.json() as { track_id: string };
          if (!track_id) return Response.json({ ok: false, error: "track_id required" });
          const { getActiveDevice } = await import("./spotify/playback");
          const device = await getActiveDevice(spotify);
          await spotify.post("/v1/me/player/queue", undefined, {
            uri: `spotify:track:${track_id}`,
            ...(device?.id ? { device_id: device.id } : {}),
          });
          return Response.json({ ok: true });
        }

        case "/api/recent-history": {
          const since = Math.floor(Date.now() / 1000) - 24 * 3600;
          const rows = await env.DB.prepare(`
            SELECT pe.track_id, pe.started_at, pe.duration_listened_ms, pe.classification,
                   pe.hour_of_day, pe.device_type,
                   COALESCE(tt.track_name, po.track_name) as track_name,
                   tt.taste_score, tt.primary_artist_id
            FROM play_events pe
            LEFT JOIN track_taste tt ON tt.track_id = pe.track_id
            LEFT JOIN poll_observations po ON po.track_id = pe.track_id
            WHERE pe.started_at >= ?
            GROUP BY pe.id
            ORDER BY pe.started_at DESC
          `).bind(since).all();
          return Response.json(rows.results);
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
    })();
    return addCors(response);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;

    if (cron === "* * * * *") {
      // Every minute: poll Spotify for currently-playing, then derive events
      // Link new play events to the most recent context snapshot
      await handlePoll(env);
      const latestSnapshotId = await getLatestSnapshotId(env.DB);
      await derivePlayEvents(env.DB, latestSnapshotId);
    }

    if (cron === "0 * * * *") {
      // Every hour: capture a context snapshot for ambient tracking
      // This ensures every play event has a recent context to link to,
      // even outside of curated sessions
      await captureContextSnapshot(env.DB, "hourly_cron", {}, env.KV);
    }

    if (cron === "0 5 * * *") {
      // Daily at 5am UTC (1am ET): derive, rebuild taste + affinities, prune
      const snapshotId = await getLatestSnapshotId(env.DB);
      await derivePlayEvents(env.DB, snapshotId);
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
