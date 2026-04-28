import { handleLogin, handleCallback } from "./auth/spotify-oauth";
import { SpotifyClient } from "./spotify/client";

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

        default:
          return new Response("Not found", { status: 404 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return new Response(message, { status: 500 });
    }
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron handlers will go here in M2+
  },
} satisfies ExportedHandler<Env>;
