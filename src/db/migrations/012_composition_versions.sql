-- Cover & Alternate-Version Discovery (PLAN_COVERS_2.md §4)
--
-- composition_versions: discovered alternate recordings per seed
-- composition_seeds: cursor table for what's been searched
-- composition_versions_enriched: joins play counts + status for UI

CREATE TABLE IF NOT EXISTS composition_versions (
  seed_track_uri TEXT NOT NULL,
  candidate_track_uri TEXT NOT NULL,
  candidate_track_name TEXT NOT NULL,
  candidate_artist_name TEXT NOT NULL,
  candidate_album_name TEXT,
  candidate_release_date TEXT,
  candidate_spotify_popularity INTEGER,
  in_library INTEGER NOT NULL DEFAULT 0,
  match_method TEXT NOT NULL,
  mb_work_id TEXT,
  lyric_jaccard REAL NOT NULL,
  audio_distance REAL,
  audio_bucket TEXT NOT NULL,
  no_audio_data INTEGER NOT NULL DEFAULT 0,
  audio_feature_deltas_json TEXT,
  shared_writers_json TEXT,
  found_at INTEGER NOT NULL,
  PRIMARY KEY (seed_track_uri, candidate_track_uri)
);

CREATE INDEX IF NOT EXISTS idx_composition_versions_seed ON composition_versions (seed_track_uri, audio_bucket, audio_distance DESC);
CREATE INDEX IF NOT EXISTS idx_composition_versions_candidate ON composition_versions (candidate_track_uri);

CREATE TABLE IF NOT EXISTS composition_seeds (
  seed_track_uri TEXT PRIMARY KEY,
  last_searched_at INTEGER NOT NULL,
  search_method TEXT NOT NULL,
  candidates_found INTEGER NOT NULL,
  candidates_kept INTEGER NOT NULL,
  candidates_no_audio_data INTEGER NOT NULL,
  source TEXT NOT NULL
);

CREATE VIEW IF NOT EXISTS composition_versions_enriched AS
SELECT
  cv.*,
  (SELECT COUNT(*) FROM plays p WHERE p.spotify_track_uri = cv.candidate_track_uri) AS candidate_play_count,
  tl.status AS candidate_lyrics_status,
  tcs.status AS candidate_credits_status
FROM composition_versions cv
LEFT JOIN track_lyrics tl ON tl.spotify_track_uri = cv.candidate_track_uri
LEFT JOIN track_credits_status tcs ON tcs.spotify_track_uri = cv.candidate_track_uri;
