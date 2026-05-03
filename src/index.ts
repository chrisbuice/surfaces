import { handleLogin, handleCallback, refreshAccessToken } from "./auth/spotify-oauth";
import { getTokens, saveTokens } from "./auth/tokens";
import { SpotifyClient } from "./spotify/client";
import { handlePoll } from "./tracker/poll";
import { derivePlayEvents } from "./tracker/derive";
import { getRecentPollObservations, getRecentPlayEvents, pruneOldObservations } from "./db/queries";
import { processFeedback } from "./curation/feedback";
import { rebuildAffinities } from "./context/affinity";
import { captureContext as captureContextSnapshot, getLatestSnapshotId } from "./context/capture";
import { generateAndSendSummary } from "./email/summary";
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
  RESEND_API_KEY: string;
  LASTFM_API_KEY?: string;
  // Shared secret for POST /api/submit-track. chrisbuice.com's Pages
  // Function adds it as the X-Surfaces-Secret header; this worker
  // verifies it before accepting a submission. Optional in dev — when
  // unset, the endpoint refuses submissions outright.
  SURFACES_SECRET?: string;
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
          return new Response("surfaces is running", { status: 200 });

        case "/app":
        case "/app/": {
          const dashboardHtml = (await import("./dashboard-html")).default;
          return new Response(dashboardHtml, {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        case "/manifest.json": {
          return Response.json({
            name: "Surfaces",
            short_name: "Sonic Life",
            start_url: "/app",
            display: "standalone",
            background_color: "#121212",
            theme_color: "#1db954",
            icons: [
              { src: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='45' fill='%231db954'/><text x='50' y='62' text-anchor='middle' font-size='40' fill='%23121212'>♫</text></svg>", sizes: "any", type: "image/svg+xml" }
            ],
          });
        }

        case "/auth/login":
          return handleLogin(request, env);

        case "/auth/callback":
          return await handleCallback(request, env);

        // ── Token broker for grimmauldplace containers ──
        // Protected by Cloudflare Access service token on /admin/*
        case "/admin/spotify-token": {
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          const tokens = await getTokens(env.KV);
          if (!tokens) {
            return Response.json({ error: "No Spotify tokens. Run /auth/login first." }, { status: 500 });
          }
          const now = Math.floor(Date.now() / 1000);
          if (now >= tokens.expiresAt - 300) {
            const refreshed = await refreshAccessToken(env, tokens.refreshToken);
            await saveTokens(env.KV, refreshed);
            return Response.json({ access_token: refreshed.accessToken, expires_at: refreshed.expiresAt });
          }
          return Response.json({ access_token: tokens.accessToken, expires_at: tokens.expiresAt });
        }

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
            // Check if this track is in the most recent active session
            let playContext: { inSession: boolean; mode?: string; source?: string; sourceDetail?: string; reasons?: string[] } = { inSession: false };
            const activeSess = await env.DB.prepare(
              "SELECT session_id, mode FROM sessions WHERE ended_at IS NULL ORDER BY invoked_at DESC LIMIT 1"
            ).first<{ session_id: string; mode: string }>();
            if (activeSess) {
              const st = await env.DB.prepare(
                "SELECT source FROM session_tracks WHERE session_id = ? AND track_id = ?"
              ).bind(activeSess.session_id, playing.item.id).first<{ source: string }>();
              if (st) {
                const isFresh = st.source.startsWith("fresh:");
                const reasons: string[] = [];
                if (isFresh) {
                  const fp = await env.DB.prepare(
                    "SELECT source_detail FROM fresh_pool WHERE track_id = ?"
                  ).bind(playing.item.id).first<{ source_detail: string | null }>();
                  reasons.push(fp?.source_detail ? `Discovery: ${fp.source_detail}` : "Fresh discovery");
                } else {
                  const taste = await env.DB.prepare(
                    `SELECT in_liked_songs, in_top_tracks_short, in_top_tracks_medium, in_top_tracks_long,
                            current_season_present, seasonal_playlist_count, play_count
                     FROM track_taste WHERE track_id = ?`
                  ).bind(playing.item.id).first<{
                    in_liked_songs: number; in_top_tracks_short: number; in_top_tracks_medium: number;
                    in_top_tracks_long: number; current_season_present: number;
                    seasonal_playlist_count: number; play_count: number;
                  }>();
                  if (taste) {
                    if (taste.in_top_tracks_short) reasons.push("In your current top tracks");
                    else if (taste.in_top_tracks_medium) reasons.push("In your medium-term favorites");
                    else if (taste.in_top_tracks_long) reasons.push("In your long-term favorites");
                    if (taste.in_liked_songs) reasons.push("Liked song");
                    if (taste.current_season_present) reasons.push("Current season playlist");
                    if (taste.play_count > 5) reasons.push(`Played ${taste.play_count} times`);
                    if (reasons.length === 0) reasons.push("Matches your taste profile");
                  }
                }
                playContext = { inSession: true, mode: activeSess.mode, source: isFresh ? "fresh" : "familiar", reasons };
              }
            }

            // If not in an active session, check if the track is a discovery from fresh_pool
            if (!playContext.inSession) {
              const fpCheck = await env.DB.prepare(
                "SELECT source, source_detail FROM fresh_pool WHERE track_id = ?"
              ).bind(playing.item.id).first<{ source: string; source_detail: string | null }>();
              if (fpCheck) {
                const sourceLabels: Record<string, string> = {
                  'editorial_rss': 'Editorial RSS',
                  'hype_machine': 'Hype Machine',
                  'rss:gorilla_vs_bear': 'Gorilla vs Bear',
                  'rss:aquarium_drunkard': 'Aquarium Drunkard',
                  'lastfm:artist_similar': 'Last.fm Similar',
                  'followed_artist_search': 'Followed Artists',
                  'top_artist_search': 'Top Artist Releases',
                };
                const label = sourceLabels[fpCheck.source] || fpCheck.source;
                const reason = fpCheck.source_detail || label;
                playContext = {
                  inSession: false,
                  source: "discovery",
                  sourceDetail: fpCheck.source,
                  reasons: [`Discovery: ${reason}`],
                };
              }
            }

            // Fetch upcoming queue (next 3 tracks)
            let upNext: Array<{ track_id: string; track_name: string; artist_name: string }> = [];
            try {
              const queue = await spotify.get<{
                queue: Array<{ id: string; name: string; artists: Array<{ name: string }> }>;
              }>("/v1/me/player/queue");
              // Filter out the currently playing track — Spotify's queue API
              // repeats it when playback was started with uris:[single_track]
              const currentId = playing.item?.id;
              upNext = (queue.queue ?? [])
                .filter(t => t.id !== currentId)
                .slice(0, 3)
                .map(t => ({
                  track_id: t.id,
                  track_name: t.name,
                  artist_name: t.artists.map(a => a.name).join(", "),
                }));
            } catch { /* queue endpoint may fail in Dev Mode */ }

            return Response.json({
              is_playing: playing.is_playing,
              track_id: playing.item.id,
              track_name: playing.item.name,
              artist_name: playing.item.artists.map(a => a.name).join(", "),
              progress_ms: playing.progress_ms,
              duration_ms: playing.item.duration_ms,
              device_name: playing.device?.name ?? null,
              device_type: playing.device?.type ?? null,
              play_context: playContext,
              up_next: upNext,
            });
          } catch {
            return Response.json({ is_playing: false });
          }
        }

        case "/api/constellation": {
          // Public, CORS-permissive (handled by addCors below). Reads the
          // nightly-rebuilt JSON blob from KV — the cron is the only writer.
          // Spec §7.2: 1h browser cache, 26h KV TTL on the underlying value.
          // Renderer-side contract (spec §8.5): a 404 or malformed JSON
          // means the renderer hides the constellation section gracefully.
          if (request.method !== "GET") {
            return new Response("Method not allowed", { status: 405 });
          }
          const { KV_KEY } = await import("./constellation/cron");
          const cached = await env.KV.get(KV_KEY);
          if (!cached) {
            return new Response(
              JSON.stringify({ error: "constellation not yet generated" }),
              {
                status: 404,
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "no-store",
                },
              },
            );
          }
          return new Response(cached, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        }

        case "/api/listening-by-month": {
          // Public, CORS-permissive. Nightly-rebuilt monthly play counts
          // cached in KV — same pattern as /api/constellation.
          if (request.method !== "GET") {
            return new Response("Method not allowed", { status: 405 });
          }
          const { LISTENING_BY_MONTH_KEY } = await import("./listening/page-queries");
          const lbmCached = await env.KV.get(LISTENING_BY_MONTH_KEY);
          if (!lbmCached) {
            return new Response(
              JSON.stringify({ error: "listening-by-month not yet generated" }),
              {
                status: 404,
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "no-store",
                },
              },
            );
          }
          return new Response(lbmCached, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        }

        case "/api/top-artists": {
          // Public, CORS-permissive. Nightly-rebuilt top 12 artists
          // cached in KV — same pattern as /api/constellation.
          if (request.method !== "GET") {
            return new Response("Method not allowed", { status: 405 });
          }
          const { TOP_ARTISTS_KEY } = await import("./listening/page-queries");
          const taCached = await env.KV.get(TOP_ARTISTS_KEY);
          if (!taCached) {
            return new Response(
              JSON.stringify({ error: "top-artists not yet generated" }),
              {
                status: 404,
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "no-store",
                },
              },
            );
          }
          return new Response(taCached, {
            status: 200,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "public, max-age=3600",
            },
          });
        }

        case "/api/submit-track": {
          // Spec §7.3. Public endpoint, but auth-gated via X-Surfaces-Secret
          // (chrisbuice.com's Pages Function attaches it). Insert-only.
          // Behavior: never show an error to the submitter — even on D1
          // failure we return a friendly 200 with a "queued" body so the
          // chrisbuice.com page can always show success.
          if (request.method !== "POST") {
            return new Response("Method not allowed", { status: 405 });
          }
          if (!env.SURFACES_SECRET) {
            // Refuse outright when unconfigured rather than accepting
            // unauthenticated traffic. Avoids accidentally-public POSTs.
            return new Response("Endpoint not configured", { status: 503 });
          }
          const headerSecret = request.headers.get("X-Surfaces-Secret");
          if (headerSecret !== env.SURFACES_SECRET) {
            return new Response("Unauthorized", { status: 401 });
          }

          let parsed: { track_id?: unknown; from?: unknown; note?: unknown };
          try {
            parsed = await request.json();
          } catch {
            return new Response("Invalid JSON", { status: 400 });
          }

          const rawTrack = typeof parsed.track_id === "string" ? parsed.track_id : "";
          const { canonicalizeTrackId, insertSubmission } = await import("./submissions/queries");
          const trackId = canonicalizeTrackId(rawTrack);
          if (!trackId) {
            return new Response("Invalid track_id", { status: 400 });
          }

          // Optional fields are trimmed, capped at sane lengths, and
          // collapsed to null when empty so the digest renders cleanly.
          const trimmedFrom = typeof parsed.from === "string"
            ? parsed.from.trim().slice(0, 80) : "";
          const trimmedNote = typeof parsed.note === "string"
            ? parsed.note.trim().slice(0, 300) : "";

          try {
            const id = await insertSubmission(env.DB, {
              track_id: trackId,
              submitter_name: trimmedFrom || null,
              note: trimmedNote || null,
            });
            return Response.json({
              ok: true,
              id,
              message: "Added to the discovery pool — I'll see it next time I run a session.",
            });
          } catch (err) {
            // Per spec §7.3 failure mode: never show an error to a
            // submitter. Log the underlying error for our own visibility,
            // return a friendly 200 so the chrisbuice.com page always
            // shows success.
            console.error(`submissions: insert failed: ${err}`);
            return Response.json({
              ok: true,
              queued: true,
              message: "Got it — queued, try again later if you don't see it surface.",
            });
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

        case "/debug/rebuild-constellation": {
          // One-shot trigger for the nightly constellation cron. Same code
          // path as the 6am ET scheduled run — runs the playlist sync, the
          // three SQL phases, layout, labeled-8, and writes to KV. Use this
          // to seed /api/constellation outside the cron window (e.g. right
          // after deploy so the endpoint doesn't 404 until tomorrow).
          const spotify = new SpotifyClient(env);
          const { runConstellationCron } = await import("./constellation/cron");
          const summary = await runConstellationCron(env.DB, spotify, env.KV);
          return Response.json(summary);
        }

        case "/debug/rebuild-page-data": {
          // One-shot trigger for the nightly page-data build. Rebuilds
          // /api/listening-by-month and /api/top-artists KV caches.
          // No auth — matches existing /debug/* pattern (decision D4).
          const {
            buildListeningByMonth, buildTopArtists,
            LISTENING_BY_MONTH_KEY: lbmKey, TOP_ARTISTS_KEY: taKey,
            KV_TTL_SECONDS: pageTtl,
          } = await import("./listening/page-queries");
          const [lbmResult, taResult] = await Promise.all([
            buildListeningByMonth(env.DB),
            buildTopArtists(env.DB),
          ]);
          await Promise.all([
            env.KV.put(lbmKey, JSON.stringify(lbmResult), { expirationTtl: pageTtl }),
            env.KV.put(taKey, JSON.stringify(taResult), { expirationTtl: pageTtl }),
          ]);
          return Response.json({
            listening_by_month: { months: lbmResult.months.length },
            top_artists: { artists: taResult.artists.map(a => a.name) },
          });
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

        case "/shortcut/update-location": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const locAuthHeader = request.headers.get("Authorization");
          const locToken = locAuthHeader?.replace("Bearer ", "");
          if (locToken !== env.SHORTCUT_TOKEN) return new Response("Unauthorized", { status: 401 });

          const locBody = await request.json() as {
            location_lat: number; location_lon: number;
            location_label?: string;
            altitude_m?: number;
            floor?: number;
            speed_mps?: number;
            is_in_motion?: number;
            bluetooth_context?: string;
            wifi_network?: string;
            user_note?: string;
          };

          if (!locBody.location_lat || !locBody.location_lon) {
            return Response.json({ ok: false, error: "location_lat and location_lon required" });
          }

          // Store full-precision location in KV (no rounding — office vs backyard matters)
          const { saveLastKnownLocation } = await import("./context/capture");
          await saveLastKnownLocation(env.KV, locBody.location_lat, locBody.location_lon, locBody.location_label ?? null);

          // Also store extended context signals in KV for the next snapshot
          await env.KV.put("context:last_shortcut_signals", JSON.stringify({
            isInMotion: locBody.is_in_motion ?? null,
            bluetoothContext: locBody.bluetooth_context ?? null,
            wifiNetwork: locBody.wifi_network ?? null,
            altitude_m: locBody.altitude_m ?? null,
            floor: locBody.floor ?? null,
            speed_mps: locBody.speed_mps ?? null,
            userNote: locBody.user_note ?? null,
            updatedAt: Math.floor(Date.now() / 1000),
          }));

          // Capture a context snapshot immediately with this location
          const { captureContext: capCtx } = await import("./context/capture");
          await capCtx(env.DB, "location_update", {
            locationLabel: locBody.location_label ?? null,
            locationLat: locBody.location_lat,
            locationLon: locBody.location_lon,
            isInMotion: locBody.is_in_motion ?? null,
            bluetoothContext: locBody.bluetooth_context ?? null,
            userNote: locBody.user_note ?? null,
          }, env.KV);

          return Response.json({
            ok: true,
            summary: `Location updated: ${locBody.location_label || `${locBody.location_lat.toFixed(6)}, ${locBody.location_lon.toFixed(6)}`}`,
          });
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

        case "/api/session-explain": {
          // Explain why each track was picked in the most recent session
          const lastSess = await env.DB.prepare(
            "SELECT session_id, mode, context_snapshot_id FROM sessions ORDER BY invoked_at DESC LIMIT 1"
          ).first<{ session_id: string; mode: string; context_snapshot_id: number | null }>();
          if (!lastSess) return Response.json({ error: "No sessions yet" });

          // Load acoustic centroid for the session's mode (for fit explanation)
          const { computeAcousticFit: explainFit, dominantDimension } = await import("./audio/fit");
          const { getOverrideCentroid } = await import("./audio/overrides");
          let explainCentroid = new Map<string, { mean: number; stddev: number }>();
          try {
            // Check for curated override first
            const override = getOverrideCentroid(lastSess.mode);
            if (override) {
              explainCentroid = override;
            } else {
              const explainMinSamples = 10;
              let cRows = await env.DB.prepare(
                "SELECT dimension, mean, stddev, sample_size FROM acoustic_profile WHERE mode = ?"
              ).bind(lastSess.mode).all<{ dimension: string; mean: number; stddev: number; sample_size: number }>();
              if (cRows.results.length === 0 || cRows.results[0].sample_size < explainMinSamples) {
                cRows = await env.DB.prepare(
                  "SELECT dimension, mean, stddev, sample_size FROM acoustic_profile WHERE mode = 'overall'"
                ).all<{ dimension: string; mean: number; stddev: number; sample_size: number }>();
              }
              if (cRows.results.length > 0 && cRows.results[0].sample_size >= explainMinSamples) {
                explainCentroid = new Map(cRows.results.map(r => [r.dimension, { mean: r.mean, stddev: r.stddev }]));
              }
            }
          } catch { /* no profile */ }

          const sessTracks = await env.DB.prepare(
            "SELECT position, track_id, source, outcome FROM session_tracks WHERE session_id = ? ORDER BY position"
          ).bind(lastSess.session_id).all<{
            position: number; track_id: string; source: string; outcome: string | null;
          }>();

          // Get taste data for each track
          const explanations = [];
          for (const st of sessTracks.results) {
            const taste = await env.DB.prepare(
              `SELECT track_name, taste_score, in_liked_songs, in_top_tracks_short,
                      in_top_tracks_medium, in_top_tracks_long, seasonal_playlist_count,
                      current_season_present, play_count, skip_count, complete_count
               FROM track_taste WHERE track_id = ?`
            ).bind(st.track_id).first<{
              track_name: string; taste_score: number; in_liked_songs: number;
              in_top_tracks_short: number; in_top_tracks_medium: number; in_top_tracks_long: number;
              seasonal_playlist_count: number; current_season_present: number;
              play_count: number; skip_count: number; complete_count: number;
            }>();

            const reasons: string[] = [];
            let freshEntry: { track_name: string; source: string; source_detail: string | null; taste_score: number } | null = null;
            if (st.source === "familiar") {
              if (taste) {
                if (taste.in_top_tracks_short) reasons.push("In your current top tracks");
                if (taste.in_top_tracks_medium) reasons.push("In your medium-term top tracks");
                if (taste.in_top_tracks_long) reasons.push("In your long-term top tracks");
                if (taste.in_liked_songs) reasons.push("In your liked songs");
                if (taste.current_season_present) reasons.push("In your current season playlist");
                if (taste.seasonal_playlist_count > 0 && !taste.current_season_present) reasons.push(`In ${taste.seasonal_playlist_count} seasonal playlist(s)`);
                if (taste.play_count > 3) reasons.push(`Played ${taste.play_count} times`);
                if (taste.complete_count > 2) reasons.push(`Completed ${taste.complete_count} times (low skip)`);
                if (reasons.length === 0) reasons.push("Matches your taste profile");
              } else {
                reasons.push("Familiar track");
              }
            } else {
              // Fresh track
              freshEntry = await env.DB.prepare(
                "SELECT track_name, source, source_detail, taste_score FROM fresh_pool WHERE track_id = ?"
              ).bind(st.track_id).first<{ track_name: string; source: string; source_detail: string | null; taste_score: number }>();
              if (freshEntry?.source_detail) {
                reasons.push(`Discovery: ${freshEntry.source_detail}`);
              } else {
                reasons.push("Fresh discovery");
              }
              reasons.push(`Predicted fit score: ${freshEntry?.taste_score?.toFixed(1) ?? "?"}`);
            }

            // Check if context biases were applied
            if (lastSess.context_snapshot_id) {
              const snap = await env.DB.prepare(
                "SELECT weather_condition, daylight_phase, device_type, location_label FROM context_snapshots WHERE id = ?"
              ).bind(lastSess.context_snapshot_id).first<{
                weather_condition: string | null; daylight_phase: string;
                device_type: string | null; location_label: string | null;
              }>();
              if (snap) {
                if (snap.weather_condition === "rain" || snap.weather_condition === "overcast") reasons.push(`Weather bias: ${snap.weather_condition}`);
                if (snap.daylight_phase === "night" && lastSess.mode === "unwinding") reasons.push("Night unwinding: comfort pick");
              }
            }

            let trackName = taste?.track_name ?? freshEntry?.track_name;
            if (!trackName) {
              const obs = await env.DB.prepare(
                "SELECT track_name FROM poll_observations WHERE track_id = ? AND track_name IS NOT NULL LIMIT 1"
              ).bind(st.track_id).first<{ track_name: string }>();
              trackName = obs?.track_name ?? st.track_id;
            }

            // Compute acoustic fit for explanation
            let acousticFit: number | null = null;
            let acousticFitNote: string | null = null;
            if (explainCentroid.size > 0) {
              const afRow = await env.DB.prepare(
                "SELECT acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence FROM track_audio_features WHERE track_id = ? AND acousticness IS NOT NULL"
              ).bind(st.track_id).first<{
                acousticness: number; danceability: number; energy: number;
                instrumentalness: number; liveness: number; loudness: number;
                speechiness: number; tempo: number; valence: number;
              }>();
              if (afRow) {
                acousticFit = explainFit(afRow, explainCentroid);
                const dom = dominantDimension(afRow, explainCentroid);
                if (dom && acousticFit !== null) {
                  if (acousticFit > 1.1) {
                    acousticFitNote = `${dom.direction === "high" ? "High" : "Low"} ${dom.dimension} match for ${lastSess.mode}`;
                  } else if (acousticFit < 0.9) {
                    acousticFitNote = `${dom.direction === "high" ? "High" : "Low"} ${dom.dimension} for ${lastSess.mode}`;
                  }
                }
              }
            }

            explanations.push({
              position: st.position + 1,
              trackId: st.track_id,
              trackName,
              source: st.source,
              outcome: st.outcome,
              score: taste?.taste_score ?? null,
              acousticFit: acousticFit !== null ? Math.round(acousticFit * 100) / 100 : null,
              acousticFitNote,
              reasons,
            });
          }

          return Response.json({
            sessionId: lastSess.session_id,
            mode: lastSess.mode,
            tracks: explanations,
          });
        }

        case "/api/top-affinities": {
          // Tracks with strongest learned affinities, grouped by context bucket
          const affinityRows = await env.DB.prepare(`
            SELECT tca.track_id, tca.dimension, tca.bucket, tca.affinity, tca.sample_size,
                   COALESCE(tt.track_name, fp.track_name) as track_name
            FROM track_context_affinity tca
            LEFT JOIN track_taste tt ON tt.track_id = tca.track_id
            LEFT JOIN fresh_pool fp ON fp.track_id = tca.track_id
            WHERE tca.sample_size >= 5 AND ABS(tca.affinity - 1.0) > 0.1
            ORDER BY tca.affinity DESC
          `).all<{
            track_id: string; dimension: string; bucket: string;
            affinity: number; sample_size: number; track_name: string | null;
          }>();

          // Group by dimension:bucket
          const groups = new Map<string, Array<{
            trackName: string; trackId: string; affinity: number; sampleSize: number;
          }>>();
          for (const row of affinityRows.results) {
            const key = `${row.dimension}:${row.bucket}`;
            const list = groups.get(key) ?? [];
            list.push({
              trackName: row.track_name ?? row.track_id,
              trackId: row.track_id,
              affinity: row.affinity,
              sampleSize: row.sample_size,
            });
            groups.set(key, list);
          }

          // Take top 5 tracks per bucket, format for dashboard
          const buckets = Array.from(groups.entries()).map(([key, tracks]) => {
            const [dimension, bucket] = key.split(":");
            return {
              dimension,
              bucket,
              label: `${bucket} (${dimension.replace(/_/g, " ")})`,
              tracks: tracks.slice(0, 5),
            };
          });

          return Response.json({ buckets, totalAffinities: affinityRows.results.length });
        }

        case "/debug/send-summary": {
          const emailResult = await generateAndSendSummary(env.DB, env.RESEND_API_KEY);
          return Response.json(emailResult);
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
          const dayParam = url.searchParams.get("day");
          const dayOverride = dayParam ? parseInt(dayParam) : undefined;
          const result = await runDiscoveryAgent(env.DB, spotify, dayOverride, env.LASTFM_API_KEY);
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
          const fpLimit = parseInt(url.searchParams.get("limit") ?? "20");
          const fpRows = await env.DB.prepare(`
            SELECT fp.*, at2.artist_name as primary_artist_name
            FROM fresh_pool fp
            LEFT JOIN artist_taste at2 ON at2.artist_id = fp.primary_artist_id
            WHERE fp.status = 'fresh'
            ORDER BY fp.taste_score DESC
            LIMIT ?
          `).bind(fpLimit).all();
          return Response.json(fpRows.results);
        }

        case "/debug/fresh-pool-stats": {
          const stats = await getFreshPoolStats(env.DB);
          return Response.json(stats);
        }

        case "/debug/audio-features": {
          const afTrackId = url.searchParams.get("track_id");
          if (!afTrackId) return Response.json({ error: "track_id query param required" }, { status: 400 });

          // Check if we already have features
          let row = await env.DB.prepare(
            "SELECT * FROM track_audio_features WHERE track_id = ?"
          ).bind(afTrackId).first();

          if (!row) {
            // Fetch live from ReccoBeats and store
            const { ReccoBeatsProvider } = await import("./audio/reccobeats");
            const provider = new ReccoBeatsProvider();
            const features = await provider.fetchBatch([afTrackId]);
            const now = Math.floor(Date.now() / 1000);
            const af = features.get(afTrackId);

            if (af) {
              await env.DB.prepare(`
                INSERT INTO track_audio_features
                  (track_id, acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence, source, fetched_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              `).bind(
                afTrackId, af.acousticness, af.danceability, af.energy,
                af.instrumentalness, af.liveness, af.loudness,
                af.speechiness, af.tempo, af.valence, "reccobeats", now
              ).run();
            } else {
              await env.DB.prepare(`
                INSERT INTO track_audio_features
                  (track_id, acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence, source, fetched_at)
                VALUES (?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
              `).bind(afTrackId, "reccobeats:not_found", now).run();
            }

            row = await env.DB.prepare(
              "SELECT * FROM track_audio_features WHERE track_id = ?"
            ).bind(afTrackId).first();
          }

          return Response.json(row);
        }

        case "/debug/audio-features-stats": {
          const afStats = await env.DB.prepare(`
            SELECT
              (SELECT COUNT(*) FROM track_taste) as total_tracks,
              (SELECT COUNT(*) FROM track_audio_features WHERE source != 'reccobeats:not_found') as with_features,
              (SELECT COUNT(*) FROM track_audio_features WHERE source = 'reccobeats:not_found') as not_found,
              (SELECT COUNT(*) FROM track_taste tt LEFT JOIN track_audio_features af ON af.track_id = tt.track_id WHERE af.track_id IS NULL) as missing
          `).first();
          return Response.json(afStats);
        }

        case "/debug/run-audio-backfill": {
          const { runAudioBackfill } = await import("./audio/backfill");
          const batchCount = Math.min(parseInt(url.searchParams.get("count") ?? "1") || 1, 10);
          let totalFetched = 0, totalNotFound = 0;
          for (let b = 0; b < batchCount; b++) {
            const r = await runAudioBackfill(env.DB);
            totalFetched += r.fetched;
            totalNotFound += r.notFound;
            if (r.remaining === 0) break;
          }
          return Response.json({ total_fetched: totalFetched, total_not_found: totalNotFound, batches_run: batchCount });
        }

        case "/debug/audio-features-not-found": {
          const nfRows = await env.DB.prepare(`
            SELECT af.track_id, tt.track_name, at2.artist_name, tt.taste_score, af.fetched_at
            FROM track_audio_features af
            JOIN track_taste tt ON tt.track_id = af.track_id
            LEFT JOIN artist_taste at2 ON at2.artist_id = tt.primary_artist_id
            WHERE af.source = 'reccobeats:not_found'
            ORDER BY tt.taste_score DESC
          `).all();
          return Response.json(nfRows.results);
        }

        case "/debug/acoustic-profile": {
          const profileMode = url.searchParams.get("mode");
          const minSamples = 10; // ACOUSTIC_PROFILE_MIN_SAMPLES

          let profileRows;
          if (profileMode) {
            profileRows = await env.DB.prepare(
              "SELECT mode, dimension, mean, stddev, sample_size, refreshed_at FROM acoustic_profile WHERE mode = ? ORDER BY dimension"
            ).bind(profileMode).all();
          } else {
            profileRows = await env.DB.prepare(
              "SELECT mode, dimension, mean, stddev, sample_size, refreshed_at FROM acoustic_profile ORDER BY mode, dimension"
            ).all();
          }

          const rows = profileRows.results.map((r: Record<string, unknown>) => ({
            ...r,
            status: (r.sample_size as number) >= minSamples ? "trained" : "insufficient",
          }));

          return Response.json(rows);
        }

        case "/debug/rebuild-acoustic-profile": {
          const { rebuildAcousticProfile } = await import("./audio/profile");
          const profileResult = await rebuildAcousticProfile(env.DB);
          return Response.json(profileResult);
        }

        case "/debug/lastfm-similar": {
          const lfmArtist = url.searchParams.get("artist");
          if (!lfmArtist) return Response.json({ error: "artist query param required" }, { status: 400 });
          if (!env.LASTFM_API_KEY) return Response.json({ error: "LASTFM_API_KEY not set" }, { status: 500 });
          const { LastFmClient } = await import("./discovery/lastfm");
          const lfm = new LastFmClient(env.LASTFM_API_KEY, env.DB);
          const lfmResult = await lfm.getSimilarArtists(lfmArtist, 10);
          return Response.json(lfmResult);
        }

        case "/debug/discovery-by-source": {
          const sourceRows = await env.DB.prepare(`
            SELECT
              CASE
                WHEN source LIKE 'lastfm:%' THEN 'lastfm'
                WHEN source LIKE 'editorial_rss%' THEN 'editorial_rss'
                WHEN source LIKE 'followed_artist%' THEN 'followed_artist'
                WHEN source LIKE 'top_artist%' THEN 'top_artist'
                ELSE source
              END as source_group,
              COUNT(*) as cnt,
              SUM(CASE WHEN status = 'fresh' THEN 1 ELSE 0 END) as fresh,
              SUM(CASE WHEN status = 'played' THEN 1 ELSE 0 END) as played,
              SUM(CASE WHEN status = 'liked' THEN 1 ELSE 0 END) as liked,
              SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
            FROM fresh_pool
            GROUP BY source_group
            ORDER BY cnt DESC
          `).all();
          return Response.json(sourceRows.results);
        }

        case "/debug/audio-features-table": {
          const afLimit = parseInt(url.searchParams.get("limit") ?? "50") || 50;
          const afRows = await env.DB.prepare(`
            SELECT tt.track_name, at2.artist_name, tt.taste_score,
                   af.acousticness, af.danceability, af.energy, af.instrumentalness,
                   af.liveness, af.loudness, af.speechiness, af.tempo, af.valence
            FROM track_taste tt
            JOIN track_audio_features af ON af.track_id = tt.track_id
            LEFT JOIN artist_taste at2 ON at2.artist_id = tt.primary_artist_id
            WHERE af.source != 'reccobeats:not_found'
            ORDER BY tt.taste_score DESC
            LIMIT ?
          `).bind(afLimit).all<{
            track_name: string; artist_name: string | null; taste_score: number;
            acousticness: number; danceability: number; energy: number;
            instrumentalness: number; liveness: number; loudness: number;
            speechiness: number; tempo: number; valence: number;
          }>();

          const dims = ["acousticness","danceability","energy","instrumentalness","liveness","loudness","speechiness","tempo","valence"];
          let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Audio Features</title>
<style>
body{font-family:-apple-system,sans-serif;background:#121212;color:#e0e0e0;padding:20px;margin:0;}
h1{color:#1db954;font-size:20px;}
table{border-collapse:collapse;font-size:13px;width:100%;}
th{text-align:left;color:#b3b3b3;padding:6px 8px;border-bottom:1px solid #333;cursor:pointer;user-select:none;}
th:hover{color:#1db954;}
td{padding:6px 8px;border-bottom:1px solid #1e1e1e;}
.num{text-align:right;font-variant-numeric:tabular-nums;}
.hi{color:#1db954;} .lo{color:#e74c3c;}
</style></head><body>
<h1>Audio Features — Top ${afRows.results.length} Tracks</h1>
<table id="t"><thead><tr>
<th>#</th><th>Track</th><th>Artist</th><th class="num">Score</th>`;
          for (const d of dims) html += `<th class="num">${d.slice(0,5)}</th>`;
          html += `</tr></thead><tbody>`;

          for (let i = 0; i < afRows.results.length; i++) {
            const r = afRows.results[i];
            html += `<tr><td>${i+1}</td><td>${r.track_name}</td><td>${r.artist_name ?? ""}</td><td class="num">${r.taste_score.toFixed(1)}</td>`;
            for (const d of dims) {
              const v = r[d as keyof typeof r] as number;
              const fmt = d === "loudness" ? v.toFixed(1) : d === "tempo" ? v.toFixed(0) : v.toFixed(3);
              const cls = d !== "loudness" && d !== "tempo" ? (v > 0.7 ? "num hi" : v < 0.1 ? "num lo" : "num") : "num";
              html += `<td class="${cls}">${fmt}</td>`;
            }
            html += `</tr>`;
          }

          html += `</tbody></table>
<script>
document.querySelectorAll('#t th').forEach((th,col)=>{
  let asc=true;
  th.onclick=()=>{
    const rows=[...document.querySelectorAll('#t tbody tr')];
    rows.sort((a,b)=>{
      const av=a.children[col].textContent, bv=b.children[col].textContent;
      const an=parseFloat(av), bn=parseFloat(bv);
      return isNaN(an)?av.localeCompare(bv):(asc?an-bn:bn-an);
    });
    asc=!asc;
    const tb=document.querySelector('#t tbody');
    rows.forEach(r=>tb.appendChild(r));
  };
});
</script></body></html>`;

          return new Response(html, { headers: { "Content-Type": "text/html" } });
        }

        case "/debug/playlist-tracks": {
          const playlistId = url.searchParams.get("id");
          if (!playlistId) return Response.json({ error: "id query param required" }, { status: 400 });
          const maxLimit = 1000;
          const trackLimit = Math.min(parseInt(url.searchParams.get("limit") ?? "200") || 200, maxLimit);

          const { getPlaylistTracksViaEmbed } = await import("./spotify/embed");
          const result = await getPlaylistTracksViaEmbed(playlistId, trackLimit);

          const tracks = result.tracks.map((t, i) => ({
            track_id: t.trackId,
            track_name: t.trackName,
            artist_names: t.artistNames,
            artist_ids: null,   // not available via embed
            album_name: null,   // not available via embed
            album_id: null,     // not available via embed
            added_at: null,     // not available via embed
            added_at_iso: null, // not available via embed
            duration_ms: t.durationMs,
            position: i,
          }));

          return Response.json({
            playlist_name: result.playlistName,
            track_count: result.tracks.length,
            source: "embed_scrape",
            note: "added_at, album, and artist_ids unavailable in Dev Mode (embed scraping fallback)",
            tracks,
          });
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
            // Update fresh_pool status if this is a discovery track
            const fpNow = Math.floor(Date.now() / 1000);
            const fpStatus = isBlock ? "skipped" : "liked";
            await env.DB.prepare(
              "UPDATE fresh_pool SET status = ?, status_changed_at = ? WHERE track_id = ? AND status IN ('fresh', 'queued', 'played')"
            ).bind(fpStatus, fpNow, actionTrackId).run();
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
          // Update fresh_pool status if this is a discovery track
          const qNow = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            "UPDATE fresh_pool SET status = 'queued', status_changed_at = ? WHERE track_id = ? AND status = 'fresh'"
          ).bind(qNow, track_id).run();
          return Response.json({ ok: true });
        }

        case "/api/player/skip": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          await spotify.post("/v1/me/player/next");
          return Response.json({ ok: true });
        }

        case "/api/player/previous": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          await spotify.post("/v1/me/player/previous");
          return Response.json({ ok: true });
        }

        case "/api/player/repeat": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          // Cycle: off → context → track → off
          const { state } = await request.json() as { state?: string };
          const nextState = state || "track";
          await spotify.put("/v1/me/player/repeat", undefined, { state: nextState });
          return Response.json({ ok: true, state: nextState });
        }

        case "/api/play-track": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          const { track_id: playTrackId } = await request.json() as { track_id: string };
          if (!playTrackId) return Response.json({ ok: false, error: "track_id required" });
          const { getActiveDevice: getDevice } = await import("./spotify/playback");
          const playDevice = await getDevice(spotify);
          await spotify.put("/v1/me/player/play", {
            uris: [`spotify:track:${playTrackId}`],
          }, playDevice?.id ? { device_id: playDevice.id } : undefined);
          // Update fresh_pool status if this track is a discovery
          const now = Math.floor(Date.now() / 1000);
          await env.DB.prepare(
            "UPDATE fresh_pool SET status = 'played', status_changed_at = ? WHERE track_id = ? AND status IN ('fresh', 'queued')"
          ).bind(now, playTrackId).run();
          return Response.json({ ok: true });
        }

        case "/api/listening/sync": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const spotify = new SpotifyClient(env);
          const { syncRecentPlays } = await import("./listening/sync");
          const syncResult = await syncRecentPlays(env.DB, spotify, env.KV);
          // Invalidate pulse cache so new plays show up
          if (syncResult.inserted > 0) {
            await env.KV.delete("dashboard:pulse");
          }
          return Response.json({ source: "local_history", ...syncResult });
        }

        case "/api/listening/queue": {
          if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
          const queueBody = await request.json() as { mode?: string; length_min?: number; seed?: string; familiarity?: number };
          const { generateQueue } = await import("./listening/queue");
          const queueResult = await generateQueue(env.DB, {
            mode: (queueBody.mode as "rediscover" | "reflection" | "morning" | "default") ?? "default",
            seed: queueBody.seed,
            lengthMin: queueBody.length_min ?? 60,
            familiarity: queueBody.familiarity ?? 0.5,
          });
          return Response.json(queueResult);
        }

        case "/api/dashboard-stats": {
          // Midnight ET today as unix timestamp
          const etNow = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
          const midnightET = new Date(etNow.getFullYear(), etNow.getMonth(), etNow.getDate());
          const todaySince = Math.floor(midnightET.getTime() / 1000);
          const weekSince = todaySince - 6 * 86400;

          // ── Today's listening ──
          const todayEvents = await env.DB.prepare(`
            SELECT classification, COUNT(*) as cnt, SUM(duration_listened_ms) as total_ms
            FROM play_events WHERE started_at >= ?
            GROUP BY classification
          `).bind(todaySince).all<{ classification: string; cnt: number; total_ms: number }>();

          let todayTracks = 0, todayListenedMs = 0;
          const todayBreakdown: Record<string, number> = { completed: 0, skipped: 0, partial: 0, replayed: 0 };
          for (const row of todayEvents.results) {
            todayTracks += row.cnt;
            todayListenedMs += row.total_ms ?? 0;
            todayBreakdown[row.classification] = row.cnt;
          }

          // ── Agent performance (today + this week) ──
          const agentToday = await env.DB.prepare(`
            SELECT COUNT(DISTINCT s.session_id) as sessions,
                   SUM(CASE WHEN st.outcome = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN st.outcome = 'skipped' THEN 1 ELSE 0 END) as skipped,
                   COUNT(st.id) as total_tracks
            FROM sessions s
            JOIN session_tracks st ON st.session_id = s.session_id
            WHERE s.invoked_at >= ?
          `).bind(todaySince).first<{ sessions: number; completed: number; skipped: number; total_tracks: number }>();

          const agentWeek = await env.DB.prepare(`
            SELECT COUNT(DISTINCT s.session_id) as sessions,
                   SUM(CASE WHEN st.outcome = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN st.outcome = 'skipped' THEN 1 ELSE 0 END) as skipped,
                   COUNT(st.id) as total_tracks
            FROM sessions s
            JOIN session_tracks st ON st.session_id = s.session_id
            WHERE s.invoked_at >= ?
          `).bind(weekSince).first<{ sessions: number; completed: number; skipped: number; total_tracks: number }>();

          // ── Discovery stats ──
          const freshToday = await env.DB.prepare(`
            SELECT COUNT(*) as played,
                   SUM(CASE WHEN pe.classification = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN pe.classification = 'skipped' THEN 1 ELSE 0 END) as skipped
            FROM play_events pe
            JOIN session_tracks st ON st.session_id = pe.session_id AND st.track_id = pe.track_id
            WHERE pe.started_at >= ? AND st.source LIKE 'fresh:%'
          `).bind(todaySince).first<{ played: number; completed: number; skipped: number }>();

          const freshWeek = await env.DB.prepare(`
            SELECT COUNT(*) as played,
                   SUM(CASE WHEN pe.classification = 'completed' THEN 1 ELSE 0 END) as completed,
                   SUM(CASE WHEN pe.classification = 'skipped' THEN 1 ELSE 0 END) as skipped
            FROM play_events pe
            JOIN session_tracks st ON st.session_id = pe.session_id AND st.track_id = pe.track_id
            WHERE pe.started_at >= ? AND st.source LIKE 'fresh:%'
          `).bind(weekSince).first<{ played: number; completed: number; skipped: number }>();

          const poolStats = await env.DB.prepare(`
            SELECT status, COUNT(*) as cnt FROM fresh_pool GROUP BY status
          `).all<{ status: string; cnt: number }>();
          const pool: Record<string, number> = {};
          for (const row of poolStats.results) pool[row.status] = row.cnt;

          // ── Taste model health ──
          const tasteHealth = await env.DB.prepare(`
            SELECT COUNT(*) as tracks_scored,
                   MAX(refreshed_at) as last_rebuilt
            FROM track_taste
          `).first<{ tracks_scored: number; last_rebuilt: number }>();

          const seasonalCount = await env.DB.prepare(
            "SELECT COUNT(*) as cnt FROM seasonal_playlists"
          ).first<{ cnt: number }>();

          return Response.json({
            today: {
              tracks: todayTracks,
              listenedMin: Math.round(todayListenedMs / 60000),
              completed: todayBreakdown.completed,
              skipped: todayBreakdown.skipped,
              partial: todayBreakdown.partial,
              skipRate: todayTracks > 0 ? Math.round(todayBreakdown.skipped / todayTracks * 100) : 0,
            },
            agent: {
              today: { sessions: agentToday?.sessions ?? 0, tracks: agentToday?.total_tracks ?? 0, completed: agentToday?.completed ?? 0, skipped: agentToday?.skipped ?? 0 },
              week: { sessions: agentWeek?.sessions ?? 0, tracks: agentWeek?.total_tracks ?? 0, completed: agentWeek?.completed ?? 0, skipped: agentWeek?.skipped ?? 0 },
            },
            discovery: {
              today: { played: freshToday?.played ?? 0, completed: freshToday?.completed ?? 0, skipped: freshToday?.skipped ?? 0 },
              week: { played: freshWeek?.played ?? 0, completed: freshWeek?.completed ?? 0, skipped: freshWeek?.skipped ?? 0 },
              pool: { fresh: pool.fresh ?? 0, queued: pool.queued ?? 0, played: pool.played ?? 0, liked: pool.liked ?? 0, skipped: pool.skipped ?? 0 },
            },
            tasteModel: {
              tracksScored: tasteHealth?.tracks_scored ?? 0,
              lastRebuilt: tasteHealth?.last_rebuilt ?? null,
              seasonalPlaylists: seasonalCount?.cnt ?? 0,
              freshPoolSize: Object.values(pool).reduce((a, b) => a + b, 0),
            },
          });
        }

        case "/api/recent-history": {
          const rows = await env.DB.prepare(`
            SELECT pe.track_id, pe.started_at, pe.duration_listened_ms, pe.classification,
                   pe.hour_of_day, pe.device_type, pe.session_id, pe.context_type, pe.context_uri,
                   COALESCE(tt.track_name, po.track_name) as track_name,
                   tt.taste_score, tt.primary_artist_id,
                   COALESCE(at2.artist_name, po.artist_name) as primary_artist_name,
                   st.source as session_source
            FROM play_events pe
            LEFT JOIN track_taste tt ON tt.track_id = pe.track_id
            LEFT JOIN poll_observations po ON po.track_id = pe.track_id
            LEFT JOIN artist_taste at2 ON at2.artist_id = tt.primary_artist_id
            LEFT JOIN session_tracks st ON st.session_id = pe.session_id AND st.track_id = pe.track_id
            GROUP BY pe.id
            ORDER BY pe.started_at DESC
            LIMIT 25
          `).all();
          return Response.json(rows.results);
        }

        case "/debug/all-playlists": {
          const spotify = new SpotifyClient(env);
          const { getUserPlaylists } = await import("./spotify/library");
          const pls = await getUserPlaylists(spotify, 500);
          return Response.json(pls.map(p => ({ id: p.id, name: p.name, tracks: p.items?.total ?? p.tracks?.total ?? 0 })));
        }

        case "/mcp": {
          const { handleMcp } = await import("./mcp/server");
          return await handleMcp(request, env);
        }

        // ── Listening History API ──
        case "/api/listening/heatmap": {
          const yearParam = url.searchParams.get("year");
          const year = yearParam ? parseInt(yearParam) : new Date().getUTCFullYear();
          const rows = await env.DB.prepare(
            `SELECT
               CAST(((ts / 86400) * 86400) AS INTEGER) as day_ts,
               COUNT(*) as plays
             FROM plays WHERE year = ?
             GROUP BY day_ts ORDER BY day_ts`
          ).bind(year).all<{ day_ts: number; plays: number }>();
          const heatmap = rows.results.map(r => ({
            date: new Date(r.day_ts * 1000).toISOString().split("T")[0],
            plays: r.plays,
          }));
          return Response.json({ source: "local_history", year, days: heatmap });
        }

        case "/api/listening/reflections": {
          const reflectionsJson = await import("./listening/data/reflections.json");
          const reflections = Array.isArray(reflectionsJson.default) ? reflectionsJson.default : reflectionsJson;
          const enriched = [];
          for (const reflection of reflections as Array<{ name: string; years: number[]; artists: string[]; summary: string }>) {
            const yearPlaceholders = reflection.years.map(() => "?").join(",");
            const stats = await env.DB.prepare(
              `SELECT COUNT(*) as plays,
                      ROUND(SUM(minutes) / 60.0, 1) as hours,
                      COUNT(DISTINCT spotify_track_uri) as tracks,
                      (SELECT COUNT(*) FROM (SELECT 1 FROM plays WHERE year IN (${yearPlaceholders}) GROUP BY artist_name COLLATE NOCASE)) as artists,
                      ROUND(100.0 * SUM(CASE WHEN reason_end = 'fwdbtn' THEN 1 ELSE 0 END) / COUNT(*), 1) as skip_rate
               FROM plays WHERE year IN (${yearPlaceholders})`
            ).bind(...reflection.years, ...reflection.years).first<{ plays: number; hours: number; tracks: number; artists: number; skip_rate: number }>();
            const topArtists = await env.DB.prepare(
              `SELECT artist_name, COUNT(*) as plays, ROUND(SUM(minutes)/60.0, 1) as hours
               FROM plays WHERE year IN (${yearPlaceholders})
               GROUP BY artist_name COLLATE NOCASE ORDER BY plays DESC LIMIT 8`
            ).bind(...reflection.years).all<{ artist_name: string; plays: number; hours: number }>();
            const topTrack = await env.DB.prepare(
              `SELECT track_name, artist_name, COUNT(*) as plays
               FROM plays WHERE year IN (${yearPlaceholders})
               GROUP BY track_name COLLATE NOCASE, artist_name COLLATE NOCASE
               ORDER BY plays DESC LIMIT 1`
            ).bind(...reflection.years).first<{ track_name: string; artist_name: string; plays: number }>();
            // Per-year play counts for mini sparkline
            const yearlySQL = `SELECT year, COUNT(*) as plays FROM plays WHERE year IN (${yearPlaceholders}) GROUP BY year ORDER BY year`;
            const yearly = await env.DB.prepare(yearlySQL).bind(...reflection.years)
              .all<{ year: number; plays: number }>();
            enriched.push({
              ...reflection,
              totalPlays: stats?.plays ?? 0,
              totalHours: stats?.hours ?? 0,
              uniqueTracks: stats?.tracks ?? 0,
              uniqueArtists: stats?.artists ?? 0,
              skipRate: stats?.skip_rate ?? 0,
              topTrack: topTrack ? { track: topTrack.track_name, artist: topTrack.artist_name, plays: topTrack.plays } : null,
              topArtistsByPlays: topArtists.results.map(a => ({ artist: a.artist_name, plays: a.plays, hours: a.hours })),
              yearlyPlays: yearly.results,
            });
          }
          return Response.json({ source: "local_history", reflections: enriched });
        }

        case "/api/listening/month": {
          const y = parseInt(url.searchParams.get("year") ?? "");
          const m = parseInt(url.searchParams.get("month") ?? "");
          if (!y || !m) return Response.json({ error: "year and month required" }, { status: 400 });
          const { getTimeMachine } = await import("./listening/queries");
          const result = await getTimeMachine(env.DB, y, m, 15);
          return Response.json({ source: "local_history", ...result });
        }

        case "/api/listening/intelligence": {
          // Agent performance and taste model health
          const intl = await (async () => {
            // 1. Session performance (last 30 sessions)
            const sessionsSQL = `
              SELECT s.session_id, s.mode, s.invoked_at,
                COUNT(st.id) as tracks,
                SUM(CASE WHEN st.outcome = 'completed' THEN 1 ELSE 0 END) as completed,
                SUM(CASE WHEN st.outcome = 'skipped' THEN 1 ELSE 0 END) as skipped,
                SUM(CASE WHEN st.outcome = 'replayed' THEN 1 ELSE 0 END) as replayed,
                SUM(CASE WHEN st.source LIKE 'fresh:%' THEN 1 ELSE 0 END) as fresh,
                SUM(CASE WHEN st.source LIKE 'fresh:%' AND st.outcome = 'completed' THEN 1 ELSE 0 END) as fresh_completed,
                SUM(CASE WHEN st.source LIKE 'fresh:%' AND st.outcome = 'skipped' THEN 1 ELSE 0 END) as fresh_skipped
              FROM sessions s
              JOIN session_tracks st ON st.session_id = s.session_id
              WHERE s.ended_at IS NOT NULL
              GROUP BY s.session_id
              ORDER BY s.invoked_at DESC LIMIT 30
            `;
            const sessions = await env.DB.prepare(sessionsSQL).all();

            // 2. Taste score calibration: skip rate by score tier
            const calibrationSQL = `
              SELECT
                CASE
                  WHEN tt.taste_score >= 25 THEN 'Loved (25+)'
                  WHEN tt.taste_score >= 15 THEN 'Strong (15-25)'
                  WHEN tt.taste_score >= 5 THEN 'Moderate (5-15)'
                  ELSE 'Low (<5)'
                END as tier,
                COUNT(pe.id) as plays,
                SUM(CASE WHEN pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as satisfied,
                SUM(CASE WHEN pe.classification = 'skipped' THEN 1 ELSE 0 END) as skipped
              FROM play_events pe
              JOIN track_taste tt ON tt.track_id = pe.track_id
              WHERE pe.session_id IS NOT NULL
              GROUP BY tier
              ORDER BY MIN(tt.taste_score) DESC
            `;
            const calibration = await env.DB.prepare(calibrationSQL).all();

            // 3. Agent wins: completed/replayed tracks from sessions with reasons
            const winsSQL = `
              SELECT st.track_id, st.source, st.outcome,
                COALESCE(tt.track_name, fp.track_name) as track_name,
                COALESCE(at2.artist_name, '') as artist_name,
                tt.taste_score, tt.in_liked_songs, tt.in_top_tracks_short,
                tt.in_top_tracks_medium, tt.play_count, tt.complete_count,
                s.mode, s.invoked_at
              FROM session_tracks st
              JOIN sessions s ON s.session_id = st.session_id
              LEFT JOIN track_taste tt ON tt.track_id = st.track_id
              LEFT JOIN artist_taste at2 ON at2.artist_id = tt.primary_artist_id
              LEFT JOIN fresh_pool fp ON fp.track_id = st.track_id
              WHERE st.outcome IN ('completed', 'replayed')
              ORDER BY s.invoked_at DESC
              LIMIT 25
            `;
            const wins = await env.DB.prepare(winsSQL).all();

            // 4. Discovery source effectiveness
            const discoverySQL = `
              SELECT
                CASE
                  WHEN fp.source LIKE 'lastfm:%' THEN 'Last.fm Similar'
                  WHEN fp.source = 'editorial_rss' THEN COALESCE(fp.source_detail, 'Editorial RSS')
                  WHEN fp.source LIKE 'rss:%' THEN REPLACE(REPLACE(fp.source, 'rss:', ''), '_', ' ')
                  WHEN fp.source = 'hype_machine' THEN 'Hype Machine'
                  WHEN fp.source = 'followed_artist_search' THEN 'Followed Artists'
                  WHEN fp.source = 'top_artist_search' THEN 'Top Artist Releases'
                  ELSE fp.source
                END as source_label,
                COUNT(*) as total,
                SUM(CASE WHEN fp.status = 'fresh' THEN 1 ELSE 0 END) as fresh,
                SUM(CASE WHEN fp.status = 'liked' THEN 1 ELSE 0 END) as liked,
                SUM(CASE WHEN fp.status = 'skipped' THEN 1 ELSE 0 END) as skipped,
                SUM(CASE WHEN fp.status IN ('played','liked') THEN 1 ELSE 0 END) as engaged,
                ROUND(AVG(fp.taste_score), 1) as avg_score
              FROM fresh_pool fp
              GROUP BY source_label
              ORDER BY total DESC
            `;
            const discovery = await env.DB.prepare(discoverySQL).all();

            // 5. Acoustic profile maturity per mode
            const acousticSQL = `
              SELECT mode, COUNT(*) as dimensions,
                MIN(sample_size) as min_samples, ROUND(AVG(sample_size)) as avg_samples,
                MAX(sample_size) as max_samples
              FROM acoustic_profile
              GROUP BY mode ORDER BY avg_samples DESC
            `;
            const acoustic = await env.DB.prepare(acousticSQL).all();

            // 6. Context maturity — show distinct trained BUCKETS per dimension,
            //    not raw track×bucket pair counts (which are always mostly undertrained)
            const contextSQL = `
              SELECT dimension,
                COUNT(DISTINCT bucket) as total_buckets,
                COUNT(DISTINCT CASE WHEN sample_size >= 5 THEN bucket END) as trained_buckets,
                COUNT(*) as total_affinities,
                SUM(CASE WHEN sample_size >= 5 THEN 1 ELSE 0 END) as trained_affinities,
                ROUND(AVG(sample_size), 1) as avg_samples
              FROM track_context_affinity
              GROUP BY dimension ORDER BY avg_samples DESC
            `;
            let context = await env.DB.prepare(contextSQL).all();

            // If live context table is empty, derive daylight + day_of_week from plays
            if (context.results.length === 0) {
              const daylightBucketsSQL = `
                SELECT
                  CASE
                    WHEN local_hour < 5 THEN 'night' WHEN local_hour < 7 THEN 'dawn'
                    WHEN local_hour < 10 THEN 'morning' WHEN local_hour < 17 THEN 'day'
                    WHEN local_hour < 20 THEN 'evening' ELSE 'dusk'
                  END as bucket, COUNT(*) as plays
                FROM plays GROUP BY bucket ORDER BY plays DESC
              `;
              const daylightBuckets = await env.DB.prepare(daylightBucketsSQL)
                .all<{ bucket: string; plays: number }>();
              const dowBucketsSQL = `
                SELECT CASE CAST(strftime('%w', ts, 'unixepoch') AS INTEGER)
                  WHEN 0 THEN 'Sun' WHEN 1 THEN 'Mon' WHEN 2 THEN 'Tue'
                  WHEN 3 THEN 'Wed' WHEN 4 THEN 'Thu' WHEN 5 THEN 'Fri' WHEN 6 THEN 'Sat'
                END as bucket, COUNT(*) as plays
                FROM plays GROUP BY bucket ORDER BY plays DESC
              `;
              const dowBuckets = await env.DB.prepare(dowBucketsSQL)
                .all<{ bucket: string; plays: number }>();

              context = {
                results: [
                  { dimension: "daylight_phase", total_buckets: 6, trained_buckets: daylightBuckets.results.length,
                    avg_samples: Math.round(260331 / 6), buckets: daylightBuckets.results, fromPlays: true },
                  { dimension: "day_of_week", total_buckets: 7, trained_buckets: dowBuckets.results.length,
                    avg_samples: Math.round(260331 / 7), buckets: dowBuckets.results, fromPlays: true },
                ],
                success: true, meta: { duration: 0 },
              } as any;
            } else {
              // Enrich live context with bucket-level detail
              for (const row of context.results as any[]) {
                const bucketsSQL = `
                  SELECT bucket, SUM(sample_size) as plays
                  FROM track_context_affinity WHERE dimension = ?
                  GROUP BY bucket ORDER BY plays DESC
                `;
                const buckets = await env.DB.prepare(bucketsSQL).bind(row.dimension)
                  .all<{ bucket: string; plays: number }>();
                row.buckets = buckets.results;
              }
            }

            // 7. Signal effectiveness: which signals predict completion in sessions
            // Single-pass signal effectiveness (avoids SQLite compound SELECT limit)
            const signalBaseSQL = `
              SELECT
                SUM(CASE WHEN tt.in_liked_songs = 1 THEN 1 ELSE 0 END) as liked_total,
                SUM(CASE WHEN tt.in_liked_songs = 1 AND pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as liked_sat,
                SUM(CASE WHEN tt.in_top_tracks_short = 1 THEN 1 ELSE 0 END) as top_short_total,
                SUM(CASE WHEN tt.in_top_tracks_short = 1 AND pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as top_short_sat,
                SUM(CASE WHEN tt.in_top_tracks_medium = 1 THEN 1 ELSE 0 END) as top_med_total,
                SUM(CASE WHEN tt.in_top_tracks_medium = 1 AND pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as top_med_sat,
                SUM(CASE WHEN tt.seasonal_playlist_count > 0 THEN 1 ELSE 0 END) as seasonal_total,
                SUM(CASE WHEN tt.seasonal_playlist_count > 0 AND pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as seasonal_sat,
                SUM(CASE WHEN tt.play_count >= 10 THEN 1 ELSE 0 END) as highplay_total,
                SUM(CASE WHEN tt.play_count >= 10 AND pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as highplay_sat
              FROM play_events pe
              JOIN track_taste tt ON tt.track_id = pe.track_id
              WHERE pe.session_id IS NOT NULL AND pe.classification IN ('completed','skipped','replayed','abandoned')
            `;
            const sigRow = await env.DB.prepare(signalBaseSQL).first<Record<string, number>>();
            // Fresh discovery needs a separate query (joins session_tracks)
            const freshSigSQL = `
              SELECT COUNT(*) as total,
                SUM(CASE WHEN pe.classification IN ('completed','replayed') THEN 1 ELSE 0 END) as sat
              FROM play_events pe
              JOIN session_tracks st ON st.session_id = pe.session_id AND st.track_id = pe.track_id
              WHERE st.source LIKE 'fresh:%' AND pe.session_id IS NOT NULL
                AND pe.classification IN ('completed','skipped','replayed','abandoned')
            `;
            const freshSig = await env.DB.prepare(freshSigSQL).first<{ total: number; sat: number }>();
            const sr = sigRow || {} as Record<string, number>;
            const signals = { results: [
              { signal: 'Liked Songs', has_signal: sr.liked_total || 0, satisfied_with: sr.liked_sat || 0 },
              { signal: 'Top Tracks (Short)', has_signal: sr.top_short_total || 0, satisfied_with: sr.top_short_sat || 0 },
              { signal: 'Top Tracks (Medium)', has_signal: sr.top_med_total || 0, satisfied_with: sr.top_med_sat || 0 },
              { signal: 'Seasonal Playlist', has_signal: sr.seasonal_total || 0, satisfied_with: sr.seasonal_sat || 0 },
              { signal: 'High Play Count (10+)', has_signal: sr.highplay_total || 0, satisfied_with: sr.highplay_sat || 0 },
              { signal: 'Fresh Discovery', has_signal: freshSig?.total || 0, satisfied_with: freshSig?.sat || 0 },
            ] };

            // 8. Overall health scores
            const totalSessionTracks = sessions.results.reduce((sum: number, s: any) => sum + (s.tracks || 0), 0);
            const totalCompleted = sessions.results.reduce((sum: number, s: any) => sum + (s.completed || 0), 0);
            const totalReplayed = sessions.results.reduce((sum: number, s: any) => sum + (s.replayed || 0), 0);
            const totalSkipped = sessions.results.reduce((sum: number, s: any) => sum + (s.skipped || 0), 0);
            const totalFresh = sessions.results.reduce((sum: number, s: any) => sum + (s.fresh || 0), 0);
            const totalFreshCompleted = sessions.results.reduce((sum: number, s: any) => sum + (s.fresh_completed || 0), 0);

            const satisfactionRate = totalSessionTracks > 0
              ? Math.round(((totalCompleted + totalReplayed) / totalSessionTracks) * 100) : 0;
            const discoveryHitRate = totalFresh > 0
              ? Math.round((totalFreshCompleted / totalFresh) * 100) : 0;
            const totalTrainedBuckets = context.results.reduce((s: number, c: any) => s + (c.trained_buckets || 0), 0);
            const totalBuckets = context.results.reduce((s: number, c: any) => s + (c.total_buckets || 0), 0);
            const trainedContextPct = totalBuckets > 0
              ? Math.round(totalTrainedBuckets / totalBuckets * 100) : 0;
            const acousticCoverage = acoustic.results.length > 0
              ? Math.round((acoustic.results.filter((a: any) => (a.min_samples || 0) >= 10).length / Math.max(1, acoustic.results.length)) * 100) : 0;

            return {
              source: "mixed",
              health: {
                satisfaction: satisfactionRate,
                discoveryHitRate,
                contextMaturity: trainedContextPct,
                acousticCoverage,
                totalSessions: sessions.results.length,
                totalTracksServed: totalSessionTracks,
              },
              sessions: sessions.results.map((s: any) => ({
                mode: s.mode,
                date: new Date((s.invoked_at || 0) * 1000).toISOString().split("T")[0],
                tracks: s.tracks,
                completed: s.completed,
                skipped: s.skipped,
                replayed: s.replayed,
                fresh: s.fresh,
                freshCompleted: s.fresh_completed,
                completionRate: s.tracks > 0 ? Math.round(((s.completed + s.replayed) / s.tracks) * 100) : 0,
              })),
              calibration: calibration.results,
              wins: wins.results.map((w: any) => ({
                track: w.track_name || w.track_id,
                artist: w.artist_name,
                trackId: w.track_id,
                outcome: w.outcome,
                source: w.source,
                tasteScore: w.taste_score != null ? Math.round(w.taste_score * 10) / 10 : null,
                mode: w.mode,
                date: new Date((w.invoked_at || 0) * 1000).toISOString().split("T")[0],
                signals: [
                  w.in_liked_songs ? "Liked" : null,
                  w.in_top_tracks_short ? "Top (4wk)" : null,
                  w.in_top_tracks_medium ? "Top (6mo)" : null,
                  w.play_count >= 10 ? `${w.play_count} plays` : null,
                  (w.source || "").startsWith("fresh:") ? "Discovery" : null,
                ].filter(Boolean),
              })),
              discovery: discovery.results,
              acoustic: acoustic.results,
              context: context.results,
              signals: signals.results.map((s: any) => ({
                signal: s.signal,
                tracks: s.has_signal || 0,
                satisfied: s.satisfied_with || 0,
                hitRate: (s.has_signal || 0) > 0 ? Math.round(((s.satisfied_with || 0) / s.has_signal) * 100) : 0,
              })),
            };
          })();
          return Response.json(intl);
        }

        case "/api/listening/discover": {
          // All fresh_pool entries grouped by source, with artist names
          const discoverFilter = url.searchParams.get("status") ?? "fresh";
          const discoverRows = await env.DB.prepare(`
            SELECT fp.track_id, fp.track_name, fp.source, fp.source_detail,
                   fp.taste_score, fp.status, fp.found_at,
                   at2.artist_name as primary_artist_name
            FROM fresh_pool fp
            LEFT JOIN artist_taste at2 ON at2.artist_id = fp.primary_artist_id
            WHERE fp.status IN ('fresh', 'queued', 'played', 'liked')
            ORDER BY fp.found_at DESC
          `).all<{
            track_id: string; track_name: string; source: string; source_detail: string | null;
            taste_score: number; status: string; found_at: number; primary_artist_name: string | null;
          }>();

          // Group by source for the UI
          const sourceGroups: Record<string, { label: string; color: string; tracks: unknown[] }> = {};
          const sourceLabels: Record<string, { label: string; color: string }> = {
            'editorial_rss': { label: 'Editorial RSS', color: 'var(--accent4)' },
            'hype_machine': { label: 'Hype Machine', color: 'var(--accent2)' },
            'rss:gorilla_vs_bear': { label: 'Gorilla vs Bear', color: 'var(--accent5)' },
            'rss:aquarium_drunkard': { label: 'Aquarium Drunkard', color: 'var(--accent3)' },
            'lastfm:artist_similar': { label: 'Last.fm Similar', color: 'var(--accent)' },
            'followed_artist_search': { label: 'Followed Artists', color: 'var(--accent)' },
            'top_artist_search': { label: 'Top Artist Releases', color: 'var(--accent)' },
          };

          for (const row of discoverRows.results) {
            const key = row.source;
            if (!sourceGroups[key]) {
              const info = sourceLabels[key] || { label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()), color: 'var(--accent)' };
              sourceGroups[key] = { label: info.label, color: info.color, tracks: [] };
            }
            sourceGroups[key].tracks.push({
              trackId: row.track_id,
              track: row.track_name,
              artist: row.primary_artist_name || row.source_detail || '',
              sourceDetail: row.source_detail,
              tasteScore: Math.round(row.taste_score * 10) / 10,
              status: row.status,
              foundAt: new Date(row.found_at * 1000).toISOString().split('T')[0],
            });
          }

          // Stats
          const discoverStats = await env.DB.prepare(`
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'fresh' THEN 1 ELSE 0 END) as fresh,
                   SUM(CASE WHEN status = 'played' THEN 1 ELSE 0 END) as played,
                   SUM(CASE WHEN status = 'liked' THEN 1 ELSE 0 END) as liked,
                   SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) as skipped
            FROM fresh_pool
          `).first<{ total: number; fresh: number; played: number; liked: number; skipped: number }>();

          return Response.json({
            source: "mixed",
            stats: discoverStats,
            sources: Object.values(sourceGroups),
          });
        }

        case "/api/listening/search": {
          const q = url.searchParams.get("q") ?? "";
          if (q.length < 2) return Response.json({ source: "local_history", results: [] });
          const { search } = await import("./listening/dashboard-queries");
          const results = await search(env.DB, q, 10);
          return Response.json({ source: "local_history", results });
        }

        case "/api/listening/track": {
          const name = url.searchParams.get("name") ?? "";
          const artist = url.searchParams.get("artist") ?? "";
          if (!name || !artist) return Response.json({ error: "name and artist required" }, { status: 400 });
          const { getTrackDetail } = await import("./listening/dashboard-queries");
          const detail = await getTrackDetail(env.DB, name, artist);
          if (!detail) return Response.json({ error: "Track not found" }, { status: 404 });
          return Response.json({ source: "local_history", ...detail });
        }

        case "/api/listening/artist": {
          const artistName = url.searchParams.get("name") ?? "";
          if (!artistName) return Response.json({ error: "name required" }, { status: 400 });
          const { getArtistDetail } = await import("./listening/dashboard-queries");
          const detail = await getArtistDetail(env.DB, artistName);
          if (!detail) return Response.json({ error: "Artist not found" }, { status: 404 });
          return Response.json({ source: "local_history", ...detail });
        }

        case "/api/listening/pulse": {
          // Check KV cache (5 min TTL)
          const cachedPulse = await env.KV.get("dashboard:pulse", "json");
          if (cachedPulse) return Response.json(cachedPulse);
          const { getPulseData } = await import("./listening/dashboard-queries");
          const pulse = await getPulseData(env.DB);
          const pulsePayload = { source: "local_history", ...pulse };
          await env.KV.put("dashboard:pulse", JSON.stringify(pulsePayload), { expirationTtl: 300 });
          return Response.json(pulsePayload);
        }

        case "/api/listening/trends": {
          // Check KV cache (1 hour TTL)
          const cached = await env.KV.get("dashboard:trends", "json");
          if (cached) return Response.json(cached);
          const { getTrendsData } = await import("./listening/dashboard-queries");
          const trends = await getTrendsData(env.DB);
          const payload = { source: "local_history", ...trends };
          await env.KV.put("dashboard:trends", JSON.stringify(payload), { expirationTtl: 3600 });
          return Response.json(payload);
        }

        case "/api/listening/hero": {
          // Fast hero: simple counts + rolling windows, no COLLATE NOCASE
          const heroNow = Math.floor(Date.now() / 1000);
          const heroSQL = `
            SELECT COUNT(*) as plays, ROUND(SUM(minutes)/60.0,1) as hours,
                   COUNT(DISTINCT spotify_track_uri) as tracks,
                   COUNT(DISTINCT artist_name) as artists
            FROM plays
          `;
          const heroStats = await env.DB.prepare(heroSQL)
            .first<{ plays: number; hours: number; tracks: number; artists: number }>();
          const { getRollingWindows } = await import("./listening/dashboard-queries");
          const windows = await getRollingWindows(env.DB);
          return Response.json({
            source: "local_history",
            totalPlays: heroStats?.plays ?? 0,
            totalHours: heroStats?.hours ?? 0,
            totalTracks: heroStats?.tracks ?? 0,
            totalArtists: heroStats?.artists ?? 0,
            last7days: windows.week.plays,
            last7daysDelta: windows.week.deltaPct,
            last30days: windows.month.plays,
            last30daysDelta: windows.month.deltaPct,
          });
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

    if (cron === "0 5 * * *") {
      // One-time migration: reclassify old "skipped" and "partial" play_events as "abandoned"
      // (old heuristic couldn't distinguish pauses from skips; conservative reclassification)
      const migrated = await env.KV.get("migration:abandon_reclassify");
      if (!migrated) {
        await env.DB.prepare(
          "UPDATE play_events SET classification = 'abandoned' WHERE classification IN ('skipped', 'partial')"
        ).run();
        await env.KV.put("migration:abandon_reclassify", new Date().toISOString());
      }

      // One-time migration: reset "queued" fresh pool entries to "fresh".
      // "queued" was a premature status set at session build time that drained the pool.
      // Now tracks only leave the pool on actual listening outcomes (played/liked/skipped).
      const poolMigrated = await env.KV.get("migration:fresh_pool_queued_reset");
      if (!poolMigrated) {
        await env.DB.prepare(
          "UPDATE fresh_pool SET status = 'fresh' WHERE status = 'queued'"
        ).run();
        await env.KV.put("migration:fresh_pool_queued_reset", new Date().toISOString());
      }

      // Daily at 5am UTC (1am ET): sync recent plays, derive, rebuild taste + affinities, audio backfill, prune
      const spotify = new SpotifyClient(env);

      // Sync recent plays from Spotify into the plays table (before taste rebuild)
      const { syncRecentPlays } = await import("./listening/sync");
      await syncRecentPlays(env.DB, spotify, env.KV);

      const snapshotId = await getLatestSnapshotId(env.DB);
      await derivePlayEvents(env.DB, snapshotId);
      await rebuildTasteModel(env.DB, spotify);
      await rebuildAffinities(env.DB);

      // Audio features backfill — runs after taste rebuild so newly-scored
      // tracks are immediately eligible. Single batch request to ReccoBeats.
      const { runAudioBackfill } = await import("./audio/backfill");
      await runAudioBackfill(env.DB);

      // Rebuild acoustic profile centroids from play history + audio features
      const { rebuildAcousticProfile } = await import("./audio/profile");
      await rebuildAcousticProfile(env.DB);

      // Promote yesterday's submitted tracks (status='notified', already
      // surfaced in the digest email) into fresh_pool. Runs after the
      // taste/audio rebuild so the curation engine sees them on the very
      // next session. Failures are logged but never raise — submissions
      // are non-critical to the rest of the nightly chain.
      try {
        const { syncSubmissionsToFreshPool } = await import("./submissions/fresh_pool_sync");
        const subResult = await syncSubmissionsToFreshPool(env.DB, spotify);
        if (subResult.candidates > 0) {
          console.log(
            `submissions: synced ${subResult.added} added, ` +
            `${subResult.already_present} already present, ${subResult.rejected} rejected`,
          );
        }
      } catch (err) {
        console.error(`submissions: fresh_pool sync failed: ${err}`);
      }

      await pruneOldObservations(env.DB, 30 * 24 * 60 * 60);
    }

    if (cron === "0 10 * * *") {
      // Daily at 10am UTC (6am ET): discovery agent, then constellation rebuild.
      // Both run after the 1am ET taste rebuild + audio backfill so they see
      // the freshest artist_taste data. The constellation runs after discovery
      // so a future change that has discovery write artist rows still flows in.
      const spotify = new SpotifyClient(env);
      await runDiscoveryAgent(env.DB, spotify, undefined, env.LASTFM_API_KEY);

      const { runConstellationCron } = await import("./constellation/cron");
      try {
        const summary = await runConstellationCron(env.DB, spotify, env.KV);
        console.log(`constellation: rebuilt — ${summary.nodes} nodes, ${summary.edges} edges`);
      } catch (err) {
        console.error(`constellation: rebuild failed: ${err}`);
      }

      // Rebuild /surfaces page data (listening-by-month + top-artists).
      // Runs after constellation so all nightly visuals update together.
      try {
        const {
          buildListeningByMonth, buildTopArtists,
          LISTENING_BY_MONTH_KEY, TOP_ARTISTS_KEY, KV_TTL_SECONDS,
        } = await import("./listening/page-queries");
        const [lbm, ta] = await Promise.all([
          buildListeningByMonth(env.DB),
          buildTopArtists(env.DB),
        ]);
        await Promise.all([
          env.KV.put(LISTENING_BY_MONTH_KEY, JSON.stringify(lbm), { expirationTtl: KV_TTL_SECONDS }),
          env.KV.put(TOP_ARTISTS_KEY, JSON.stringify(ta), { expirationTtl: KV_TTL_SECONDS }),
        ]);
        console.log(`page-data: rebuilt — ${lbm.months.length} months, ${ta.artists.length} artists`);
      } catch (err) {
        console.error(`page-data: rebuild failed: ${err}`);
      }
    }

    if (cron === "*/2 * * * *") {
      // Every 2 minutes: check for active session and process feedback
      await processFeedback(env.DB);

      // Check if a sync follow-up is needed (50-play cap hit)
      const needsFollowup = await env.KV.get("sync:needs_followup");
      if (needsFollowup) {
        await env.KV.delete("sync:needs_followup");
        const spotify = new SpotifyClient(env);
        const { syncRecentPlays } = await import("./listening/sync");
        await syncRecentPlays(env.DB, spotify, env.KV);
      }

      // On the hour (minute 0): capture an ambient context snapshot
      const currentMinute = new Date().getUTCMinutes();
      if (currentMinute < 2) {
        let cronInput: Record<string, unknown> = {};
        const signalsRaw = await env.KV.get("context:last_shortcut_signals");
        if (signalsRaw) {
          try {
            const signals = JSON.parse(signalsRaw);
            const ageMin = (Math.floor(Date.now() / 1000) - signals.updatedAt) / 60;
            if (ageMin < 120) {
              cronInput = {
                isInMotion: signals.isInMotion,
                bluetoothContext: signals.bluetoothContext,
                userNote: signals.userNote,
              };
            }
          } catch { /* ignore */ }
        }
        await captureContextSnapshot(env.DB, "hourly_cron", cronInput, env.KV);
      }
    }

    if (cron === "0 0 * * *") {
      // Midnight UTC (8pm ET): send nightly listening summary
      await generateAndSendSummary(env.DB, env.RESEND_API_KEY);
    }

  },
} satisfies ExportedHandler<Env>;
