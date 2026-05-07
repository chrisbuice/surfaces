-- Migration 015: Apple Music listening history support
-- Adds source tagging and Apple-specific columns to plays table.
-- Creates apple_track_matches as the per-track Spotify-match cache.

-- 1. Add columns to existing plays table
ALTER TABLE plays ADD COLUMN source TEXT NOT NULL DEFAULT 'spotify';
ALTER TABLE plays ADD COLUMN apple_track_id TEXT;
ALTER TABLE plays ADD COLUMN match_confidence REAL;
ALTER TABLE plays ADD COLUMN match_status TEXT;
ALTER TABLE plays ADD COLUMN original_song_name TEXT;
ALTER TABLE plays ADD COLUMN original_album_name TEXT;
ALTER TABLE plays ADD COLUMN original_artist_name TEXT;

-- 2. Indexes
CREATE INDEX IF NOT EXISTS idx_plays_source ON plays(source);
CREATE INDEX IF NOT EXISTS idx_plays_source_year_month ON plays(source, year, month);
CREATE INDEX IF NOT EXISTS idx_plays_apple_track_id ON plays(apple_track_id);
CREATE INDEX IF NOT EXISTS idx_plays_match_status ON plays(match_status);

-- 3. Match cache
CREATE TABLE IF NOT EXISTS apple_track_matches (
  cache_key TEXT PRIMARY KEY,
  apple_track_id TEXT,
  spotify_track_uri TEXT,
  spotify_track_name TEXT,
  spotify_artist_name TEXT,
  spotify_album_name TEXT,
  spotify_duration_ms INTEGER,
  match_confidence REAL,
  match_method TEXT,                     -- 'isrc' | 'text' | 'manual'
  match_status TEXT NOT NULL,
  itunes_artist_name TEXT,
  itunes_track_name TEXT,
  itunes_album_name TEXT,
  itunes_duration_ms INTEGER,
  itunes_release_date TEXT,
  itunes_genre TEXT,
  musicbrainz_isrc TEXT,
  original_song_name TEXT NOT NULL,
  original_album_name TEXT,
  original_artist_name TEXT,
  first_seen_at INTEGER NOT NULL,
  last_match_attempt_at INTEGER NOT NULL,
  match_attempts INTEGER NOT NULL DEFAULT 1,
  reviewed_by_human INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_atm_status ON apple_track_matches(match_status);
CREATE INDEX IF NOT EXISTS idx_atm_spotify_uri ON apple_track_matches(spotify_track_uri);
CREATE INDEX IF NOT EXISTS idx_atm_apple_id ON apple_track_matches(apple_track_id);
