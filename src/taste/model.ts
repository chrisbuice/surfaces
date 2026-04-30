/**
 * model.ts — build/refresh the taste model from Spotify data + D1 history.
 *
 * Runs daily via cron. Rebuilds track_taste and artist_taste tables by
 * combining: saved songs, top tracks/artists, seasonal playlists, and
 * play event stats from D1.
 */

import { SpotifyClient } from "../spotify/client";
import {
  getSavedTracks, getTopTracks, getTopArtists,
  getFollowedArtists,
  type SpotifyTrack
} from "../spotify/library";
import { getPlaylistTracksViaEmbed } from "../spotify/embed";
import { syncSeasonalPlaylists } from "./seasonal";
import { computeTasteScore, computeArtistTasteScore } from "./score";

interface TrackAccumulator {
  track_name: string;
  artist_ids: string[];
  primary_artist_id: string;
  album_id: string | null;
  in_liked_songs: boolean;
  in_top_tracks_short: boolean;
  in_top_tracks_medium: boolean;
  in_top_tracks_long: boolean;
  seasonal_playlist_count: number;
  current_season_present: boolean;
}

interface ArtistAccumulator {
  artist_name: string;
  in_top_artists_short: boolean;
  in_top_artists_medium: boolean;
  in_top_artists_long: boolean;
  is_followed: boolean;
}

export async function rebuildTasteModel(db: D1Database, spotify: SpotifyClient): Promise<{
  tracksScored: number;
  artistsScored: number;
  seasonalPlaylists: number;
}> {
  const now = Math.floor(Date.now() / 1000);

  // ── Fetch all data from Spotify in parallel ──
  const [
    savedTracks,
    topTracksShort,
    topTracksMedium,
    topTracksLong,
    topArtistsShort,
    topArtistsMedium,
    topArtistsLong,
    followedArtists,
    seasonalSync,
  ] = await Promise.all([
    getSavedTracks(spotify, 500),
    getTopTracks(spotify, "short_term"),
    getTopTracks(spotify, "medium_term"),
    getTopTracks(spotify, "long_term"),
    getTopArtists(spotify, "short_term"),
    getTopArtists(spotify, "medium_term"),
    getTopArtists(spotify, "long_term"),
    getFollowedArtists(spotify),
    syncSeasonalPlaylists(db, spotify),
  ]);

  // ── Build track accumulators ──
  const tracks = new Map<string, TrackAccumulator>();

  function ensureTrack(t: SpotifyTrack): TrackAccumulator {
    let acc = tracks.get(t.id);
    if (!acc) {
      acc = {
        track_name: t.name,
        artist_ids: t.artists.map(a => a.id),
        primary_artist_id: t.artists[0]?.id ?? "",
        album_id: t.album?.id ?? null,
        in_liked_songs: false,
        in_top_tracks_short: false,
        in_top_tracks_medium: false,
        in_top_tracks_long: false,
        seasonal_playlist_count: 0,
        current_season_present: false,
      };
      tracks.set(t.id, acc);
    }
    return acc;
  }

  for (const t of savedTracks) ensureTrack(t).in_liked_songs = true;
  for (const t of topTracksShort) ensureTrack(t).in_top_tracks_short = true;
  for (const t of topTracksMedium) ensureTrack(t).in_top_tracks_medium = true;
  for (const t of topTracksLong) ensureTrack(t).in_top_tracks_long = true;

  // ── Add seasonal playlist tracks ──
  // Dev Mode blocks the playlist-tracks API, so we use embed scraping.
  // The embed provides track IDs and names but not artist IDs or album data.
  // Tracks that also appear in liked songs / top tracks already have full
  // metadata; seasonal-only tracks get correct playlist counts but incomplete
  // artist/album info (acceptable tradeoff).
  const seasonalRows = await db.prepare(
    "SELECT spotify_playlist_id, is_current FROM seasonal_playlists"
  ).all<{ spotify_playlist_id: string; is_current: number }>();

  for (const row of seasonalRows.results) {
    try {
      const { tracks: embedTracks } = await getPlaylistTracksViaEmbed(row.spotify_playlist_id, 500);
      for (const et of embedTracks) {
        let acc = tracks.get(et.trackId);
        if (!acc) {
          acc = {
            track_name: et.trackName,
            artist_ids: [],
            primary_artist_id: "",
            album_id: null,
            in_liked_songs: false,
            in_top_tracks_short: false,
            in_top_tracks_medium: false,
            in_top_tracks_long: false,
            seasonal_playlist_count: 0,
            current_season_present: false,
          };
          tracks.set(et.trackId, acc);
        }
        acc.seasonal_playlist_count++;
        if (row.is_current) acc.current_season_present = true;
      }
    } catch (err) {
      console.warn(`Skipping seasonal playlist ${row.spotify_playlist_id}: ${err}`);
    }
  }

  // ── Add tracks from play history (so every played track gets a score) ──
  const playedTracks = await db.prepare(`
    SELECT DISTINCT pe.track_id, po.track_name, po.artist_ids, po.album_id
    FROM play_events pe
    LEFT JOIN poll_observations po ON po.track_id = pe.track_id
    WHERE po.track_name IS NOT NULL
    GROUP BY pe.track_id
  `).all<{ track_id: string; track_name: string; artist_ids: string; album_id: string | null }>();

  for (const row of playedTracks.results) {
    if (!tracks.has(row.track_id)) {
      let artistIds: string[] = [];
      try { artistIds = JSON.parse(row.artist_ids); } catch { /* skip */ }
      tracks.set(row.track_id, {
        track_name: row.track_name,
        artist_ids: artistIds,
        primary_artist_id: artistIds[0] ?? "",
        album_id: row.album_id,
        in_liked_songs: false,
        in_top_tracks_short: false,
        in_top_tracks_medium: false,
        in_top_tracks_long: false,
        seasonal_playlist_count: 0,
        current_season_present: false,
      });
    }
  }

  // ── Build artist accumulators ──
  const artists = new Map<string, ArtistAccumulator>();

  function ensureArtist(id: string, name: string): ArtistAccumulator {
    let acc = artists.get(id);
    if (!acc) {
      acc = {
        artist_name: name,
        in_top_artists_short: false,
        in_top_artists_medium: false,
        in_top_artists_long: false,
        is_followed: false,
      };
      artists.set(id, acc);
    }
    return acc;
  }

  for (const a of topArtistsShort) ensureArtist(a.id, a.name).in_top_artists_short = true;
  for (const a of topArtistsMedium) ensureArtist(a.id, a.name).in_top_artists_medium = true;
  for (const a of topArtistsLong) ensureArtist(a.id, a.name).in_top_artists_long = true;
  for (const a of followedArtists) ensureArtist(a.id, a.name).is_followed = true;

  // Also ensure artists from tracks are in the artist map
  for (const [, acc] of tracks) {
    for (const artistId of acc.artist_ids) {
      if (!artists.has(artistId)) {
        artists.set(artistId, {
          artist_name: "",
          in_top_artists_short: false,
          in_top_artists_medium: false,
          in_top_artists_long: false,
          is_followed: false,
        });
      }
    }
  }

  // ── Fetch play event stats from D1 ──
  const playStats = await db.prepare(`
    SELECT track_id,
      COUNT(*) as play_count,
      SUM(CASE WHEN classification = 'skipped' THEN 1 ELSE 0 END) as skip_count,
      SUM(CASE WHEN classification IN ('completed', 'replayed') THEN 1 ELSE 0 END) as complete_count,
      SUM(CASE WHEN classification = 'replayed' THEN 1 ELSE 0 END) as replay_count,
      MAX(started_at) as last_played_at
    FROM play_events
    GROUP BY track_id
  `).all<{
    track_id: string;
    play_count: number;
    skip_count: number;
    complete_count: number;
    replay_count: number;
    last_played_at: number;
  }>();

  const playStatsMap = new Map(playStats.results.map(r => [r.track_id, r]));

  // Artist play stats
  const artistPlayStats = await db.prepare(`
    SELECT pe.track_id, COUNT(*) as plays
    FROM play_events pe
    GROUP BY pe.track_id
  `).all<{ track_id: string; plays: number }>();

  // Build artist play count map from track artist_ids
  const artistPlayCounts = new Map<string, { total: number; uniqueTracks: Set<string> }>();
  for (const row of artistPlayStats.results) {
    const trackAcc = tracks.get(row.track_id);
    if (trackAcc) {
      for (const artistId of trackAcc.artist_ids) {
        let entry = artistPlayCounts.get(artistId);
        if (!entry) {
          entry = { total: 0, uniqueTracks: new Set() };
          artistPlayCounts.set(artistId, entry);
        }
        entry.total += row.plays;
        entry.uniqueTracks.add(row.track_id);
      }
    }
  }

  // ── Score and write artists first (tracks need artist scores) ──
  const artistBatch: D1PreparedStatement[] = [];
  for (const [artistId, acc] of artists) {
    const playCounts = artistPlayCounts.get(artistId);
    const score = computeArtistTasteScore({
      inTopShort: acc.in_top_artists_short,
      inTopMedium: acc.in_top_artists_medium,
      inTopLong: acc.in_top_artists_long,
      isFollowed: acc.is_followed,
      totalPlays: playCounts?.total ?? 0,
      uniqueTracksPlayed: playCounts?.uniqueTracks.size ?? 0,
    });

    artistBatch.push(
      db.prepare(`
        INSERT INTO artist_taste (artist_id, artist_name, in_top_artists_short, in_top_artists_medium, in_top_artists_long, is_followed, total_plays, unique_tracks_played, taste_score, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artist_id) DO UPDATE SET
          artist_name = excluded.artist_name,
          in_top_artists_short = excluded.in_top_artists_short,
          in_top_artists_medium = excluded.in_top_artists_medium,
          in_top_artists_long = excluded.in_top_artists_long,
          is_followed = excluded.is_followed,
          total_plays = excluded.total_plays,
          unique_tracks_played = excluded.unique_tracks_played,
          taste_score = excluded.taste_score,
          refreshed_at = excluded.refreshed_at
      `).bind(
        artistId, acc.artist_name,
        acc.in_top_artists_short ? 1 : 0,
        acc.in_top_artists_medium ? 1 : 0,
        acc.in_top_artists_long ? 1 : 0,
        acc.is_followed ? 1 : 0,
        playCounts?.total ?? 0,
        playCounts?.uniqueTracks.size ?? 0,
        score, now
      )
    );
  }

  // D1 batch limit is 100 statements
  for (let i = 0; i < artistBatch.length; i += 100) {
    await db.batch(artistBatch.slice(i, i + 100));
  }

  // ── Build artist score lookup for track scoring ──
  const artistScores = new Map<string, number>();
  const artistScoreRows = await db.prepare(
    "SELECT artist_id, taste_score FROM artist_taste"
  ).all<{ artist_id: string; taste_score: number }>();
  for (const row of artistScoreRows.results) {
    artistScores.set(row.artist_id, row.taste_score);
  }

  // ── Score and write tracks ──
  const trackBatch: D1PreparedStatement[] = [];
  for (const [trackId, acc] of tracks) {
    const stats = playStatsMap.get(trackId);
    const artistScore = artistScores.get(acc.primary_artist_id) ?? 0;

    const score = computeTasteScore({
      inLikedSongs: acc.in_liked_songs,
      inTopTracksShort: acc.in_top_tracks_short,
      inTopTracksMedium: acc.in_top_tracks_medium,
      inTopTracksLong: acc.in_top_tracks_long,
      seasonalPlaylistCount: acc.seasonal_playlist_count,
      currentSeasonPresent: acc.current_season_present,
      playCount: stats?.play_count ?? 0,
      skipCount: stats?.skip_count ?? 0,
      completeCount: stats?.complete_count ?? 0,
      replayCount: stats?.replay_count ?? 0,
      lastPlayedAt: stats?.last_played_at ?? null,
      artistTasteScore: artistScore,
    });

    trackBatch.push(
      db.prepare(`
        INSERT INTO track_taste (track_id, track_name, artist_ids, primary_artist_id, album_id, in_liked_songs, in_top_tracks_short, in_top_tracks_medium, in_top_tracks_long, seasonal_playlist_count, current_season_present, play_count, skip_count, complete_count, last_played_at, taste_score, refreshed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(track_id) DO UPDATE SET
          track_name = excluded.track_name,
          artist_ids = excluded.artist_ids,
          primary_artist_id = excluded.primary_artist_id,
          album_id = excluded.album_id,
          in_liked_songs = excluded.in_liked_songs,
          in_top_tracks_short = excluded.in_top_tracks_short,
          in_top_tracks_medium = excluded.in_top_tracks_medium,
          in_top_tracks_long = excluded.in_top_tracks_long,
          seasonal_playlist_count = excluded.seasonal_playlist_count,
          current_season_present = excluded.current_season_present,
          play_count = excluded.play_count,
          skip_count = excluded.skip_count,
          complete_count = excluded.complete_count,
          last_played_at = excluded.last_played_at,
          taste_score = excluded.taste_score,
          refreshed_at = excluded.refreshed_at
      `).bind(
        trackId, acc.track_name, JSON.stringify(acc.artist_ids), acc.primary_artist_id,
        acc.album_id,
        acc.in_liked_songs ? 1 : 0,
        acc.in_top_tracks_short ? 1 : 0,
        acc.in_top_tracks_medium ? 1 : 0,
        acc.in_top_tracks_long ? 1 : 0,
        acc.seasonal_playlist_count,
        acc.current_season_present ? 1 : 0,
        stats?.play_count ?? 0,
        stats?.skip_count ?? 0,
        stats?.complete_count ?? 0,
        stats?.last_played_at ?? null,
        score, now
      )
    );
  }

  for (let i = 0; i < trackBatch.length; i += 100) {
    await db.batch(trackBatch.slice(i, i + 100));
  }

  // ── Compute acoustic_fit_to_overall for tracks with audio features ──
  let acousticFitCount = 0;
  try {
    const { computeAcousticFit } = await import("../audio/fit");

    // Load 'overall' centroid
    const centroidRows = await db.prepare(
      "SELECT dimension, mean, stddev FROM acoustic_profile WHERE mode = 'overall'"
    ).all<{ dimension: string; mean: number; stddev: number }>();

    if (centroidRows.results.length > 0) {
      const centroid = new Map(centroidRows.results.map(r => [r.dimension, { mean: r.mean, stddev: r.stddev }]));

      // Load all audio features
      const featureRows = await db.prepare(
        "SELECT track_id, acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence FROM track_audio_features WHERE acousticness IS NOT NULL"
      ).all<{
        track_id: string; acousticness: number; danceability: number; energy: number;
        instrumentalness: number; liveness: number; loudness: number;
        speechiness: number; tempo: number; valence: number;
      }>();

      const fitBatch: D1PreparedStatement[] = [];
      for (const f of featureRows.results) {
        if (!tracks.has(f.track_id)) continue; // only tracks in the taste model
        const fit = computeAcousticFit(f, centroid);
        fitBatch.push(
          db.prepare("UPDATE track_taste SET acoustic_fit_to_overall = ? WHERE track_id = ?").bind(fit, f.track_id)
        );
        acousticFitCount++;
      }

      for (let i = 0; i < fitBatch.length; i += 100) {
        await db.batch(fitBatch.slice(i, i + 100));
      }
    }
  } catch { /* acoustic profile may not exist yet */ }

  return {
    tracksScored: tracks.size,
    artistsScored: artists.size,
    seasonalPlaylists: seasonalSync.total,
    acousticFitComputed: acousticFitCount,
  };
}
