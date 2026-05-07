-- Migration 016: Track MusicBrainz lookup attempts separately
-- Allows retry script to skip tracks that have exhausted MB attempts
-- while still retrying text matching.
ALTER TABLE apple_track_matches ADD COLUMN musicbrainz_attempts INTEGER NOT NULL DEFAULT 0;
