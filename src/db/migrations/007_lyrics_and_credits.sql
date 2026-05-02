-- Migration 007: Lyrics + songwriter credits tables
-- Additive — does not modify existing tables.

-- =========================================================
-- ISRC CACHE (working table for backfill scripts)
-- =========================================================
CREATE TABLE IF NOT EXISTS track_isrc_cache (
  spotify_track_uri TEXT PRIMARY KEY,
  isrc TEXT,
  duration_ms INTEGER,
  album_name TEXT,
  fetched_at INTEGER NOT NULL
);

-- =========================================================
-- LYRICS (one row per track)
-- =========================================================
CREATE TABLE IF NOT EXISTS track_lyrics (
  spotify_track_uri TEXT PRIMARY KEY,
  track_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_name TEXT,
  duration_ms INTEGER,
  isrc TEXT,
  lyrics_plain TEXT,
  lyrics_synced TEXT,
  instrumental INTEGER NOT NULL DEFAULT 0,
  lyrics_length INTEGER,
  status TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'lrclib',
  match_method TEXT,
  fetched_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_status ON track_lyrics(status);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_artist ON track_lyrics(artist_name);
CREATE INDEX IF NOT EXISTS idx_track_lyrics_isrc ON track_lyrics(isrc);

-- =========================================================
-- CREDITS (normalized: one row per person×role×track)
-- =========================================================
CREATE TABLE IF NOT EXISTS track_credits (
  id INTEGER PRIMARY KEY,
  spotify_track_uri TEXT NOT NULL,
  person_name TEXT NOT NULL,
  role TEXT NOT NULL,
  role_raw TEXT,
  source TEXT NOT NULL,
  mb_artist_id TEXT,
  mb_work_id TEXT,
  mb_recording_id TEXT,
  fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_credits_uri ON track_credits(spotify_track_uri);
CREATE INDEX IF NOT EXISTS idx_credits_person ON track_credits(person_name);
CREATE INDEX IF NOT EXISTS idx_credits_role ON track_credits(role);

-- =========================================================
-- CREDITS STATUS (track-level fetch status, independent of lyrics)
-- =========================================================
CREATE TABLE IF NOT EXISTS track_credits_status (
  spotify_track_uri TEXT PRIMARY KEY,
  isrc TEXT,
  mb_recording_id TEXT,
  mb_work_id TEXT,
  status TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_credits_status ON track_credits_status(status);
