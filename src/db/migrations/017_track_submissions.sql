-- M23: track_submissions — richer audit log for visitor song submissions.
--
-- Every POST /api/submit-track writes one row here regardless of whether
-- the Spotify playlist-add succeeds. This table captures the full picture:
-- track metadata, submitter info, IP/UA, and the Spotify add outcome.
--
-- The older `submissions` table (006) continues to be written in parallel
-- for the nightly digest workflow.

CREATE TABLE track_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id TEXT NOT NULL,
  track_name TEXT,
  artist_name TEXT,
  from_name TEXT,
  note TEXT,
  email TEXT,
  submitter_ip TEXT,
  user_agent TEXT,
  spotify_add_status TEXT NOT NULL,   -- 'ok' | 'failed' | 'skipped'
  spotify_error TEXT,                  -- nullable, populated on failure
  created_at INTEGER NOT NULL          -- unix epoch seconds
);

CREATE INDEX idx_track_submissions_created_at ON track_submissions(created_at DESC);
