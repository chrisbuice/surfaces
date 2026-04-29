-- M17: Acoustic preference profile — per-mode centroids across audio feature dimensions

CREATE TABLE IF NOT EXISTS acoustic_profile (
  mode TEXT NOT NULL,
  dimension TEXT NOT NULL,
  mean REAL NOT NULL,
  stddev REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (mode, dimension)
);
