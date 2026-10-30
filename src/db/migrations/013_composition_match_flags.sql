-- Add boolean match-method flags to replace the TEXT enum.
-- Keeps match_method TEXT as deprecated mirror for one cycle.

ALTER TABLE composition_versions ADD COLUMN found_via_mb_work INTEGER NOT NULL DEFAULT 0;
ALTER TABLE composition_versions ADD COLUMN found_via_spotify_search INTEGER NOT NULL DEFAULT 0;
ALTER TABLE composition_versions ADD COLUMN found_via_spotify_artist_search INTEGER NOT NULL DEFAULT 0;
