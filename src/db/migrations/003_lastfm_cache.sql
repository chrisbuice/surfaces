-- M18: Last.fm similar-artist/track cache

CREATE TABLE IF NOT EXISTS lastfm_similar_cache (
  query_type TEXT NOT NULL,         -- 'artist_similar' | 'track_similar' | 'tag_top_tracks'
  query_key TEXT NOT NULL,          -- artist_name, "artist|title", or tag name
  response_json TEXT NOT NULL,      -- raw JSON response, parsed at read time
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,      -- fetched_at + 7 days
  PRIMARY KEY (query_type, query_key)
);
CREATE INDEX IF NOT EXISTS idx_lastfm_expires ON lastfm_similar_cache(expires_at);
