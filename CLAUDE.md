# Spotify Playlist Tool — agent context

A personal Spotify automation tool, single-user (Chris). The agent has two surfaces: an **MCP server** that exposes tools to Claude Code (and any other MCP client), and a **dashboard** for visual exploration. Both surfaces are first-class — every new capability should be reachable from MCP and, where it makes sense, surfaced in the dashboard.

The agent already has a working Spotify Web API integration (OAuth in place, can fetch playlists, tracks, recently-played, etc.). It also has a 15-year local listening-history dataset and several pre-derived files. See `LISTENING_HISTORY.md` for the schema, file inventory, and load-bearing quirks of that dataset.

## Deployment

This repo auto-deploys to Cloudflare Workers on push to `main` via Workers Builds (configured in the CF dashboard, not in-repo). Manual deploys via `npx wrangler deploy` still work and target the same worker. If a "did my fix deploy?" question comes up, check `npx wrangler deployments list` and compare timestamps to the commit, or check the CF dashboard's build log.

`chrisbuice-site` is a separate repo with its own deploy model (Workers Static Assets, also auto-deploy on push). The two repos are independent — pushing one does not deploy the other.

## Architecture: discover, don't assume

The language and runtime aren't stated here on purpose — read the project files first. Before making any change:
- Identify which file owns MCP tool registration. New tools go through that.
- Identify the existing Spotify API client and reuse it. Don't introduce a second HTTP layer.
- Identify where shared helpers live and add new ones there. The listening-history layer needs `load_streams()`, `music_only(df)`, `is_skip(row)`, `normalize_platform(p)`, and `geolocate(ip)` in exactly one place.
- Identify the dashboard tech (framework, file structure, build pipeline) before touching it. New views should match the existing component style.
- Identify the test framework. All new helpers and tools require tests.

If any of this isn't obvious from the repo, say so before making changes.

## Working agreement

**Plan-first for anything substantive.** Large additions (new MCP tools that couple to the live API, dashboard views, anything that touches auth or data ingestion) get written to `PLAN.md` first; stop and wait for explicit "go" before implementing.

**Move freely on small, isolated changes.** A new helper function, a refactor inside a file you already touched, a typo fix — just do it and show the diff.

**Match the mood of my message.** If I'm exploring an idea, propose options. If I'm asking for something specific, ship it.

**Concise but explanatory.** Short responses by default. When something non-obvious happened (a tradeoff, a quirk you encountered, a thing you chose not to do), say so in one or two sentences.

## Tests are not optional

Every new helper, every new MCP tool, and every new dashboard data-loader gets a test. Match the existing test framework and folder convention. The listening-history layer additionally has these regression checks that must always pass:

- `music_only(streams).shape[0] == 260_331`
- Top artist by affinity score must be `Zach Bryan`
- `lost_favorites` at the 2026-04-29 snapshot has 633 rows (song-level with COLLATE NOCASE; was 912 at URI level before collapsing re-releases and title-case drift)
- `is_skip()` returns True for `reason_end == 'fwdbtn'`, False for `trackdone`

If any of these break, stop and tell me. Do not "fix" them by changing the helpers — the helpers are encoding load-bearing dataset quirks documented in `LISTENING_HISTORY.md`.

## Code style

Match what's already in the repo. Where existing patterns are inconsistent, lean toward the more modern/typed version. When you add new files, type-hint them; when you touch existing files, run the repo's formatter on the lines you changed and leave the rest alone. Don't reformat files you didn't otherwise touch.

## Capability priorities

Top of the queue, in order:

1. **Lost-favorites rediscovery.** A tool / dashboard view that surfaces tracks with ≥20 plays not heard in 2+ years. Used as a candidate pool for fresh-but-familiar suggestions; mix ~30% into queues by default.

2. **Smart queues with skip-aware feedback.** Build playlists weighted by recency-decayed affinity. Log `reason_end == 'fwdbtn'` events within 30 seconds of `reason_start` as honest negative signal. After three such "no"s on a track in 30 days, exclude it from generated queues unless I ask for it by name.

3. **Time-machine memory queries.** "What was I listening to in [month/year]?" Answer from `monthly_top.csv` or a slice of `streams.feather`. Should feel instantaneous.

After those land, the dashboard side gets the calendar heatmap, reflections filmstrip, and time-machine picker. Use `Sonic_Life_Dashboard.html` as a design reference for layout and visual language — don't copy code, but the patterns there are good ones.

## Honor the never-stale core

In any ranking or recommendation, apply a small constant boost to these 14 artists. They appear in my top-50 for 8+ different years and they should never get pruned by recency decay alone:

- 13 yrs: Beyoncé
- 12 yrs: Fleetwood Mac
- 10 yrs: Gregory Alan Isakov, Britney Spears, Lana Del Rey, Taylor Swift
- 9 yrs: Rihanna, The Chicks, Brandi Carlile, Kacey Musgraves
- 8 yrs: Calvin Harris, TLC, M.I.A., Miranda Lambert

The boost should be modest — enough to keep them surfaced when they otherwise would have aged out, not enough to dominate a freshly seeded queue.

## Surface data-source provenance

When the agent answers a question, say where the answer came from:
- "From local history" — answered from `streams.feather` or a derived file.
- "From Spotify (live)" — answered from a current API call.
- "Mixed" — combined both (e.g., affinity-ranked candidates filtered against a current playlist).

This applies to MCP tool responses (a `source` field in the response) and to dashboard views (a small badge or footer). It matters because the local data is snapshot to 2026-04-29; the API is live. Never let an answer drift between the two without flagging which side it came from.

## Live-sync the local dataset

Add a daily sync that pulls the last 50 plays from Spotify's `recently-played` endpoint, dedupes by `(timestamp, spotify_track_uri)`, and appends rows to `streams.feather` (or to a sibling `streams_tail.feather` that the loader unions in). Recompute affinity scores nightly, not per-query.

If the daily sync ever returns exactly 50 plays, queue another sync within an hour — Spotify's API caps at 50 and we may have lost rows.



## Privacy and egress

I'm relaxed about where data goes for legitimate purposes (Spotify API, Anthropic API for natural-language queries, etc.). The one rule: don't log or transmit raw `ip_addr` values. Geolocate them at ingest, store the resolved city/region/country tuple, and discard the IP. The `ip_geo.json` cache file is fine to keep locally — just don't ever post it to a third-party service.

## Git

Match the repo's existing pattern. If recent history is feature-branches with PRs, do that. If it's commit-to-main with descriptive messages, do that. Always write meaningful commit messages — not "wip" or "update."

## LISTENING HISTORY
For the local listening-history dataset (15 years of plays, affinity scores, session-level data, IP→city geolocation), see LISTENING_HISTORY.md.

## Anti-patterns

A few specific things this agent should never do:

- **Never read `streams["skipped"]` directly.** Always go through `is_skip()`. The boolean is broken from 2017 to 2022; `reason_end == 'fwdbtn'` is the truth.
- **Never trust macOS IPs for location.** They resolve to corporate VPN egress points (Westlake Village, CA; Indianapolis, IN; Chicago, IL via Zscaler). When answering "where was I," filter to iOS first.
- **Never canonicalize artist names.** Track URIs are the truth. Remix attribution drifts ("Wild Horses — Sam Feldt Remix" is filed under Birdy, etc.); leave it alone.
- **Never dedupe plays by `(track name, artist)`.** Re-releases and regional variants share names. The export's `(ts, ms_played)` pair is the unique key.
- **Don't reach beyond scope on plans.** If you find a related improvement while working on a feature, note it in `PLAN.md` under "future work" — don't sneak it into the current change.