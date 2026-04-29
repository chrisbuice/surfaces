# Spotify Curation Agent — Project Status

**Last updated:** April 29, 2026 (end of session 4)
**Codebase:** 32 TypeScript files + 1 HTML dashboard, ~7,640 lines
**Commits:** 52 on main branch
**All planned milestones (M0–M16) are complete** (M12 skipped by choice)

This document is intended to bring a new conversation up to speed on the full state of the application — what exists, how it works, what files do what, and what's left to explore.

---

## 1. What the application does

This is a personal Spotify music curation agent. It runs 24/7 on Cloudflare Workers, watches my listening behavior, builds a taste profile, discovers new music from editorial sources, and curates sessions that blend familiar favorites with fresh discoveries — all tuned to time of day, weather, location, and what I'm doing.

**Three interfaces:**
- **Siri voice commands** — "Hey Siri, Working Music" triggers an iOS Shortcut that starts a curated session with GPS context
- **Web dashboard** — `spotify-agent-dashboard.pages.dev` (behind Cloudflare Access) with live Now Playing, session controls, fresh pool, stats, like/block
- **Claude chat** — MCP server at `/mcp` lets Claude.ai start sessions, check stats, manage tracks conversationally

---

## 2. Infrastructure

Everything runs on Cloudflare's free tier. Zero monthly cost.

| Component | Service | Details |
|-----------|---------|---------|
| API + cron | Cloudflare Worker | `spotify-agent.chrisbuice.workers.dev` |
| Database | Cloudflare D1 | SQLite, 15 tables (schema in `src/db/schema.sql`) |
| Token/config store | Cloudflare KV | OAuth tokens, playlist IDs, location cache |
| Dashboard | Cloudflare Pages | `spotify-agent-dashboard.pages.dev`, Cloudflare Access gated |
| Weather | Open-Meteo API | Free, no key required |
| Email | Resend | Nightly listening summary |
| MCP | JSON-RPC 2.0 on Worker | 8 tools for Claude.ai integration |

### Cron schedule

| Cron | UTC | ET | What |
|------|-----|-----|------|
| `* * * * *` | Every min | Every min | Poll Spotify playback, derive play events |
| `*/2 * * * *` | Every 2 min | Every 2 min | In-session feedback (skip/replay detection), context snapshots |
| `0 5 * * *` | 5:00 AM | 1:00 AM | Derive events, rebuild taste model, rebuild learned affinities, prune old data |
| `0 10 * * *` | 10:00 AM | 6:00 AM | Discovery agent (artist search + editorial RSS) |
| `0 0 * * *` | Midnight | 8:00 PM | Nightly listening summary email |

### Spotify API limitations

The app is permanently in Spotify's **Development Mode** (Extended Quota requires 250K+ MAU — not applicable). Dev Mode blocks most non-user-scoped endpoints. A comprehensive workaround is in place using embed page scraping.

| What works | What's blocked | Workaround |
|-----------|----------------|------------|
| `/me/tracks`, `/me/top/*` (taste data) | `/playlists/{id}/tracks` (read playlist tracks) | Embed scraping via `src/spotify/embed.ts` |
| `/me/player/*` (playback control) | `/playlists/{id}/items` GET (read playlist items) | Same embed scraping |
| `/me/playlists` (list playlists) | `/v1/tracks` (batch track lookup) | Not needed currently |
| `/v1/search` (discovery) | `/browse/new-releases` | Discovery uses search + RSS |
| `/v1/me/playlists` POST (create playlists) | `/artists/{id}/albums` | Not needed currently |
| `/v1/playlists/{id}/items` POST (add tracks) | Client credentials (all endpoints) | N/A |

**Embed scraping** (`src/spotify/embed.ts`): Fetches `open.spotify.com/embed/playlist/{id}` and parses the `__NEXT_DATA__` JSON payload. Returns track IDs, names, artist names, and duration. No auth required. Does NOT include `added_at` timestamps, album data, or structured artist IDs. Used by:
- Taste model rebuild (seasonal playlist track ingestion)
- Curation agent (loading blocked tracks to filter from sessions)
- `/debug/playlist-tracks` endpoint (taste archaeology)

---

## 3. Database schema (15 tables)

| Table | Purpose |
|-------|---------|
| `users` | Spotify user ID mapping |
| `poll_observations` | Raw playback polls (every minute) |
| `play_events` | Derived listening events with classification (completed/skipped/partial/replayed) |
| `track_taste` | Per-track taste scores: library presence, top-track rank, seasonal count, play/skip ratio |
| `artist_taste` | Per-artist scores: top-artist rank, follow status, play counts |
| `mode_profiles` | Hour distribution per mode (waking_up, working, etc.) |
| `seasonal_playlists` | Auto-detected seasonal playlists with season/year |
| `context_snapshots` | Weather, daylight, location, device, motion at session start |
| `play_event_context` | Links each play event to the context snapshot it occurred under |
| `track_context_affinity` | Learned affinities: how much a track is favored in specific contexts |
| `settings` | Home location, timezone, feature flags |
| `fresh_pool` | Discovery candidates with source, score, status (fresh/queued/played/liked/skipped) |
| `sessions` | Curation sessions: mode, timestamps, output type, context snapshot |
| `session_tracks` | Tracks in each session with position, source (familiar/fresh), outcome |

Full schema: `src/db/schema.sql` (222 lines)

---

## 4. File structure

```
spotifygenie/
  SPOTIFY_AGENT_PLAN.md        # Original plan document (milestones, algorithms, data model)
  PROGRESS.md                  # Session 1 progress notes (M0-M9 details)
  PROJECT_STATUS.md            # This file — full project status
  OVERVIEW.md                  # Shareable project overview for non-technical audience
  SETUP_SHORTCUTS.md           # Step-by-step iOS Shortcut setup instructions
  OPEN_QUESTIONS.md            # Design decisions and open items

  wrangler.toml                # Cloudflare config: Worker, D1, KV, cron triggers
  package.json                 # No runtime deps. Dev: wrangler, typescript, @cloudflare/workers-types

  dashboard/
    index.html                 # Single-file dashboard (549 lines, inline JS, no framework)

  src/
    index.ts                   # Worker entrypoint: HTTP routing (40+ routes) + cron dispatch
    config.ts                  # Mode definitions, tunable constants (freshness curve, multiplier bounds)

    auth/
      spotify-oauth.ts         # OAuth Authorization Code flow: /auth/login, /auth/callback
      tokens.ts                # KV-backed token storage with auto-refresh on 401

    spotify/
      client.ts                # SpotifyClient: fetch wrapper with auth headers + retry
      library.ts               # Saved tracks, top tracks/artists, playlists, followed artists
      embed.ts                 # Embed scraping: read playlist tracks without API auth (Dev Mode workaround)
      playback.ts              # play(), queue(), createPlaylist(), getActiveDevice()
      browse.ts                # Search (used by discovery)

    audio/
      reccobeats.ts            # ReccoBeats client (AudioFeaturesProvider interface)
      backfill.ts              # Cron handler: batched audio feature fetch

    tracker/
      poll.ts                  # Cron: poll /me/player, write poll_observations
      derive.ts                # Turn sequential observations into play_events with classification

    taste/
      model.ts                 # Rebuild track_taste + artist_taste from all sources
      seasonal.ts              # Detect seasonal playlists by name, sync track membership
      score.ts                 # Compute weighted taste scores

    discovery/
      agent.ts                 # Cron: pull candidates, score, populate fresh_pool
      sources.ts               # Candidate sources: followed/top artist search + editorial RSS feeds
      pool.ts                  # Fresh pool CRUD: add, mark used, expire stale, stats

    context/
      capture.ts               # Build context_snapshot: merge GPS + weather + daylight + device
      weather.ts               # Open-Meteo client, daylight phase from sunrise/sunset
      rules.ts                 # Cold-start context biases (10 rules: night, rain, driving, etc.)
      affinity.ts              # Nightly cron: rebuild track_context_affinity from play history

    curation/
      agent.ts                 # Core: build session tracklist (familiar + fresh + context scoring)
      modes.ts                 # Mode inference from time of day + context signals
      arc.ts                   # Position-based freshness curve (familiar→fresh→familiar)
      context_score.ts         # Blend cold-start rules with learned affinities per track
      feedback.ts              # In-session: detect skips/replays, shift queue, link context

    email/
      summary.ts               # Nightly listening summary email via Resend

    mcp/
      server.ts                # JSON-RPC 2.0 MCP dispatcher (~100 lines, no SDK)
      tools.ts                 # 8 MCP tool definitions + handlers

    db/
      schema.sql               # Full D1 schema (15 tables, indexes)
      queries.ts               # Typed query helpers for poll observations and play events
```

---

## 5. Milestone completion status

| Milestone | Name | Status | Key files |
|-----------|------|--------|-----------|
| M0 | Infrastructure | Done | `wrangler.toml`, `src/db/schema.sql` |
| M1 | Spotify OAuth | Done | `src/auth/spotify-oauth.ts`, `src/auth/tokens.ts` |
| M2 | Listening tracker | Done | `src/tracker/poll.ts`, `src/tracker/derive.ts` |
| M3 | Taste model | Done | `src/taste/model.ts`, `src/taste/seasonal.ts` |
| M4 | Curation agent v1 | Done | `src/curation/agent.ts` |
| M5 | Discovery agent | Done | `src/discovery/agent.ts`, `src/discovery/sources.ts` |
| M6 | Freshness arc | Done | `src/curation/arc.ts`, `src/curation/agent.ts` |
| M7 | Context capture | Done | `src/context/capture.ts`, `src/context/weather.ts` |
| M8 | Context-aware curation | Done | `src/context/rules.ts`, `src/curation/context_score.ts` |
| M9 | In-session feedback | Done | `src/curation/feedback.ts` |
| M10 | Learned affinities | Done | `src/context/affinity.ts`, `src/curation/context_score.ts` |
| M11 | iOS Shortcuts | Done | `SETUP_SHORTCUTS.md`, shortcut endpoints in `src/index.ts` |
| M12 | Calendar integration | Skipped | User doesn't use calendar in a way that benefits curation |
| M13 | Dashboard | Done | `dashboard/index.html` |
| M14 | MCP server | Done | `src/mcp/server.ts`, `src/mcp/tools.ts` |
| M15 | Editorial RSS discovery | Done | `src/discovery/sources.ts` (Stereogum, Line of Best Fit, EARMILK) |
| M16 | ReccoBeats audio features | Done | `src/audio/reccobeats.ts`, `src/audio/backfill.ts`, `src/db/migrations/001_audio_features.sql` |
| M17 | Acoustic preference profile | Done | `src/audio/profile.ts`, `src/db/migrations/002_acoustic_profile.sql` |

---

## 6. API endpoints (complete list)

### Public API

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Health check |
| `/auth/login` | GET | Start Spotify OAuth flow |
| `/auth/callback` | GET | OAuth callback |
| `/me` | GET | Verify auth, returns Spotify profile |
| `/api/now-playing` | GET | Current playback: track, artist, progress, device, play context (agent vs manual) |
| `/api/start-session` | POST | Start a curation session: `{mode, output, duration_min, context}` |
| `/api/session-explain` | GET | Why each track was picked in the most recent session |
| `/api/top-affinities` | GET | Tracks with strongest learned context affinities |
| `/api/like-track` | POST | Add track to "Liked via Agent" playlist: `{track_id}` |
| `/api/block-track` | POST | Add track to "Blocked" playlist (excluded from future sessions): `{track_id}` |
| `/api/queue-track` | POST | Queue a track on active device: `{track_id}` |
| `/api/recent-history` | GET | Last 24 hours of play events with taste scores |

### Shortcut endpoints (Bearer token auth via SHORTCUT_TOKEN)

| Path | Method | Description |
|------|--------|-------------|
| `/shortcut/start` | POST | Start session with context payload, returns spoken summary |
| `/shortcut/queue` | POST | Queue session tracks without disrupting playback |
| `/shortcut/save_to_seasonal` | POST | Add currently-playing to current season's playlist |
| `/shortcut/update-location` | POST | Update GPS location + context signals |

### MCP endpoint

| Path | Method | Description |
|------|--------|-------------|
| `/mcp` | POST | JSON-RPC 2.0 MCP server (no auth required for Claude.ai connectors) |

**MCP tools:** `start_session`, `current_session_status`, `end_session`, `add_to_seasonal`, `get_fresh_pool`, `mark_track`, `stats`, `current_context`

### Debug endpoints

| Path | Description |
|------|-------------|
| `/debug/recent-observations` | Last 20 poll observations |
| `/debug/recent-events` | Last 20 play events |
| `/debug/derive` | Manually trigger event derivation |
| `/debug/rebuild-taste` | Manually trigger taste model rebuild |
| `/debug/top-tracks-by-score?limit=N` | Top tracks by taste score |
| `/debug/top-artists` | Top artists by taste score |
| `/debug/seasonal-playlists` | Detected seasonal playlists |
| `/debug/run-discovery?day=N` | Manually trigger discovery (optional day override for RSS rotation) |
| `/debug/discovery-sources` | Test discovery source availability |
| `/debug/fresh-pool?limit=N` | Top fresh pool entries |
| `/debug/fresh-pool-stats` | Fresh pool status counts |
| `/debug/last-snapshot` | Latest context snapshot |
| `/debug/session-biases` | Context biases for last session |
| `/debug/run-feedback` | Manually trigger feedback processing |
| `/debug/send-summary` | Manually trigger nightly email |
| `/debug/rebuild-affinities` | Manually trigger affinity rebuild |
| `/debug/track-affinities?track_id=X` | View affinities for a specific track |
| `/debug/all-playlists` | List all user playlists |
| `/debug/playlist-tracks?id=X&limit=N` | Full track listing of any playlist via embed scraping |
| `/debug/audio-features?track_id=X` | Audio features for a track (fetches from ReccoBeats if missing) |
| `/debug/audio-features-stats` | Coverage: tracks scored, with features, not found, missing |
| `/debug/run-audio-backfill` | Manually trigger a backfill batch (40 tracks) |

---

## 7. Key algorithms

### Taste scoring (`src/taste/model.ts`, `src/taste/score.ts`)

Track taste score = weighted sum of:
- In liked songs (+3)
- Top tracks short-term (+5), medium-term (+3), long-term (+2)
- Seasonal playlist count (+1 each, +2 if current season) — sourced via embed scraping
- Play count (log-scaled)
- Complete count bonus, skip count penalty
- Recency bonus for recently played
- Primary artist taste score boost

**Note:** Seasonal playlist tracks ingested via embed scraping have track IDs and names but no structured artist IDs or album data. Tracks that also appear in liked songs or top tracks (which use working API endpoints) have full metadata. Seasonal-only tracks get correct playlist counts but incomplete artist linkage.

Artist taste score = weighted sum of:
- Top artists short/medium/long-term rank
- Is followed (+2)
- Total plays and unique tracks played

### Freshness arc (`src/curation/arc.ts`)

Controls the familiar vs. fresh mix at each position in a session:
- Start: 100% familiar (anchor with known tracks)
- Middle: gradually increase fresh ratio
- 75%: peak exploration (50/50)
- End: return to familiar (close on a known favorite)

The arc is scaled by the mode's `freshMultiplier` (working=low, brainstorming=high).

### Context scoring (`src/curation/context_score.ts`, `src/context/rules.ts`)

Two layers:
1. **Cold-start rules** — 10 hand-coded biases (night+unwinding=comfort, rain=comfort, car BT=driving energy, etc.). Each is a multiplier in [0.5, 2.0].
2. **Learned affinities** — nightly cron computes `P(track|context) / P(context)` from play history. When `sample_size >= 5`, the learned value replaces the cold-start rule for that dimension+bucket.

Product of all applicable multipliers is clamped to [0.5, 2.0] and applied to the track's taste score.

### Discovery scoring (`src/discovery/agent.ts`)

Candidates scored by:
- Primary artist taste score (60% weight)
- Collaborator artist scores (20% weight each)
- Seasonal artist bonus (+2)
- Followed artist source bonus (+1.5)

### Editorial RSS parsing (`src/discovery/sources.ts`)

Three feeds rotated daily: Stereogum, The Line of Best Fit, EARMILK. Titles are regex-parsed for artist + track name patterns (e.g., `Artist shares new song, "Track Name"`). Extracted pairs are searched on Spotify to get track IDs. Up to 10 searches per feed, well within the 50-subrequest Worker limit.

---

## 8. Dashboard sections (`dashboard/index.html`)

1. **Now Playing** — Live playback with dot animation, track/artist, progress, device. Like/block buttons. Shows why track is playing (agent session details or "Manual play").
2. **Start Session** — 6 mode buttons + output selector (play_now/queue)
3. **Why These Tracks** — Per-track explanation table for the last session (source, reasons, outcome)
4. **Latest Context** — Captured timestamp, daylight, weather, location, device, wind, cloud
5. **Session Biases Applied** — Context biases active in the last session (dimension, bucket, multiplier)
6. **Learned Affinities** — Tracks with strongest learned affinities grouped by context bucket (auto-hides when empty)
7. **Fresh Pool** — Top 15 discovery candidates with source, score, queue button
8. **Stats** — 4-box: recent events, completed, skipped, skip rate
9. **Last 24 Hours** — Play history with timestamps, classification badges, taste scores, like/block buttons

---

## 9. iOS Shortcuts

Six shortcuts built and working (documented in `SETUP_SHORTCUTS.md`):

| Shortcut | Mode | Default Duration |
|----------|------|-----------------|
| Waking Up Music | `waking_up` | 30 min |
| Working Music | `working` | 90 min |
| Driving Music | `driving` | 45 min |
| Brainstorming Music | `brainstorming` | 60 min |
| Unwinding Music | `unwinding` | 60 min |
| Sleeping Music | `sleeping` | 45 min |

Each shortcut: gets GPS location, builds a JSON body with mode + context, POSTs to `/shortcut/start` with Bearer token, speaks the response summary.

---

## 10. Nightly email (`src/email/summary.ts`)

Sent at 8pm ET via Resend. Light theme for mobile readability. Contains:
- Top tracks of the day with play counts
- Total plays, completed, skipped
- Skip rate
- Fresh discovery stats
- Device breakdown

---

## 11. Known issues and limitations

1. **Spotify Dev Mode is permanent** — the app will never leave Dev Mode (Extended Quota requires 250K+ MAU). All playlist-track reads go through embed scraping, which does not provide `added_at` timestamps, album data, or structured artist IDs. This is the accepted tradeoff.
2. **Embed scraping is a dependency on Spotify's embed page structure** — if Spotify changes how `__NEXT_DATA__` is rendered in their embed pages, the scraping will break. The failure is loud (parse errors) and the fix would be updating the regex/JSON path in `src/spotify/embed.ts`.
3. **Seasonal playlist detection: ownership edge case** — Spotify sometimes reports playlists as user-owned when they were copied rather than created. An explicit exclude list (`EXCLUDE_PLAYLIST_IDS` in `seasonal.ts`) handles known false positives. Only playlists owned by Spotify user `121776622` are considered.
4. **Seasonal year inference: no added_at data** — new playlists without a year in the name default to current year. All existing undated playlists already have correct years from earlier syncs. The user's current naming convention always includes the year.
5. **OAuth token drift** — if token refreshes and loses scopes, some API calls may fail. Fix: re-auth at `/auth/login`.
6. **Learned affinities need time** — the system needs ~1000+ context-linked play events to generate meaningful affinities. Until then, cold-start rules dominate. This is working as designed.
7. **RSS title parsing is regex-based** — imperfect, but fails safely (unparseable items are skipped, bad Spotify matches get low taste scores).

---

## 12. Credentials and URLs

| Item | Value |
|------|-------|
| Worker URL | `https://spotify-agent.chrisbuice.workers.dev` |
| Dashboard URL | `https://spotify-agent-dashboard.pages.dev` |
| MCP endpoint | `https://spotify-agent.chrisbuice.workers.dev/mcp` |
| Spotify Client ID | `1a78c31c5d7c40f7811ebd6577fc3b6a` |
| Shortcut Token | `01cf403770ffe6e42951ad30f5e7686b9900cef134f0ed6ef3ab3da9178b72b9` |
| Spotify User ID | `121776622` |
| D1 Database ID | `a639e396-3fb1-4db6-b5a5-ce61c60d5779` |
| KV Namespace ID | `7055b925a6b74bd39150201370724eeb` |

---

## 13. Commit history

```
d8e4cbe M16: Debug endpoints for audio features
085c11d M16: ReccoBeats client, backfill cron, and audio features pipeline
1fa6e79 M16: Add track_audio_features table
b6f270f Remove dead code referencing removed/renamed Spotify endpoints
e449fe0 Tolerant fix for playlist field rename (tracks → items)
f588177 Backfill quick skips from Spotify recently-played API
2c00953 Raise skip threshold from 30% to 50%
cf1249a Add replay bonus to taste scoring
51ba439 Fix skip detection: remove impossible 30s time threshold
1f6bcd6 Redesign stats: today's listening, agent, discovery, taste model
9868c81 Now Playing: show next 3 tracks in queue
c33c678 History: store artist names at poll time, show device for direct plays
95665d3 Last 24 Hours: add artist name and play source column
c9024a8 Fix year inference overwriting correct years for undated playlists
cdde6e8 Prefer phone over soundbar when no device is actively playing
9854410 Exclude "a late summer" from seasonal playlists
2718a18 Fix three features silently broken by Spotify Dev Mode
7e14204 Exclude followed-not-curated playlist from seasonal detection
9986bd5 Add /debug/playlist-tracks for taste archaeology
d00f888 Add PROJECT_STATUS.md for Claude.ai project context
c77e9bb Now Playing: add like/block buttons and play context explanation
13f0000 Add day override to discovery agent for manual feed polling
8eac1d9 M15: Add editorial RSS feeds as discovery sources
35a9261 Allow MCP endpoint without Bearer token for Claude.ai connectors
46663fb M10, M13, M14: learned affinities, dashboard update, MCP server
8f4426b Redesign summary email: light theme for better mobile readability
9b34842 Nightly listening summary email via Resend
9453a58 What's playing and why — track explanation on dashboard
7b547d0 Add /shortcut/update-location for precision context tracking
7c711dd Fix device tracking: use /me/player instead of /me/player/currently-playing
2713d4f Like and block tracks via dedicated playlists
db08c36 Switch to Spotify /items endpoints — unlocks playlist read/write in Dev Mode
fb18c72 Deduplicate fresh pool by track name + artist
5f016fa Ambient context tracking: every play event linked to environmental context
eb9ac09 Include played tracks in taste model rebuild
52d8309 M13: dashboard + Dev Mode audit
bb0b4d7 M11: iOS Shortcut endpoints + setup instructions
b2c1881 M10: learned context affinities
e63a8d1 Add PROGRESS.md — detailed project status after M0-M9
a894219 Remove editorial playlist scanning — still 403 in Dev Mode
3e3f77c M9: in-session feedback loop
925eaa8 M8: context-aware curation with cold-start rule biases
34b493e M7: physical context capture
d4b7c74 M6: full curation with fresh arc
77e1a7a M5: discovery agent v1 — search-based fresh pool
9018368 M4: curation agent v1 — familiar-only sessions with play_now
670b7e1 M3 fix: improved seasonal playlist detection
12db7db M3: taste model v1 — seasonal playlists, track/artist taste scoring
45b0140 M2: listening tracker with cron polling and play_events derivation
1c1a24c M1: Spotify OAuth working end to end
a0b7ea9 M0: repo skeleton + hello-world Worker deployed
```

---

## 14. Future ideas (not planned, just bookmarked)

From `SPOTIFY_AGENT_PLAN.md` and session conversations:
- Weekly/monthly "personal Wrapped" email with context breakdowns
- Related artist discovery (search for new artists similar to top artists)
- Genre-based search discovery
- HomeKit / Home Assistant integration for richer at-home context
- Apple Watch / HealthKit for workout heart-rate signals
- "Why am I hearing this?" per-track breakdown by taste + mode + each context dimension
- Additional editorial RSS feeds (Bandcamp, AllMusic, etc.)
- Car Bluetooth auto-trigger automation (user prefers manual control for now — only wake-up alarm and car BT are approved automations)
