/**
 * poll.ts — cron handler: fetch player state from Spotify, log to D1.
 *
 * Runs every 1 minute via Cloudflare Cron Trigger.
 * Uses /me/player (full player state) instead of /me/player/currently-playing
 * so we get device info, context, and playback state in one call.
 */

import { SpotifyClient } from "../spotify/client";
import { SpotifyCooldownError, SpotifyDisabledError } from "../spotify/rate-guard";
import { insertPollObservation, insertPlayEvent } from "../db/queries";

interface PlayerState {
  is_playing: boolean;
  item: {
    id: string;
    name: string;
    artists: Array<{ id: string; name: string }>;
    album: { id: string };
    duration_ms: number;
  } | null;
  progress_ms: number | null;
  device: { id: string; name: string; type: string; is_active: boolean } | null;
  context: { uri: string; type: string } | null;
}

export async function handlePoll(env: { DB: D1Database; KV: KVNamespace; SPOTIFY_CLIENT_ID: string; SPOTIFY_CLIENT_SECRET: string }): Promise<void> {
  const spotify = new SpotifyClient(env);
  const now = Math.floor(Date.now() / 1000);

  let data: PlayerState | null = null;
  try {
    data = await spotify.get<PlayerState>("/v1/me/player");
  } catch (err) {
    if (err instanceof SpotifyCooldownError || err instanceof SpotifyDisabledError) {
      // Cooldown/kill-switch active — skip poll entirely, don't call backfill
      return;
    }
    // 204 (nothing playing) comes back as undefined from our client
    data = null;
  }

  // Nothing playing or no track item
  if (!data || !data.item) {
    await insertPollObservation(env.DB, {
      observed_at: now,
      is_playing: 0,
      track_id: null,
      track_name: null,
      artist_ids: null,
      artist_name: null,
      album_id: null,
      progress_ms: null,
      duration_ms: null,
      device_type: null,
      context_uri: null,
      context_type: null,
    });
    return;
  }

  // Build device string: "Computer" or "Smartphone" etc.
  // Also store device name in context_uri field comment for richer data
  const deviceType = data.device?.type ?? null;

  await insertPollObservation(env.DB, {
    observed_at: now,
    is_playing: data.is_playing ? 1 : 0,
    track_id: data.item.id,
    track_name: data.item.name,
    artist_ids: JSON.stringify(data.item.artists.map(a => a.id)),
    artist_name: data.item.artists.map(a => a.name).join(", "),
    album_id: data.item.album.id,
    progress_ms: data.progress_ms,
    duration_ms: data.item.duration_ms,
    device_type: deviceType,
    context_uri: data.context?.uri ?? null,
    context_type: data.context?.type ?? null,
  });

  // Also cache the device name in KV for the dashboard
  if (data.device) {
    await env.KV.put("context:current_device", JSON.stringify({
      name: data.device.name,
      type: data.device.type,
      updatedAt: now,
    }));
  }

  // ── Backfill from recently-played to catch quick skips ──
  await backfillFromRecentlyPlayed(env.DB, env.KV, spotify);
}

interface RecentlyPlayedItem {
  track: {
    id: string;
    name: string;
    artists: Array<{ id: string; name: string }>;
    album: { id: string };
    duration_ms: number;
  };
  played_at: string;
  context: { uri: string; type: string } | null;
}

const USER_TZ = "America/New_York";

async function backfillFromRecentlyPlayed(
  db: D1Database,
  kv: KVNamespace,
  spotify: SpotifyClient
): Promise<void> {
  try {
    const rp = await spotify.get<{ items: RecentlyPlayedItem[] }>(
      "/v1/me/player/recently-played", { limit: "10" }
    );
    if (!rp.items || rp.items.length === 0) return;

    // Get watermark: the last played_at we've processed
    const watermarkStr = await kv.get("recently_played:watermark");
    const watermark = watermarkStr ? new Date(watermarkStr).getTime() : 0;

    // Filter to entries newer than the watermark (items are newest-first)
    const newItems = rp.items.filter(
      item => new Date(item.played_at).getTime() > watermark
    );
    if (newItems.length === 0) return;

    // Reverse to process oldest first
    newItems.reverse();

    for (let i = 0; i < newItems.length; i++) {
      const item = newItems[i];
      const playedAtUnix = Math.floor(new Date(item.played_at).getTime() / 1000);

      // Estimate when this track started playing:
      // gap between this entry's played_at and the previous entry's played_at
      let estimatedListenedMs: number;
      if (i > 0) {
        const prevPlayedAt = new Date(newItems[i - 1].played_at).getTime();
        const thisPlayedAt = new Date(item.played_at).getTime();
        estimatedListenedMs = Math.min(thisPlayedAt - prevPlayedAt, item.track.duration_ms);
      } else {
        // First item in batch — check against watermark or the full recently-played list
        const prevItem = rp.items.find(
          rpItem => new Date(rpItem.played_at).getTime() <= watermark
        );
        if (prevItem) {
          const gap = new Date(item.played_at).getTime() - new Date(prevItem.played_at).getTime();
          estimatedListenedMs = Math.min(gap, item.track.duration_ms);
        } else {
          // No reference point — assume completed
          estimatedListenedMs = item.track.duration_ms;
        }
      }

      const estimatedStartedAt = playedAtUnix - Math.floor(estimatedListenedMs / 1000);

      // Check if the regular poll already captured this track around this time
      const existing = await db.prepare(
        "SELECT id FROM poll_observations WHERE track_id = ? AND observed_at BETWEEN ? AND ? LIMIT 1"
      ).bind(item.track.id, estimatedStartedAt - 30, playedAtUnix + 30).first();

      if (existing) continue; // Already captured by regular polling

      // Reconciliation: if the most recent play_event was "abandoned" and
      // this is the same track, delete the abandoned event (track resumed)
      const lastEvent = await db.prepare(
        "SELECT id, track_id, classification FROM play_events ORDER BY ended_at DESC LIMIT 1"
      ).first<{ id: number; track_id: string; classification: string }>();
      if (lastEvent && lastEvent.track_id === item.track.id && lastEvent.classification === "abandoned") {
        await db.prepare("DELETE FROM play_event_context WHERE play_event_id = ?").bind(lastEvent.id).run();
        await db.prepare("DELETE FROM play_events WHERE id = ?").bind(lastEvent.id).run();
      }

      // Classify based on fraction played.
      // No reason_end available from the API — default incomplete plays
      // to "abandoned" rather than guessing skip from timing.
      const fractionPlayed = estimatedListenedMs / item.track.duration_ms;
      let classification: "completed" | "abandoned";
      classification = fractionPlayed >= 0.8 ? "completed" : "abandoned";

      // Insert a poll observation so track metadata is available for history joins
      await insertPollObservation(db, {
        observed_at: estimatedStartedAt,
        is_playing: 1,
        track_id: item.track.id,
        track_name: item.track.name,
        artist_ids: JSON.stringify(item.track.artists.map(a => a.id)),
        artist_name: item.track.artists.map(a => a.name).join(", "),
        album_id: item.track.album.id,
        progress_ms: estimatedListenedMs,
        duration_ms: item.track.duration_ms,
        device_type: null,
        context_uri: item.context?.uri ?? null,
        context_type: item.context?.type ?? null,
      });

      // Insert the play event directly (bypasses derive since we have full data)
      const startDate = new Date(estimatedStartedAt * 1000);
      const localTime = new Date(startDate.toLocaleString("en-US", { timeZone: USER_TZ }));

      await insertPlayEvent(db, {
        track_id: item.track.id,
        started_at: estimatedStartedAt,
        ended_at: playedAtUnix,
        duration_listened_ms: estimatedListenedMs,
        track_duration_ms: item.track.duration_ms,
        classification,
        context_uri: item.context?.uri ?? null,
        context_type: item.context?.type ?? null,
        device_type: null,
        hour_of_day: localTime.getHours(),
        day_of_week: localTime.getDay(),
        session_id: null,
      });
    }

    // Update watermark to the newest entry
    await kv.put("recently_played:watermark", rp.items[0].played_at);
  } catch (err) {
    // Cooldown errors are expected — don't log as failures
    if (err instanceof SpotifyCooldownError || err instanceof SpotifyDisabledError) return;
    // Other backfill failures shouldn't break the regular poll
    console.error(`backfill: ${err}`);
  }
}
