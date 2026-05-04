-- Migration 009: Lyric analysis tables
-- Stores structured analysis (Sonnet), embeddings (Voyage), and backfill status.

CREATE TABLE IF NOT EXISTS track_lyric_analysis (
  spotify_track_uri TEXT PRIMARY KEY,

  -- Core fields
  subject_paragraph TEXT NOT NULL,
  subject_tags TEXT NOT NULL,                 -- JSON array
  listener_feel_generic TEXT NOT NULL,        -- JSON object
  listener_feel_chris TEXT,                   -- JSON, populated in Phase 1.5
  tones TEXT NOT NULL,                        -- JSON array

  language TEXT NOT NULL,                     -- BCP-47

  -- Narrative
  narrative_pov TEXT,
  addressed_to TEXT,
  time_frame TEXT,
  story_arc TEXT,
  narrator_reliability TEXT,

  -- Sonic-adjacent (lyric-inferred)
  vocal_delivery_inferred TEXT,               -- JSON array
  tempo_feel TEXT,
  energy_curve TEXT,
  dynamic_range TEXT,

  -- Cultural & lexical
  vocab_level TEXT,
  slang_era TEXT,                             -- JSON array
  references_json TEXT,                       -- JSON object
  explicitness REAL,
  content_flags TEXT,                         -- JSON array
  quotability INTEGER,

  -- Structural
  rhyme_scheme TEXT,
  repetition_density REAL,
  chorus_verse_balance REAL,
  line_length_variance REAL,
  has_bridge INTEGER,
  structure_signature TEXT,

  -- Activity-fit (Phase 1.5)
  activity_fit TEXT,                          -- JSON object
  lyric_intrusion REAL,

  -- Provenance
  analyzed_at INTEGER NOT NULL,
  analysis_version TEXT NOT NULL,
  model_id TEXT NOT NULL,
  lyrics_hash TEXT NOT NULL,

  -- Phase 2 audio enrichment (nullable)
  audio_analyzed_at INTEGER,
  audio_features_inferred TEXT,
  audio_source TEXT
);

CREATE INDEX IF NOT EXISTS idx_lyric_analysis_lang ON track_lyric_analysis(language);
CREATE INDEX IF NOT EXISTS idx_lyric_analysis_version ON track_lyric_analysis(analysis_version);

CREATE TABLE IF NOT EXISTS track_lyric_embedding (
  spotify_track_uri TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- 'lyrics' | 'analysis'
  vector BLOB NOT NULL,                       -- Float32Array(512)
  model TEXT NOT NULL,
  embedded_at INTEGER NOT NULL,
  PRIMARY KEY (spotify_track_uri, kind)
);

CREATE TABLE IF NOT EXISTS track_lyric_analysis_status (
  spotify_track_uri TEXT PRIMARY KEY,
  status TEXT NOT NULL,                       -- 'ok' | 'instrumental' | 'too_short' | 'parse_error' | 'pending'
  last_attempted_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_lyric_analysis_status ON track_lyric_analysis_status(status);
