# Project Progress — Surfaces

**Session date:** April 28, 2026
**Milestones completed:** M0 through M9 (plus editorial playlist investigation)
**Codebase:** 25 TypeScript files, ~3,500 lines
**Commits:** 12

---

## What exists and works today

### Infrastructure (M0)
- Cloudflare Worker deployed at `https://spotify-agent.chrisbuice.workers.dev`
- D1 database (SQLite) with 14 tables for listening history, taste model, discovery pool, sessions, context snapshots, and settings
- KV namespace for OAuth token storage
- 4 cron triggers running continuously

### Spotify OAuth (M1)
- Full Authorization Code flow at `/auth/login` → `/auth/callback`
- Tokens stored in KV, auto-refreshed on 401
- SpotifyClient wrapper handles all API calls with automatic retry
- Scopes: playback control, library read, playlist read, follow read, top tracks/artists

### Listening Tracker (M2)
- **Every 1 minute:** polls Spotify's currently-playing endpoint, writes a `poll_observations` row
- **On each poll:** derives `play_events` from observations — classifies each track as completed (>80% played), skipped (<30% + <30s), partial, or replayed
- Records: track ID, artist IDs, album, device type, context URI, hour of day, day of week
- Daily cleanup prunes observations older than 30 days (keeps derived events forever)
- The tracker has been running since the start of this session, accumulating data

### Taste Model (M3)
- **121 tracks scored, 238 artists scored, 16 seasonal playlists detected**
- Pulls from: saved/liked songs, top tracks (short/medium/long term), top artists, followed artists, seasonal playlist tracks, play event history
- Seasonal playlists auto-detected by name pattern (spring/summer/fall/winter, plus custom: "brrr"=winter, "wynter"=summer) — only user-owned playlists
- Track taste score = weighted sum of: library presence, top-track rank, seasonal playlist count, current season presence, play/skip/complete counts, recency, artist boost
- Artist taste score = weighted sum of: top-artist rank, followed status, play count, unique tracks played
- Rebuilds daily at 1am ET via cron

### Curation Agent (M4, M6, M8)
The core feature — build and play a music session. Invoked via:
- `POST /api/start-session` with `{mode, output, duration_min, context}`
- `POST /shortcut/start` with Bearer token auth (for future iOS Shortcut)

**6 modes:** waking_up, working, driving, brainstorming, unwinding, sleeping — each with default time window, duration, output type, and fresh multiplier.

**Mode inference:** if no mode specified, infers from current hour + day of week.

**Session building:**
1. Captures a context snapshot (weather, daylight, device, location)
2. Builds familiar candidate pool from `track_taste`, filtered by recency
3. Builds fresh candidate pool from `fresh_pool`
4. Applies context multipliers (cold-start rules) to familiar track scores
5. For each position in the session, uses the **freshness arc** to decide familiar vs. fresh:
   - Position 0%: 100% familiar
   - Position 25%: 90% familiar
   - Position 50%: 70% familiar
   - Position 75%: 50/50 (exploration peak)
   - Position 90%: 80% familiar (cool down)
   - Position 100%: end on something known
6. Weighted random selection, penalizing same-artist back-to-back
7. Executes: `play_now` (starts playback), `queue` (adds to queue), or `playlist` (creates playlist — currently broken due to Dev Mode write restriction)

**Context-aware biases (cold-start rules):**
- Night + unwinding/sleeping → favor low-skip-rate comfort tracks
- Morning + waking_up → favor current-season playlist tracks
- Rain/overcast → small comfort bias for low-skip tracks
- Hot midday → favor summer seasonal tracks
- Cold weather → favor winter seasonal tracks
- Smartphone + in motion → driving signal, boost familiar tracks
- Car Bluetooth → driving-context bias
- Calendar focus block → favor high-completion tracks
- All biases are multipliers clamped to [0.5, 2.0] — they nudge, never exclude

### Discovery Agent (M5)
- Runs daily at 6am ET via cron
- **Search-based approach:** rotates between followed artists (Day A) and top artists (Day B), searching Spotify for their recent tracks
- Scores candidates against taste model: primary artist score, collaborator scores, seasonal playlist presence, followed-artist bonus
- Inserts top 50 scorers into `fresh_pool` with 21-day expiry
- Deduplicates against known tracks (already in taste model or play history)
- Currently holds **44 fresh + 6 queued = 50 tracks** in the pool

### Physical Context Capture (M7)
- On every session start, captures a `context_snapshot`:
  - **Time:** local hour, minute, day of week (America/New_York)
  - **Daylight phase:** pre_dawn / morning / midday / golden_hour / dusk / night (computed from sunrise/sunset)
  - **Weather:** temperature (°F), condition (clear/partly_cloudy/rain/snow/etc.), precipitation, wind, cloud cover — from Open-Meteo API (free, no key)
  - **Location:** from shortcut payload (GPS), or falls back to home default (Atlanta, 33.78, -84.39)
  - **Device:** from most recent poll observation
  - **Motion/Bluetooth:** from shortcut payload (for driving detection)
  - **User note:** free text from shortcut or API ("about to cook dinner")
- Settings table seeded with home location and timezone

### In-Session Feedback (M9)
- **Every 2 minutes:** cron checks for active (un-ended) sessions
- Matches `play_events` to `session_tracks` and updates outcomes
- Links each play event to the session's context snapshot via `play_event_context` (feeds future learned affinities)
- Detects patterns:
  - 3+ consecutive skips → `familiarityShifted` flag
  - 3 skips in first 5 tracks → `contextReset` flag (context guess was likely wrong)
- Marks fresh tracks as `liked` (on replay) or `skipped` in the pool
- Auto-ends sessions after 4 hours or when all tracks have outcomes

---

## What doesn't work / known issues

### Spotify Dev Mode Restrictions
The biggest limitation. Our app is in Spotify's "Development Mode" which restricts certain API endpoints:

| Endpoint | Status | Impact |
|----------|--------|--------|
| `/me/tracks`, `/me/top/*` | Works | Taste model, discovery |
| `/me/player/play`, `/me/player/queue` | Works | Playback control |
| `/me/playlists` (list) | Works | Seasonal detection |
| `/playlists/{id}/tracks` (user-owned) | Works | Seasonal playlist sync |
| `/playlists/{id}/tracks` (Spotify-owned) | **403** | Can't scan editorial playlists |
| `/browse/new-releases` | **403** | Can't fetch new releases |
| Playlist write (add tracks) | **403** | `output=playlist` creates empty playlists |
| `/v1/search` | Works | Discovery uses this as workaround |

**Extended Quota Mode** requires a registered business with 250K+ monthly active users — not applicable for a personal app. This is a Spotify policy limitation, not a code issue.

**Workarounds in place:**
- Discovery uses search API instead of editorial playlists and new-releases
- `play_now` and `queue` work for session output
- Taste model rebuilds work when the token has fresh scopes (may need periodic re-auth at `/auth/login`)

### Other Issues
- **Taste model token sensitivity:** if the OAuth token refreshes and loses scopes, the taste model rebuild may fail on seasonal playlist access. Fix: re-auth at `/auth/login`.
- **Test playlists:** Several empty playlists ("test-delete-me", "working — 2026-04-28") were created during debugging. Delete manually from Spotify.
- **Taste model is thin:** Only 121 tracks scored. Will improve as the tracker accumulates more listening data over the coming days/weeks.

---

## Cron jobs running

| Schedule | What it does |
|----------|-------------|
| `* * * * *` | Poll currently-playing + derive play events |
| `*/2 * * * *` | In-session feedback (skips/replays/context linking) |
| `0 5 * * *` (1am ET) | Rebuild taste model + prune old observations |
| `0 10 * * *` (6am ET) | Run discovery agent |

---

## API endpoints

| Path | Method | Auth | Description |
|------|--------|------|-------------|
| `/` | GET | — | Health check |
| `/auth/login` | GET | — | Start Spotify OAuth |
| `/auth/callback` | GET | — | OAuth callback |
| `/me` | GET | — | Verify auth, returns Spotify profile |
| `/api/start-session` | POST | — | Start a curation session |
| `/shortcut/start` | POST | Bearer | iOS Shortcut endpoint with context |
| `/debug/recent-observations` | GET | — | Last 20 poll observations |
| `/debug/recent-events` | GET | — | Last 20 play events |
| `/debug/derive` | GET | — | Manually trigger event derivation |
| `/debug/rebuild-taste` | GET | — | Manually trigger taste model rebuild |
| `/debug/top-tracks-by-score` | GET | — | Top tracks by taste score |
| `/debug/top-artists` | GET | — | Top artists by taste score |
| `/debug/seasonal-playlists` | GET | — | Detected seasonal playlists |
| `/debug/run-discovery` | GET | — | Manually trigger discovery agent |
| `/debug/fresh-pool` | GET | — | Top fresh pool entries |
| `/debug/fresh-pool-stats` | GET | — | Fresh pool status counts |
| `/debug/last-snapshot` | GET | — | Latest context snapshot |
| `/debug/session-biases` | GET | — | Context biases for last session |
| `/debug/run-feedback` | GET | — | Manually trigger feedback processing |
| `/debug/all-playlists` | GET | — | List all user playlists |
| `/debug/discovery-sources` | GET | — | Test discovery source availability |

---

## Repository structure

```
spotifygenie/
├── SPOTIFY_AGENT_PLAN.md          # Source of truth — full project plan
├── PROGRESS.md                    # This file
├── OPEN_QUESTIONS.md              # Tracked decisions and open items
├── package.json
├── tsconfig.json
├── wrangler.toml                  # Cloudflare config (Workers, D1, KV, crons)
├── .dev.vars.example              # Template for local secrets
│
└── src/
    ├── index.ts                   # Worker entrypoint: HTTP routing + cron handlers
    ├── config.ts                  # Mode definitions, tunable constants
    │
    ├── auth/
    │   ├── spotify-oauth.ts       # OAuth login, callback, token refresh
    │   └── tokens.ts              # KV-backed token storage
    │
    ├── spotify/
    │   ├── client.ts              # Fetch wrapper with auth + retry
    │   ├── library.ts             # Saved tracks, top tracks/artists, playlists
    │   ├── playback.ts            # Play, queue, create playlist, devices
    │   └── browse.ts              # New releases, artist releases, search
    │
    ├── tracker/
    │   ├── poll.ts                # Cron: poll currently-playing
    │   └── derive.ts              # Turn observations into play events
    │
    ├── taste/
    │   ├── model.ts               # Rebuild track_taste + artist_taste
    │   ├── seasonal.ts            # Detect and sync seasonal playlists
    │   └── score.ts               # Compute taste scores
    │
    ├── discovery/
    │   ├── agent.ts               # Cron: scout candidates, score, populate pool
    │   ├── sources.ts             # Pull candidates from search/artists
    │   └── pool.ts                # Fresh pool management
    │
    ├── context/
    │   ├── capture.ts             # Build context_snapshot from inputs + APIs
    │   ├── weather.ts             # Open-Meteo client + daylight phase
    │   └── rules.ts               # Cold-start context biases
    │
    ├── curation/
    │   ├── agent.ts               # Build a session: familiar + fresh + context
    │   ├── modes.ts               # Mode inference from time of day
    │   ├── arc.ts                 # Position-based freshness curve
    │   ├── context_score.ts       # Apply context multipliers to tracks
    │   └── feedback.ts            # In-session skip/replay reactions
    │
    └── db/
        ├── schema.sql             # Full D1 schema (14 tables)
        └── queries.ts             # Typed query helpers
```

---

## Git tags (rollback points)

| Tag | Commit | Description |
|-----|--------|-------------|
| `m3-complete` | `670b7e1` | Taste model working with seasonal playlists |
| `m5-complete` | `77e1a7a` | Discovery agent with fresh pool populated |
| `m6-complete` | `d4b7c74` | Full curation with familiar/fresh arc |
| `m8-complete` | `925eaa8` | Context-aware curation with cold-start rules |

---

## What's next (not started)

Per the plan, these milestones are deferred:

| Milestone | What | Notes |
|-----------|------|-------|
| M10 | Learned context affinities | **DONE.** Nightly cron rebuilds `track_context_affinity`. `context_score.ts` blends learned affinities with cold-start rules (threshold: sample_size >= 5). Dashboard shows "Learned Affinities" section grouped by context bucket. API: `/api/top-affinities`. |
| M11 | iOS Shortcut endpoints + the shortcut itself | **DONE.** `/shortcut/start`, `/shortcut/queue`, `/shortcut/save_to_seasonal`, `/shortcut/update-location` endpoints with token auth. All 6 iOS Shortcuts built and working with GPS/Bluetooth context. `SETUP_SHORTCUTS.md` documented. |
| M12 | Calendar integration | **SKIPPED.** User doesn't use calendar in a way that would benefit curation. |
| M13 | Dashboard | **DONE.** Cloudflare Pages at `spotify-agent-dashboard.pages.dev` behind Cloudflare Access. Sections: Now Playing, mode buttons, Why These Tracks, context snapshot, session biases, learned affinities, fresh pool, stats, recent history with like/block. |
| M14 | MCP server | **DONE.** JSON-RPC 2.0 MCP server at `/mcp` with 8 tools: start_session, current_session_status, end_session, add_to_seasonal, get_fresh_pool, mark_track, stats, current_context. Auth via Bearer token (SHORTCUT_TOKEN). No SDK dependency — manual protocol implementation (~80 lines). |

---

## Credentials to save

| Item | Value |
|------|-------|
| Worker URL | `https://spotify-agent.chrisbuice.workers.dev` |
| Spotify Client ID | `1a78c31c5d7c40f7811ebd6577fc3b6a` |
| Spotify Client Secret | `<redacted — rotated 2026-05-03>` |
| Shortcut Token | `01cf403770ffe6e42951ad30f5e7686b9900cef134f0ed6ef3ab3da9178b72b9` |
| Spotify User ID | `121776622` |
| D1 Database ID | `a639e396-3fb1-4db6-b5a5-ce61c60d5779` |
| KV Namespace ID | `7055b925a6b74bd39150201370724eeb` |
