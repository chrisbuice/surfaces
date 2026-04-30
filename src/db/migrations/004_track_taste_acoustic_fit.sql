-- M20: Cache acoustic fit against 'overall' centroid on track_taste
-- Computed during taste rebuild; used as fast-path in curation scoring.
-- Source of truth is track_audio_features + acoustic_profile, not this column.

ALTER TABLE track_taste ADD COLUMN acoustic_fit_to_overall REAL;
