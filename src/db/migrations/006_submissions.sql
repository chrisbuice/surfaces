-- M22: submissions — track recommendations from chrisbuice.com/surfaces.
--
-- Insert-only audit log. The /api/submit-track endpoint writes one row
-- per visitor submission; the nightly summary email reads new rows,
-- includes them in the digest, and marks them 'notified'.
--
-- Track metadata enrichment (looking up name + artists for unfamiliar
-- track_ids) and optional fresh_pool insertion are left to a follow-up
-- pass — keeps the public endpoint lightweight and resilient.

CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,             -- "spotify:track:..." or bare id; canonicalized at insert time
  submitter_name TEXT,                -- nullable; the "from" field on the form
  note TEXT,                          -- nullable; the optional one-liner
  submitted_at INTEGER NOT NULL,      -- unix seconds
  status TEXT NOT NULL DEFAULT 'new'  -- 'new' | 'notified' | 'added_to_pool' | 'rejected'
);
CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
CREATE INDEX IF NOT EXISTS idx_submissions_submitted_at ON submissions(submitted_at);
