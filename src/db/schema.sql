-- =========================================================
-- LISTENING HISTORY (local export + live-sync)
-- =========================================================
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,                          -- unix seconds (UTC)
  platform TEXT NOT NULL,                       -- normalized: iOS, macOS, Android, Windows, Cast
  ms_played INTEGER NOT NULL,
  conn_country TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist_name TEXT NOT NULL,
  album_name TEXT NOT NULL,
  spotify_track_uri TEXT NOT NULL,
  reason_start TEXT NOT NULL DEFAULT '',
  reason_end TEXT NOT NULL DEFAULT '',
  shuffle INTEGER NOT NULL DEFAULT 0,
  offline INTEGER NOT NULL DEFAULT 0,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  hour INTEGER NOT NULL,                        -- UTC hour
  local_hour INTEGER NOT NULL,                  -- US Eastern hour
  minutes REAL NOT NULL                         -- ms_played / 60000
);
CREATE INDEX IF NOT EXISTS idx_plays_ts ON plays(ts);
CREATE INDEX IF NOT EXISTS idx_plays_year_month ON plays(year, month);
CREATE INDEX IF NOT EXISTS idx_plays_artist ON plays(artist_name);
CREATE INDEX IF NOT EXISTS idx_plays_artist_year ON plays(artist_name, year);
CREATE INDEX IF NOT EXISTS idx_plays_uri ON plays(spotify_track_uri);
CREATE INDEX IF NOT EXISTS idx_plays_reason_end ON plays(reason_end);

-- =========================================================
-- USER & AUTH
-- =========================================================
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  spotify_user_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL
);

-- =========================================================
-- LISTENING HISTORY
-- =========================================================
CREATE TABLE IF NOT EXISTS poll_observations (
  id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,
  is_playing INTEGER NOT NULL,
  track_id TEXT,
  track_name TEXT,
  artist_ids TEXT,
  album_id TEXT,
  progress_ms INTEGER,
  duration_ms INTEGER,
  device_type TEXT,
  context_uri TEXT,
  context_type TEXT,
  artist_name TEXT
);
CREATE INDEX IF NOT EXISTS idx_poll_observed_at ON poll_observations(observed_at);
CREATE INDEX IF NOT EXISTS idx_poll_track ON poll_observations(track_id);

CREATE TABLE IF NOT EXISTS play_events (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_listened_ms INTEGER NOT NULL,
  track_duration_ms INTEGER,
  classification TEXT NOT NULL,
  context_uri TEXT,
  context_type TEXT,
  device_type TEXT,
  hour_of_day INTEGER,
  day_of_week INTEGER,
  session_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_play_events_track ON play_events(track_id);
CREATE INDEX IF NOT EXISTS idx_play_events_started ON play_events(started_at);
CREATE INDEX IF NOT EXISTS idx_play_events_hour ON play_events(hour_of_day);

-- =========================================================
-- TASTE MODEL
-- =========================================================
CREATE TABLE IF NOT EXISTS track_taste (
  track_id TEXT PRIMARY KEY,
  track_name TEXT NOT NULL,
  artist_ids TEXT NOT NULL,
  primary_artist_id TEXT NOT NULL,
  album_id TEXT,
  in_liked_songs INTEGER DEFAULT 0,
  in_top_tracks_short INTEGER DEFAULT 0,
  in_top_tracks_medium INTEGER DEFAULT 0,
  in_top_tracks_long INTEGER DEFAULT 0,
  seasonal_playlist_count INTEGER DEFAULT 0,
  current_season_present INTEGER DEFAULT 0,
  play_count INTEGER DEFAULT 0,
  skip_count INTEGER DEFAULT 0,
  complete_count INTEGER DEFAULT 0,
  last_played_at INTEGER,
  taste_score REAL,
  acoustic_fit_to_overall REAL,  -- M20: cached fit against 'overall' centroid
  refreshed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_track_taste_score ON track_taste(taste_score DESC);
CREATE INDEX IF NOT EXISTS idx_track_taste_artist ON track_taste(primary_artist_id);

CREATE TABLE IF NOT EXISTS artist_taste (
  artist_id TEXT PRIMARY KEY,
  artist_name TEXT NOT NULL,
  in_top_artists_short INTEGER DEFAULT 0,
  in_top_artists_medium INTEGER DEFAULT 0,
  in_top_artists_long INTEGER DEFAULT 0,
  is_followed INTEGER DEFAULT 0,
  total_plays INTEGER DEFAULT 0,
  unique_tracks_played INTEGER DEFAULT 0,
  taste_score REAL,
  refreshed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mode_profiles (
  mode TEXT PRIMARY KEY,
  hour_distribution TEXT NOT NULL,
  top_artists TEXT,
  top_tracks TEXT,
  top_playlists TEXT,
  refreshed_at INTEGER NOT NULL
);

-- =========================================================
-- SEASONAL PLAYLISTS
-- =========================================================
CREATE TABLE IF NOT EXISTS seasonal_playlists (
  id INTEGER PRIMARY KEY,
  spotify_playlist_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  season TEXT NOT NULL,
  year INTEGER NOT NULL,
  is_current INTEGER DEFAULT 0,
  last_synced_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_seasonal_year ON seasonal_playlists(year DESC);

-- =========================================================
-- PLAYLIST TRACKS (M21 — persisted track membership per playlist)
-- =========================================================
-- Populated from every owned playlist via embed-scrape; used by the
-- constellation cron to compute pair-level playlist co-occurrence.
-- See src/db/migrations/005_playlist_tracks.sql for the full rationale.
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

-- =========================================================
-- PHYSICAL CONTEXT
-- =========================================================
CREATE TABLE IF NOT EXISTS context_snapshots (
  id INTEGER PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  local_hour INTEGER NOT NULL,
  local_minute INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,
  daylight_phase TEXT NOT NULL,
  sunrise_at INTEGER,
  sunset_at INTEGER,
  weather_temp_f REAL,
  weather_condition TEXT,
  weather_precipitation_mm REAL,
  weather_wind_mph REAL,
  weather_cloud_pct INTEGER,
  location_label TEXT,
  location_lat REAL,
  location_lon REAL,
  location_source TEXT,
  device_type TEXT,
  is_in_motion INTEGER,
  bluetooth_context TEXT,
  calendar_event_title TEXT,
  calendar_event_category TEXT,
  calendar_event_ends_at INTEGER,
  user_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_captured_at ON context_snapshots(captured_at);

CREATE TABLE IF NOT EXISTS play_event_context (
  play_event_id INTEGER PRIMARY KEY,
  context_snapshot_id INTEGER NOT NULL,
  FOREIGN KEY(play_event_id) REFERENCES play_events(id),
  FOREIGN KEY(context_snapshot_id) REFERENCES context_snapshots(id)
);

CREATE TABLE IF NOT EXISTS track_context_affinity (
  track_id TEXT NOT NULL,
  dimension TEXT NOT NULL,
  bucket TEXT NOT NULL,
  affinity REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY(track_id, dimension, bucket)
);
CREATE INDEX IF NOT EXISTS idx_track_context_track ON track_context_affinity(track_id);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  home_lat REAL,
  home_lon REAL,
  home_label TEXT DEFAULT 'home',
  time_zone TEXT NOT NULL,
  weather_enabled INTEGER DEFAULT 1,
  calendar_enabled INTEGER DEFAULT 0,
  calendar_ical_url TEXT,
  shortcut_token_hash TEXT
);

-- =========================================================
-- DISCOVERY / FRESH POOL
-- =========================================================
CREATE TABLE IF NOT EXISTS fresh_pool (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist_ids TEXT NOT NULL,
  primary_artist_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_detail TEXT,
  found_at INTEGER NOT NULL,
  taste_score REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'fresh',
  status_changed_at INTEGER,
  expires_at INTEGER,
  UNIQUE(track_id)
);
CREATE INDEX IF NOT EXISTS idx_fresh_status ON fresh_pool(status);
CREATE INDEX IF NOT EXISTS idx_fresh_score ON fresh_pool(taste_score DESC);

-- =========================================================
-- SESSIONS
-- =========================================================
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,
  mode TEXT NOT NULL,
  invoked_at INTEGER NOT NULL,
  invoked_via TEXT NOT NULL,
  fresh_ratio_target REAL,
  duration_target_min INTEGER,
  output TEXT NOT NULL,
  spotify_playlist_id TEXT,
  ended_at INTEGER,
  context_snapshot_id INTEGER
);

CREATE TABLE IF NOT EXISTS session_tracks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  source TEXT NOT NULL,
  was_swapped INTEGER DEFAULT 0,
  outcome TEXT,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id)
);
CREATE INDEX IF NOT EXISTS idx_session_tracks_session ON session_tracks(session_id);

-- =========================================================
-- AUDIO FEATURES (M16 — ReccoBeats and future providers)
-- =========================================================
-- Feature columns are nullable: NULL means not-found (source='reccobeats:not_found').
-- Consumers must filter WHERE acousticness IS NOT NULL to exclude not-found rows.
CREATE TABLE IF NOT EXISTS track_audio_features (
  track_id TEXT PRIMARY KEY,
  acousticness REAL,
  danceability REAL,
  energy REAL,
  instrumentalness REAL,
  liveness REAL,
  loudness REAL,
  speechiness REAL,
  tempo REAL,
  valence REAL,
  source TEXT NOT NULL,             -- 'reccobeats', 'reccobeats:not_found', future: 'soundstat'
  fetched_at INTEGER NOT NULL       -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_audio_features_fetched ON track_audio_features(fetched_at);

-- =========================================================
-- ACOUSTIC PROFILE (M17 — per-mode centroids)
-- =========================================================
-- Mean + stddev per (mode, dimension). Rebuilt daily from play history.
-- Rows with sample_size < threshold are undertrained — M20 falls back to 'overall'.
-- =========================================================
-- LAST.FM CACHE (M18 — similar artists/tracks)
-- =========================================================
CREATE TABLE IF NOT EXISTS lastfm_similar_cache (
  query_type TEXT NOT NULL,
  query_key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (query_type, query_key)
);
CREATE INDEX IF NOT EXISTS idx_lastfm_expires ON lastfm_similar_cache(expires_at);

CREATE TABLE IF NOT EXISTS acoustic_profile (
  mode TEXT NOT NULL,
  dimension TEXT NOT NULL,
  mean REAL NOT NULL,
  stddev REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (mode, dimension)
);

-- =========================================================
-- SUBMISSIONS (M22 — visitor track recommendations)
-- =========================================================
-- Insert-only log. Written by POST /api/submit-track; read by the
-- nightly summary cron, which marks rows 'notified' after the digest
-- email goes out. See src/db/migrations/006_submissions.sql.
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,
  submitter_name TEXT,
  note TEXT,
  submitted_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at);
