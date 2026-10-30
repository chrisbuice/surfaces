-- Pipeline coverage check
-- Run via: npx wrangler d1 execute spotify-agent-db --remote --json --command "$(cat scripts/coverage-check.sql)"

SELECT
  (SELECT COUNT(DISTINCT spotify_track_uri) FROM plays) AS total_play_uris,
  (SELECT COUNT(*) FROM track_lyrics WHERE status = 'ok') AS lyrics_ok,
  (SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'ok') AS analysis_ok,
  (SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'pending') AS analysis_pending,
  (SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'too_short') AS analysis_too_short,
  (SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'parse_error') AS analysis_parse_error,
  (SELECT COUNT(*) FROM track_lyric_embedding WHERE kind = 'lyrics') AS embed_lyrics,
  (SELECT COUNT(*) FROM track_lyric_embedding WHERE kind = 'analysis') AS embed_analysis,
  (SELECT COUNT(*) FROM (
    SELECT p.spotify_track_uri
    FROM plays p
    WHERE p.reason_end = 'trackdone'
    GROUP BY p.spotify_track_uri
    HAVING COUNT(*) >= 2
  ) t
  JOIN track_lyrics l ON l.spotify_track_uri = t.spotify_track_uri
  LEFT JOIN track_lyric_analysis_status s ON s.spotify_track_uri = t.spotify_track_uri
  WHERE l.status = 'ok' AND l.lyrics_plain IS NOT NULL
    AND (s.spotify_track_uri IS NULL OR s.status = 'pending' OR (s.status = 'parse_error' AND s.attempts < 3))
  ) AS gap_count;
