-- Ripples: snapshot of current listening obsessions
CREATE TABLE ripples_snapshot (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  generated_at TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  composite_familiarity REAL NOT NULL,
  total_plays_in_window INTEGER NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX idx_ripples_snapshot_generated_at ON ripples_snapshot(generated_at DESC);
