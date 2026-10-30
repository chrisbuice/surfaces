-- Stores hand-marked loved passages for the /surfaces visual.
-- Each track can have multiple passages (passage_index 0, 1, 2...).
-- Replaced in full on each save via DELETE + INSERT.

CREATE TABLE IF NOT EXISTS loved_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spotify_track_uri TEXT NOT NULL,
  passage_index INTEGER NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  passage_text TEXT NOT NULL,
  marked_at INTEGER NOT NULL,
  UNIQUE(spotify_track_uri, passage_index)
);

CREATE INDEX IF NOT EXISTS idx_loved_passages_uri ON loved_passages(spotify_track_uri);
