# Local listening-history dataset

The agent has access to the user's full Spotify Extended Streaming History (Dec 10, 2011 → Apr 29, 2026) plus pre-computed derived files. This is a local data layer that augments — but does not replace — anything fetched from the live Spotify Web API.

## Files in `data/`

- `streaming_history/` — raw Spotify-exported JSON files. Schema is identical across all 15 years.
- `streams.feather` — normalized DataFrame, 260,790 rows. Columns include `ts` (UTC), `platform`, `ms_played`, `conn_country`, `ip_addr`, `master_metadata_track_name`, `master_metadata_album_artist_name`, `master_metadata_album_album_name`, `spotify_track_uri`, `episode_name`, `audiobook_title`, `reason_start`, `reason_end`, `shuffle`, `skipped`, `offline`, `offline_timestamp`, `incognito_mode`, `_kind` (audio/video), `year`, `month`, `dow`, `hour`, `local_hour`, `minutes`. Load with `pandas.read_feather`.
- `track_affinity.csv`, `artist_affinity.csv` — recency-weighted affinity scores. Formula: `sum(min(minutes, 7) × exp(-years_ago / 3) × (1 + 0.5·trackdone))`. Snapshot date 2026-04-29. Top artist by affinity is Zach Bryan.
- `monthly_top.csv` — top track per calendar month (170 rows).
- `lost_favorites.csv` — tracks with ≥20 plays not played in 2+ years (912 rows at URI level; 639 at song level after collapsing re-releases — see "URI vs. song-level queries" below).
- `sessions.csv` — plays grouped into sessions (≤30 min gap), 18,882 rows.
- `companions.json` — for each top-25 lifetime artist, the five other artists most often played in the same session.
- `ip_geo.json` — city/region/country/lat/lon for 4,745 distinct iOS IPs.
- `cities_ios.csv` — pre-rolled city stats (plays, days, hours, first/last seen).
- `dashboard_data.json` — bundled summaries (yearly totals, top artists/tracks, obsessions, hourly distribution).

## Schema quirks — load-bearing, encode in shared helpers

1. **`skipped` is unreliable from 2017 to 2022** (effectively always false). The honest skip indicator across the whole dataset is `reason_end == 'fwdbtn'`. Provide and use `is_skip(row)` everywhere.
2. **A music play is** `_kind == 'audio'` AND `spotify_track_uri` not null AND `episode_name` is null AND `audiobook_title` is null. That filter yields 260,331 rows. Don't double-count podcasts or videos.
3. **Platform strings drift over time.** Map to a stable enum: contains "iOS"/"iPhone"/"iPad" → `iOS`; "OS X"/"Mac"/"osx" → `macOS`; "Android" → `Android`; "Windows" → `Windows`; "Partner"/"cast"/"Sonos"/"Echo" → `Cast`.
4. **macOS IPs are NOT trustworthy for location.** They resolve to corporate VPN egress points (Westlake Village CA, Indianapolis IN, Chicago IL via Zscaler) — not where the user actually was. Always filter to iOS-only when answering "where was I" questions.
5. **The 2022 lull (May–July) is real**, not a data artifact. Don't compute "recent activity" windows centered on 2022 unless explicitly asked.
6. **99.4% of plays are US.** Strip `ip_addr` at ingest if not already; never log it externally.
7. **Time zone:** timestamps are UTC. The user is on US Eastern; for time-of-day analysis use `local_hour = (ts.hour - 5) % 24`. The 7am–6pm Eastern band holds 70% of all plays.
8. **Audiobook fields are always null** for this user. Skip them.

## Evergreen "never-stale core" — boost in any recommender

Artists in the user's top-50 for 8+ different years:
- 13 yrs: Beyoncé
- 12 yrs: Fleetwood Mac
- 10 yrs: Gregory Alan Isakov, Britney Spears, Lana Del Rey, Taylor Swift
- 9 yrs: Rihanna, The Chicks, Brandi Carlile, Kacey Musgraves
- 8 yrs: Calvin Harris, TLC, M.I.A., Miranda Lambert

## Capabilities the local dataset newly enables

Things the live Web API can't answer:
- **Time-machine memory queries** — "what was I listening to in March 2024?"
- **Era-anchored seeds** — five named eras with 30–80 representative tracks each.
- **Lost-favorites rediscovery** — `lost_favorites.csv` as a candidate pool for "fresh" suggestions; mix ~30%.
- **Workday-context queues** — weight by listening history in a specific hour band, not global affinity.
- **Skip-aware refinement** — log `reason_end='fwdbtn'` within 30s of `reason_start` as a "no" on `(track, context)`. Penalize candidates with ≥3 such signals in past 30 days.
- **Geographic memory** — "what did I listen to in Buenos Aires?" via `ip_geo.json`.
- **Companion seeding** — `companions.json` is the user's actual co-listening graph; better than the API's editorial "related artists."
- **Travel mode** — when connecting from a non-Georgia city for the first time in N days, switch to lifetime-favorites-heavy mix.

## URI vs. song-level queries — when to use which

A single song can have multiple Spotify track URIs: re-releases, deluxe editions, regional variants, or label changes. In this dataset, 5,242 distinct (track_name, artist_name) pairs map to more than one URI. This matters because a user may stop playing one URI and switch to a newer one — but they haven't stopped listening to the *song*.

**Song-level aggregation — GROUP BY (track_name COLLATE NOCASE, artist_name COLLATE NOCASE):**
Use for any user-facing query where the answer is "how much did I listen to this song".
Always use `COLLATE NOCASE` — Spotify changes title casing across releases (e.g. "Good As Hell" → "Good as Hell"). 195 songs in this dataset have case-variant titles. Without NOCASE, these appear as separate songs and generate false positives in lost_favorites.
- `time_machine` top tracks: collapse URIs so "Time to Dance" shows 203 plays, not 181 + 22.
- `lost_favorites`: a song is only "lost" if ALL its URIs are abandoned. If any URI has a recent play, the song is still active. When returning a URI for queue insertion, pick the one with the most lifetime plays.
- `skip_report` most-skipped / completion champions: user wants to know about the song, not a specific pressing.
- `monthly_top`: same — aggregate across URIs.

**URI-level — GROUP BY spotify_track_uri:**
Use for internal/queue operations where the system needs a specific recording:
- `getTrackAffinity`: the queue needs a concrete URI to play.
- `getSkipPenalizedTracks`: skip-veto applies to the exact recording that was skipped. If the user skips a remix URI, the original URI should not be penalized.
- `getSkipCount`: same — URI-specific.
- Live-sync dedup: `(ts, spotify_track_uri)` is the unique key.

**Rule of thumb:** if the result is shown to the user, aggregate at song level. If the result drives a Spotify API call (play, queue, add to playlist), use the URI.

## Live API and snapshot freshness

The export ends 2026-04-29. To keep the local layer live without re-deriving everything:
- Layer the `recently-played` endpoint on top: poll daily, dedupe by `(timestamp, spotify_track_uri)`, append rows to `streams.feather` (or to a separate "tail" feather the agent unions in at read).
- Recompute affinity nightly, not per-query. The exponential decay is stable enough for daily refresh.
- `monthly_top` and `sessions` only extend forward.
- `ip_geo.json` is a cache; only look up new IPs.