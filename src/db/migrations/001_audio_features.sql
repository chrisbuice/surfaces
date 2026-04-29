-- M16: Audio features from ReccoBeats (and future providers)
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
