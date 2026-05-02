-- M21: playlist_tracks — persisted track membership per playlist.
--
-- Used by the constellation cron to compute pair-level playlist
-- co-occurrence (a curatorial signal, weighted higher than passive
-- session co-occurrence per spec §5.3). Populated from every playlist
-- the user owns — not just seasonal — so that any track ever played
-- and ever pinned to a personal playlist contributes to the signal.
-- The 1.5× seasonal bonus is applied at query time by joining against
-- the seasonal_playlists table.
--
-- artist_name is denormalized onto each row so the constellation
-- co-occurrence query can join against plays.artist_name without a
-- second lookup. Embed scraping returns track-level artist display
-- names only (no Spotify artist IDs); we store the primary artist.

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL,
  track_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  position INTEGER,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id);
CREATE INDEX IF NOT EXISTS idx_playlist_tracks_artist ON playlist_tracks(artist_name);
