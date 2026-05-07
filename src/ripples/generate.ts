/**
 * generate.ts — Orchestrates ripples snapshot generation.
 *
 * Queries plays from D1, computes ripple scores, familiarity, generates
 * facts (LLM + fallback), and writes a snapshot row.
 */

import Anthropic from "@anthropic-ai/sdk";
import { SpotifyClient } from "../spotify/client";
import {
  computeRippleScore,
  computeFamiliarityScore,
  percentileRank,
  splitArrivalsAndWaves,
  type TrackRipple,
  type RippleWithFamiliarity,
} from "./scoring";
import { pickHardcodedFact, validateLLMFact, buildFactPrompt, type FactInput } from "./facts";

const WINDOW_DAYS = 14;
const TOP_N = 10;

interface PlayRow {
  spotify_track_uri: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  ts: number;
}

interface TrackMetaRow {
  spotify_track_uri: string;
  lifetime_plays: number;
  first_play_ts: number;
  last_play_before_window_ts: number | null;
}

interface ArtistPlayRow {
  artist_name: string;
  total_plays: number;
}

interface SpotifyTrackResponse {
  album?: {
    images?: Array<{ url: string; width: number; height: number }>;
  };
}

export interface RipplesPayload {
  new_arrivals: RipplePayloadItem[];
  returning_waves: RipplePayloadItem[];
}

export interface RipplePayloadItem {
  track_id: string;
  title: string;
  artist: string;
  album: string;
  album_art_url: string | null;
  ripple_score: number;
  familiarity_score: number;
  lifetime_plays: number;
  plays_in_window: number;
  fact_llm: string | null;
  fact_fallback: string;
  fact_used: "llm" | "fallback";
}

export interface SnapshotResult {
  generated_at: string;
  window_start: string;
  window_end: string;
  composite_familiarity: number;
  total_plays_in_window: number;
  payload: RipplesPayload;
}

export async function generateRipplesSnapshot(
  db: D1Database,
  spotify: SpotifyClient,
  anthropicApiKey: string,
): Promise<SnapshotResult> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - WINDOW_DAYS * 86400;
  const windowEnd = now;

  // 1. Get all plays in the 14-day window
  const { results: windowPlays } = await db
    .prepare(
      `SELECT spotify_track_uri, track_name, artist_name, album_name, ts
       FROM plays
       WHERE ts >= ? AND ts <= ?
       ORDER BY ts DESC`,
    )
    .bind(windowStart, windowEnd)
    .all<PlayRow>();

  if (!windowPlays.length) {
    throw new Error("No plays found in the 14-day window. Cannot generate ripples.");
  }

  // 2. Group plays by track URI
  const trackPlays = new Map<string, PlayRow[]>();
  for (const play of windowPlays) {
    const existing = trackPlays.get(play.spotify_track_uri) || [];
    existing.push(play);
    trackPlays.set(play.spotify_track_uri, existing);
  }

  // 3. Get lifetime play counts + first/last play for all tracks in window
  const trackUris = [...trackPlays.keys()];
  const trackMeta = new Map<string, TrackMetaRow>();

  for (const uri of trackUris) {
    const row = await db
      .prepare(
        `SELECT
           spotify_track_uri,
           COUNT(*) as lifetime_plays,
           MIN(ts) as first_play_ts,
           MAX(CASE WHEN ts < ? THEN ts ELSE NULL END) as last_play_before_window_ts
         FROM plays
         WHERE spotify_track_uri = ?
         GROUP BY spotify_track_uri`,
      )
      .bind(windowStart, uri)
      .first<TrackMetaRow>();

    if (row) {
      trackMeta.set(uri, row);
    }
  }

  // 4. Compute ripple scores and take top 10
  const scoredTracks: TrackRipple[] = [];

  for (const [uri, plays] of trackPlays) {
    const meta = trackMeta.get(uri);
    if (!meta) continue;

    const representativePlay = plays[0];
    const timestamps = plays.map((p) => p.ts);
    const { ripple_score, weighted_recent_plays, plays_in_window } = computeRippleScore(
      timestamps,
      meta.lifetime_plays,
      windowEnd,
    );

    scoredTracks.push({
      spotify_track_uri: uri,
      track_name: representativePlay.track_name,
      artist_name: representativePlay.artist_name,
      album_name: representativePlay.album_name,
      ripple_score,
      lifetime_plays: meta.lifetime_plays,
      plays_in_window,
      weighted_recent_plays,
      first_play_ts: meta.first_play_ts,
      last_play_before_window_ts: meta.last_play_before_window_ts,
    });
  }

  scoredTracks.sort((a, b) => b.ripple_score - a.ripple_score);
  const top10 = scoredTracks.slice(0, TOP_N);

  // 5. Compute familiarity scores using PRE-WINDOW play counts only.
  // This prevents current-window binge-listening from inflating familiarity
  // for brand-new discoveries.
  const { results: allArtists } = await db
    .prepare(
      `SELECT artist_name, COUNT(*) as total_plays
       FROM plays WHERE ts < ? GROUP BY artist_name ORDER BY total_plays ASC`,
    )
    .bind(windowStart)
    .all<ArtistPlayRow>();

  const allArtistPlays = allArtists.map((a) => a.total_plays);
  const artistPlayMap = new Map(allArtists.map((a) => [a.artist_name, a.total_plays]));

  const { results: allTrackCounts } = await db
    .prepare(
      `SELECT COUNT(*) as cnt FROM plays WHERE ts < ? GROUP BY spotify_track_uri ORDER BY cnt ASC`,
    )
    .bind(windowStart)
    .all<{ cnt: number }>();

  const allTrackPlays = allTrackCounts.map((r) => r.cnt);

  // 6. Fetch album art from Spotify for the top 10
  const trackSpotifyData = new Map<string, { album_art_url: string | null }>();

  const spotifyFetches = top10.map(async (track) => {
    try {
      const trackId = track.spotify_track_uri.replace("spotify:track:", "");
      const data = await spotify.get<SpotifyTrackResponse>(`/v1/tracks/${trackId}`);
      const images = data?.album?.images || [];
      const art = images.find((i) => i.width === 300) || images[0];
      trackSpotifyData.set(track.spotify_track_uri, {
        album_art_url: art?.url || null,
      });
    } catch {
      trackSpotifyData.set(track.spotify_track_uri, {
        album_art_url: null,
      });
    }
  });

  await Promise.all(spotifyFetches);

  // 7. Build RippleWithFamiliarity for each top-10 track
  // Familiarity uses pre-window play counts (from the filtered queries above).
  // Artists/tracks with zero pre-window plays get 0 from percentileRank.
  const ripplesWithFamiliarity: RippleWithFamiliarity[] = top10.map((track) => {
    const spotifyData = trackSpotifyData.get(track.spotify_track_uri) || {
      album_art_url: null,
    };
    const artistPreWindowPlays = artistPlayMap.get(track.artist_name) || 0;

    // Pre-window track plays: lifetime minus in-window
    const trackPreWindowPlays = Math.max(0, track.lifetime_plays - track.plays_in_window);

    const familiarity_score = computeFamiliarityScore({
      artist_lifetime_plays: artistPreWindowPlays,
      all_artists_plays: allArtistPlays,
      track_lifetime_plays: trackPreWindowPlays,
      all_tracks_plays: allTrackPlays,
    });

    return {
      ...track,
      familiarity_score,
      album_art_url: spotifyData.album_art_url,
    };
  });

  // 8. Split into new arrivals and returning waves
  const { new_arrivals, returning_waves } = splitArrivalsAndWaves(ripplesWithFamiliarity, windowEnd);
  const allRipples = [...new_arrivals, ...returning_waves];

  // 9. Compute fact inputs for each track
  const factInputs = new Map<string, FactInput>();

  for (const ripple of allRipples) {
    const artistPlays = artistPlayMap.get(ripple.artist_name) || 0;

    // Plays before window for this artist
    const artistBeforeRow = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM plays
         WHERE artist_name = ? AND ts < ?`,
      )
      .bind(ripple.artist_name, windowStart)
      .first<{ cnt: number }>();

    const trackBeforeRow = await db
      .prepare(
        `SELECT COUNT(*) as cnt FROM plays
         WHERE spotify_track_uri = ? AND ts < ?`,
      )
      .bind(ripple.spotify_track_uri, windowStart)
      .first<{ cnt: number }>();

    const trackPlaysBefore = trackBeforeRow?.cnt || 0;
    const artistPlaysBefore = artistBeforeRow?.cnt || 0;

    // Average weekly rate: plays before window / weeks since first play
    let avgWeeklyRate = 0;
    if (ripple.first_play_ts && trackPlaysBefore > 0) {
      const weeksSinceFirst = (windowStart - ripple.first_play_ts) / (7 * 86400);
      if (weeksSinceFirst > 0) {
        avgWeeklyRate = trackPlaysBefore / weeksSinceFirst;
      }
    }

    factInputs.set(ripple.spotify_track_uri, {
      track_name: ripple.track_name,
      artist_name: ripple.artist_name,
      lifetime_plays: ripple.lifetime_plays,
      plays_in_window: ripple.plays_in_window,
      weighted_recent_plays: ripple.weighted_recent_plays,
      first_play_ts: ripple.first_play_ts,
      last_play_before_window_ts: ripple.last_play_before_window_ts,
      artist_lifetime_plays: artistPlays,
      artist_percentile: percentileRank(allArtistPlays, artistPlays),
      is_new_arrival: new_arrivals.some((a) => a.spotify_track_uri === ripple.spotify_track_uri),
      window_end: windowEnd,
      artist_plays_before_window: artistPlaysBefore,
      track_plays_before_window: trackPlaysBefore,
      avg_weekly_rate: avgWeeklyRate,
    });
  }

  // 10. Generate hardcoded facts for all tracks
  const hardcodedFacts = new Map<string, string>();
  for (const [uri, input] of factInputs) {
    hardcodedFacts.set(uri, pickHardcodedFact(input));
  }

  // 11. Generate LLM facts (parallel, with timeout and fallback)
  const llmFacts = new Map<string, string | null>();

  try {
    const anthropic = new Anthropic({ apiKey: anthropicApiKey });

    const llmPromises = allRipples.map(async (ripple) => {
      const input = factInputs.get(ripple.spotify_track_uri)!;
      const { system, user } = buildFactPrompt(input);

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);

        const response = await anthropic.messages.create(
          {
            model: "claude-sonnet-4-20250514",
            max_tokens: 50,
            system,
            messages: [{ role: "user", content: user }],
          },
          { signal: controller.signal },
        );

        clearTimeout(timeout);

        const text =
          response.content[0]?.type === "text" ? response.content[0].text.trim() : null;

        if (text) {
          const validation = validateLLMFact(text);
          if (validation.valid) {
            llmFacts.set(ripple.spotify_track_uri, text);
            return;
          }
          console.log(
            `LLM fact validation failed for ${ripple.track_name}: ${validation.reason} — "${text}"`,
          );
        }
        llmFacts.set(ripple.spotify_track_uri, null);
      } catch (err) {
        console.log(`LLM fact generation failed for ${ripple.track_name}: ${err}`);
        llmFacts.set(ripple.spotify_track_uri, null);
      }
    });

    await Promise.all(llmPromises);
  } catch (err) {
    console.log(`Anthropic client initialization failed: ${err}`);
    // All facts fall back to hardcoded
    for (const ripple of allRipples) {
      llmFacts.set(ripple.spotify_track_uri, null);
    }
  }

  // 12. Build payload
  function buildPayloadItem(ripple: RippleWithFamiliarity): RipplePayloadItem {
    const factLlm = llmFacts.get(ripple.spotify_track_uri) ?? null;
    const factFallback = hardcodedFacts.get(ripple.spotify_track_uri)!;
    return {
      track_id: ripple.spotify_track_uri.replace("spotify:track:", ""),
      title: ripple.track_name,
      artist: ripple.artist_name,
      album: ripple.album_name,
      album_art_url: ripple.album_art_url,
      ripple_score: ripple.ripple_score,
      familiarity_score: ripple.familiarity_score,
      lifetime_plays: ripple.lifetime_plays,
      plays_in_window: ripple.plays_in_window,
      fact_llm: factLlm,
      fact_fallback: factFallback,
      fact_used: factLlm ? "llm" : "fallback",
    };
  }

  const payload: RipplesPayload = {
    new_arrivals: new_arrivals.map(buildPayloadItem),
    returning_waves: returning_waves.map(buildPayloadItem),
  };

  // 13. Compute composite familiarity
  const allScores = allRipples.map((r) => r.familiarity_score);
  const compositeFamiliarity =
    allScores.length > 0
      ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length)
      : 0;

  const totalPlaysInWindow = windowPlays.length;

  // 14. Write to D1
  const generatedAt = new Date(windowEnd * 1000).toISOString();
  const windowStartISO = new Date(windowStart * 1000).toISOString();
  const windowEndISO = generatedAt;

  await db
    .prepare(
      `INSERT INTO ripples_snapshot (generated_at, window_start, window_end, composite_familiarity, total_plays_in_window, payload)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      generatedAt,
      windowStartISO,
      windowEndISO,
      compositeFamiliarity,
      totalPlaysInWindow,
      JSON.stringify(payload),
    )
    .run();

  // 15. Log summary
  console.log(`[Ripples] Generated snapshot: ${compositeFamiliarity}% on-brand`);
  console.log(`[Ripples] Total plays in window: ${totalPlaysInWindow}`);
  console.log(`[Ripples] New arrivals: ${new_arrivals.map((r) => r.track_name).join(", ")}`);
  console.log(`[Ripples] Returning waves: ${returning_waves.map((r) => r.track_name).join(", ")}`);
  for (const item of [...payload.new_arrivals, ...payload.returning_waves]) {
    const factSource = item.fact_used === "llm" ? "LLM" : "fallback";
    const fact = item.fact_used === "llm" ? item.fact_llm : item.fact_fallback;
    console.log(`[Ripples]   ${item.title} — ${fact} (${factSource})`);
  }

  return {
    generated_at: generatedAt,
    window_start: windowStartISO,
    window_end: windowEndISO,
    composite_familiarity: compositeFamiliarity,
    total_plays_in_window: totalPlaysInWindow,
    payload,
  };
}
