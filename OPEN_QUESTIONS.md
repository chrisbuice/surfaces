# Open Questions

Tracked decisions, things the user needs to provide, and items deferred to later milestones.

## Answered

| # | Question | Answer | Milestone |
|---|----------|--------|-----------|
| 1 | Seasonal playlist naming pattern | Contains season name (spring/summer/fall/winter), sometimes a year. Infer timeframe from track add dates. Also: "brrr"=winter, "wynter"=summer. Only user-owned playlists. | M3 |
| 2 | Time zone | America/New_York | M0 |
| 3 | Default device for first session | Resolved: use active device or first available. User just needs Spotify open. | M4 |
| 5 | Home location | Atlanta, GA (~33.78, -84.39) | M7 |

## Open

| # | Question | Relevant milestone | Notes |
|---|----------|--------------------|-------|
| 4 | Discovery Queue playlist size (50? 100?) | M5 | |
| 6 | Editorial playlists for discovery sources | M5 | Suggested: New Music Friday, Fresh Finds, Pollen, Lorem, Bedroom Pop, Indie Mixtape — confirm with user. |
| 7 | Calendar source (Google iCal, Apple, skip?) | M12 (deferred) | |
| 8 | Context bias magnitudes — tune after M8 | M8+ | Cold-start rules use ×1.05 to ×1.3; adjust by feel. |
| 9 | iOS Shortcut location precision (round lat/lon?) | M11 (deferred) | Probably 2 decimal places (~1km). |
| 10 | Spotify Dev Mode API restrictions | M5 | `/playlists/{id}/tracks` (read), playlist track-add (write), `/browse/new-releases` all return 403. `play_now`, `queue`, `/me/tracks`, `/me/top/*`, search, followed-artists all work. Discovery uses search-based approach. Taste model rebuild may break if token refreshes. Need Extended Quota Mode approval from Spotify to unlock full API. |
| 11 | Clean up test playlists | — | Several empty test playlists ("test-delete-me", "working — 2026-04-28") were created during debugging. Delete manually from Spotify. |
