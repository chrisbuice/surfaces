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
| 10 | Spotify Dev Mode API restrictions | M5 | After adding Web Playback SDK, playlist READ works again. Playlist WRITE (adding tracks) and `/browse/new-releases` still return 403. Extended Quota Mode requires 250K+ MAU business — not applicable. `play_now` and `queue` work fine. `output=playlist` is broken (creates empty playlist). Discovery could be upgraded to scan editorial playlists now that reads work. |
| 11 | Clean up test playlists | — | Several empty test playlists ("test-delete-me", "working — 2026-04-28") were created during debugging. Delete manually from Spotify. |
| 12 | Discovery candidate volume bounded by search limit | — | Spotify's Feb 2026 migration reduced the search `limit` max from 50 to 10. Discovery currently uses `limit=10`, so no breakage. But a further reduction would shrink the candidate pool proportionally (currently: 6 artists × 10 results = 60 candidates on followed-artist days). Re-investigate if discovery feels thin. |
| 13 | ReccoBeats undocumented 40-ID batch limit | M16 | `GET /v1/audio-features?ids=...` returns 400 if more than 40 IDs are passed. Handled by `RECCOBEATS_MAX_BATCH` constant in `src/audio/reccobeats.ts` with automatic chunking. Monitor if this limit changes. |
| 14 | Acoustic profile granularity | M17 | Currently mode-only centroids. Per-(mode × context) slicing (e.g., working+rain vs working+clear) is undertrained with current data. Revisit when sample sizes per mode consistently exceed 50 and play_events with linked context snapshots reach ~1000+. Sleeping window corrected from [21,24] to [23,6] based on user input (sleep music starts at 23:30+ ET); hours 0-5 now categorized as sleeping via midnight wrap-around. |
| 15 | Persist artist genres in artist_taste | M18+ | `artist_taste` has no genres column. Spotify's `/me/top/artists` and `/me/following` return genre arrays, but `taste/model.ts` doesn't store them. Adding a `genres TEXT` column (JSON array) to `artist_taste` and writing during rebuild would unblock Last.fm `tag.getTopTracks` discovery. Deferred — `artist.getSimilar` is the primary discovery source for now. |
| 16 | ISRC available in Dev Mode search results | M18 | Confirmed: `external_ids.isrc` is present on track objects returned by `GET /v1/search` in Dev Mode (reverted in March 2026 changelog). No need for `GET /v1/tracks/{id}` (which is 403). ISRC dedup can be implemented directly from search response objects. Not wired into M18 discovery yet — name+artist dedup is sufficient for now. |
| 17 | Aquarium Drunkard as discovery source | M19 | Deferred. RSS feed titles use "Artist :: Album" format, not "Artist — Track". Adapting the pipeline to treat albums as seeds (fetch album tracks, pick one) requires a different candidate-generation pattern. Revisit if album-seeded discovery becomes a priority. |
