import { handleLogin, handleCallback } from "./auth/spotify-oauth";
import { SpotifyClient } from "./spotify/client";
import { handlePoll } from "./tracker/poll";
import { derivePlayEvents } from "./tracker/derive";
import { getRecentPollObservations, getRecentPlayEvents, pruneOldObservations } from "./db/queries";
import { rebuildTasteModel } from "./taste/model";

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
      // Daily at 5am UTC (1am ET): derive, rebuild taste model, prune
      await derivePlayEvents(env.DB);
      const spotify = new SpotifyClient(env);
      await rebuildTasteModel(env.DB, spotify);
      await pruneOldObservations(env.DB, 30 * 24 * 60 * 60);
    }
  },
} satisfies ExportedHandler<Env>;
