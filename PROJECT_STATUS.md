# Spotify Curation Agent — Project Status

**Last updated:** April 29, 2026 (end of session 5)
**Codebase:** 37 TypeScript files + 1 HTML dashboard, ~10,380 lines
**Commits:** 74 on main branch
**All planned milestones (M0–M20) are complete** (M12 skipped by choice)
**Infrastructure:** Cloudflare Workers paid tier ($5/month)

This document is intended to bring a new conversation up to speed on the full state of the application — what exists, how it works, what files do what, and what's left to explore.

---

## 1. What the application does

This is a personal Spotify music curation agent. It runs 24/7 on Cloudflare Workers, watches my listening behavior, builds a taste profile, discovers new music from editorial sources, and curates sessions that blend familiar favorites with fresh discoveries — all tuned to time of day, weather, location, acoustic profile, and what I'm doing.

**Three interfaces:**
- **Siri voice commands** — "Hey Siri, Working Music" triggers an iOS Shortcut that starts a curated session with GPS context
- **Web dashboard** — `spotify-agent-dashboard.pages.dev` (behind Cloudflare Access) with live Now Playing + queue preview, session controls, fresh pool, 4-quadrant stats, like/block
- **Claude chat** — MCP server at `/mcp` lets Claude.ai start sessions, check stats, manage tracks conversationally

---

## 2. Infrastructure

Cloudflare Workers paid tier ($5/month). 1,000 subrequests/invocation, 30s CPU limit.

| Component | Service | Details |
|-----------|---------|---------|
| API + cron | Cloudflare Worker | `spotify-agent.chrisbuice.workers.dev` |
| Database | Cloudflare D1 | SQLite, 18 tables (schema in `src/db/schema.sql`) |
| Token/config store | Cloudflare KV | OAuth tokens, playlist IDs, location cache |
| Dashboard | Cloudflare Pages | `spotify-agent-dashboard.pages.dev`, Cloudflare Access gated |
| Weather | Open-Meteo API | Free, no key required |
| Audio features | ReccoBeats API | Free, no key required, 40-ID batch limit |
| Similar artists | Last.fm API | Free, key-only auth (`LASTFM_API_KEY` secret) |
| Music aggregator | Hype Machine API | Free, no auth required |
| Email | Resend | Nightly listening summary |
| MCP | JSON-RPC 2.0 on Worker | 8 tools for Claude.ai integration |

### Cron schedule

| Cron | UTC | ET | What |
|------|-----|-----|------|
| `* * * * *` | Every min | Every min | Poll Spotify playback, derive play events, backfill from recently-played |
| `*/2 * * * *` | Every 2 min | Every 2 min | In-session feedback (skip/replay detection), context snapshots |
| `0 5 * * *` | 5:00 AM | 1:00 AM | Derive events, rebuild taste model + acoustic fit, audio backfill, acoustic profile, affinities, prune |
| `0 10 * * *` | 10:00 AM | 6:00 AM | Discovery agent (multi-source, see below) |
| `0 0 * * *` | Midnight | 8:00 PM | Nightly listening summary email |

### Discovery source rotation

| Tier | Frequency | Sources |
|------|-----------|---------|
| Artist search | Daily (alternating) | Followed artists (even days) / Top artists (odd days) |
| Tier 1 editorial | Daily | Hype Machine (JSON API) |
| Tier 2 editorial | 5-day rotation | Stereogum → Line of Best Fit → EARMILK → Gorilla vs Bear → Aquarium Drunkard |
| Similar artists | Daily | Last.fm artist.getSimilar (top 6 seed artists, 7-day cache) |

30% of the fresh pool is reserved for editorial sources to prevent artist-search candidates from crowding out novel discoveries.

### Spotify API limitations

The app is permanently in Spotify's **Development Mode** (Extended Quota requires 250K+ MAU — not applicable). Dev Mode blocks most non-user-scoped endpoints. A comprehensive workaround is in place using embed page scraping.

| What works | What's blocked | Workaround |
|-----------|----------------|------------|
| `/me/tracks`, `/me/top/*` (taste data) | `/playlists/{id}/tracks` (read playlist tracks) | Embed scraping via `src/spotify/embed.ts` |
| `/me/player/*` (playback control) | `/playlists/{id}/items` GET (read playlist items) | Same embed scraping |
| `/me/playlists` (list playlists) | `/v1/tracks` (batch track lookup) | Not needed currently |
| `/v1/search` (discovery) | `/browse/new-releases` | Discovery uses search + RSS + Last.fm |
| `/v1/me/playlists` POST (create playlists) | `/artists/{id}/albums` | Not needed currently |
| `/v1/playlists/{id}/items` POST (add tracks) | Client credentials (all endpoints) | N/A |

**Feb 2026 API migration:** Playlist object field `tracks` renamed to `items`. Tolerant fix in place (`items?.total ?? tracks?.total`). Rollout to grandfathered apps postponed with no announced date. Dead code referencing removed endpoints cleaned up.

**Embed scraping** (`src/spotify/embed.ts`): Fetches `open.spotify.com/embed/playlist/{id}` and parses the `__NEXT_DATA__` JSON payload. Returns track IDs, names, artist names, and duration. No auth required. Does NOT include `added_at` timestamps, album data, or structured artist IDs. Used by:
- Taste model rebuild (seasonal playlist track ingestion)
- Curation agent (loading blocked tracks to filter from sessions)
- `/debug/playlist-tracks` endpoint (taste archaeology)

---

## 3. Database schema (18 tables)

| Table | Purpose |
|-------|---------|
| `users` | Spotify user ID mapping |
| `poll_observations` | Raw playback polls (every minute), includes artist_name |
| `play_events` | Derived listening events with classification (completed/skipped/partial/replayed) |
| `track_taste` | Per-track taste scores + cached `acoustic_fit_to_overall` |
| `artist_taste` | Per-artist scores: top-artist rank, follow status, play counts |
| `mode_profiles` | Hour distribution per mode |
| `seasonal_playlists` | Auto-detected seasonal playlists with season/year + `include_in_taste_model` flag |
| `context_snapshots` | Weather, daylight, location, device, motion at session start |
| `play_event_context` | Links each play event to the context snapshot it occurred under |
| `track_context_affinity` | Learned affinities: how much a track is favored in specific contexts |
| `settings` | Home location, timezone, feature flags |
| `fresh_pool` | Discovery candidates with source, score, status (fresh/queued/played/liked/skipped) |
| `sessions` | Curation sessions: mode, timestamps, output type, context snapshot |
| `session_tracks` | Tracks in each session with position, source (familiar/fresh), outcome |
| `track_audio_features` | ReccoBeats audio features (9 dimensions), nullable for not-found tracks |
| `acoustic_profile` | Per-mode centroids (mean+stddev) across audio feature dimensions |
| `lastfm_similar_cache` | 7-day TTL cache for Last.fm similar-artist API responses |

Full schema: `src/db/schema.sql`

---

## 4. File structure

```
spotifygenie/
  SPOTIFY_AGENT_PLAN.md        # Original plan document (milestones M0-M15)
  SPOTIFY_AGENT_PLAN_M16-M20.md # Extension plan (audio features, Last.fm, acoustic curation)
  PROGRESS.md                  # Session 1 progress notes (M0-M9 details)
  PROJECT_STATUS.md            # This file — full project status
  OVERVIEW.md                  # Shareable project overview for non-technical audience
  SETUP_SHORTCUTS.md           # Step-by-step iOS Shortcut setup instructions
  OPEN_QUESTIONS.md            # Design decisions and open items

  wrangler.toml                # Cloudflare config: Worker, D1, KV, cron triggers
  package.json                 # No runtime deps. Dev: wrangler, typescript, @cloudflare/workers-types

  dashboard/
    index.html                 # Single-file dashboard (~700 lines, inline JS, no framework)

  src/
    index.ts                   # Worker entrypoint: HTTP routing (50+ routes) + cron dispatch
    config.ts                  # Mode definitions, tunable constants

    auth/
      spotify-oauth.ts         # OAuth Authorization Code flow: /auth/login, /auth/callback
      tokens.ts                # KV-backed token storage with auto-refresh on 401

    spotify/
      client.ts                # SpotifyClient: fetch wrapper with auth headers + retry
      library.ts               # Saved tracks, top tracks/artists, playlists, followed artists
      embed.ts                 # Embed scraping: read playlist tracks without API auth
      playback.ts              # play(), queue(), createPlaylist(), getActiveDevice()
      browse.ts                # Artist releases, playlist search

    audio/
      reccobeats.ts            # ReccoBeats client (AudioFeaturesProvider interface)
      backfill.ts              # Cron handler: batched audio feature fetch
      profile.ts               # Build per-mode acoustic centroids from play history
      fit.ts                   # Compute per-track acoustic fit vs. a centroid

    tracker/
      poll.ts                  # Cron: poll /me/player + backfill from recently-played
      derive.ts                # Turn sequential observations into play_events with classification

    taste/
      model.ts                 # Rebuild track_taste + artist_taste + acoustic_fit_to_overall
      seasonal.ts              # Detect seasonal playlists by name, sync track membership
      score.ts                 # Compute weighted taste scores (incl. replay bonus)

    discovery/
      agent.ts                 # Cron: pull candidates, score, populate fresh_pool (editorial reserved slots)
      sources.ts               # Candidate sources: artist search + tiered RSS + Last.fm
      similar.ts               # Last.fm similar-artist graph traversal
      lastfm.ts                # Last.fm API client with D1 cache
      rss_extras.ts            # Gorilla vs Bear, Hype Machine, Aquarium Drunkard adapters
      pool.ts                  # Fresh pool CRUD: add, mark used, expire stale, stats

    context/
      capture.ts               # Build context_snapshot: merge GPS + weather + daylight + device
      weather.ts               # Open-Meteo client, daylight phase from sunrise/sunset
      rules.ts                 # Cold-start context biases (10 rules: night, rain, driving, etc.)
      affinity.ts              # Nightly cron: rebuild track_context_affinity from play history

    curation/
      agent.ts                 # Core: build session tracklist (familiar + fresh + context + acoustic fit)
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
      schema.sql               # Full D1 schema (18 tables, indexes)
      queries.ts               # Typed query helpers for poll observations and play events
      migrations/
        001_audio_features.sql
        002_acoustic_profile.sql
        003_lastfm_cache.sql
        004_track_taste_acoustic_fit.sql
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
| M16 | ReccoBeats audio features | Done | `src/audio/reccobeats.ts`, `src/audio/backfill.ts` |
| M17 | Acoustic preference profile | Done | `src/audio/profile.ts` |
| M18 | Last.fm discovery | Done | `src/discovery/lastfm.ts`, `src/discovery/similar.ts` |
| M19 | Expanded external sources | Done | `src/discovery/rss_extras.ts` (Gorilla vs Bear, Hype Machine, Aquarium Drunkard) |
| M20 | Acoustic-aware curation | Done | `src/audio/fit.ts`, `src/curation/agent.ts` |

---

## 6. API endpoints (complete list)

### Public API

| Path | Method | Description |
|------|--------|-------------|
| `/` | GET | Health check |
| `/auth/login` | GET | Start Spotify OAuth flow |
| `/auth/callback` | GET | OAuth callback |
| `/me` | GET | Verify auth, returns Spotify profile |
| `/api/now-playing` | GET | Current playback + next 3 queued tracks + play context |
| `/api/start-session` | POST | Start a curation session: `{mode, output, duration_min, context}` |
| `/api/session-explain` | GET | Why each track was picked (taste, context, acoustic fit) |
| `/api/dashboard-stats` | GET | 4-quadrant stats: today's listening, agent, discovery, taste model |
| `/api/top-affinities` | GET | Tracks with strongest learned context affinities |
| `/api/like-track` | POST | Add track to "Liked via Agent" playlist: `{track_id}` |
| `/api/block-track` | POST | Add track to "Blocked" playlist (excluded from future sessions): `{track_id}` |
| `/api/queue-track` | POST | Queue a track on active device: `{track_id}` |
| `/api/recent-history` | GET | Last 24 hours: track, artist, source, classification, taste score |

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
| `/debug/exclude-playlist` | Toggle include_in_taste_model flag |
| `/debug/excluded-playlists` | List excluded seasonal playlists |
| `/debug/run-discovery?day=N` | Manually trigger discovery (optional day override) |
| `/debug/discovery-sources` | Test discovery source availability |
| `/debug/discovery-by-source` | Fresh pool counts grouped by source |
| `/debug/fresh-pool?limit=N` | Top fresh pool entries with artist names |
| `/debug/fresh-pool-stats` | Fresh pool status counts |
| `/debug/last-snapshot` | Latest context snapshot |
| `/debug/session-biases` | Context biases for last session |
| `/debug/run-feedback` | Manually trigger feedback processing |
| `/debug/send-summary` | Manually trigger nightly email |
| `/debug/rebuild-affinities` | Manually trigger affinity rebuild |
| `/debug/track-affinities?track_id=X` | View affinities for a specific track |
| `/debug/all-playlists` | List all user playlists |
| `/debug/playlist-tracks?id=X&limit=N` | Full track listing via embed scraping |
| `/debug/audio-features?track_id=X` | Audio features (fetches from ReccoBeats if missing) |
| `/debug/audio-features-stats` | Coverage: with features, not found, missing |
| `/debug/audio-features-not-found` | Tracks missing from ReccoBeats with taste scores |
| `/debug/audio-features-table?limit=N` | Sortable HTML table of features for eyeball validation |
| `/debug/run-audio-backfill?count=N` | Trigger N backfill batches (max 10) |
| `/debug/acoustic-profile?mode=X` | Per-mode centroids with trained/insufficient status |
| `/debug/rebuild-acoustic-profile` | Manually trigger centroid rebuild |
| `/debug/lastfm-similar?artist=X` | Similar artists with cache hit/miss |

---

## 7. Key algorithms

### Taste scoring (`src/taste/model.ts`, `src/taste/score.ts`)

Track taste score = weighted sum of:
- In liked songs (+3)
- Top tracks short-term (+5), medium-term (+3), long-term (+2)
- Seasonal playlist count (+1.5 each, +3 if current season)
- Play count (log-scaled)
- Complete count bonus (+0.3), skip penalty (-1.5), replay bonus (+2)
- Recency bonus for recently played (decays over 30 days)
- Primary artist taste score boost

**Skip detection:** <50% progress = skipped, 50-80% = partial, ≥80% = completed. Quick skips caught via recently-played API backfill (runs every poll cycle).

**Replay detection:** Same track, progress jumps backward by >5s = replayed. Strongest positive behavioral signal (+2 per replay).

### Freshness arc (`src/curation/arc.ts`)

Controls the familiar vs. fresh mix at each position in a session:
- Start: 100% familiar (anchor with known tracks)
- Middle: gradually increase fresh ratio
- 75%: peak exploration (50/50)
- End: return to familiar (close on a known favorite)

The arc is scaled by the mode's `freshMultiplier`. Discover mode bypasses the arc entirely (100% fresh).

### Acoustic fit (`src/audio/fit.ts`)

Per-track multiplier based on how well a track's audio features match the mode's acoustic centroid:
- Distance = Mahalanobis-like across 9 dimensions (acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence)
- Normalized to 18 (9 × 1.4²), clamped to [0.7, 1.4]
- Track at centroid → 1.4x boost; track 1.4σ out on all dimensions → 0.7x penalty
- Tracks without audio features default to 1.0 (neutral)
- Modes with <10 sample events fall back to 'overall' centroid

### Context scoring (`src/curation/context_score.ts`, `src/context/rules.ts`)

Two layers:
1. **Cold-start rules** — 10 hand-coded biases (night+unwinding=comfort, rain=comfort, car BT=driving energy, etc.). Each is a multiplier in [0.5, 2.0].
2. **Learned affinities** — nightly cron computes `P(track|context) / P(context)` from play history. When `sample_size >= 5`, the learned value replaces the cold-start rule.

Product of all applicable multipliers is clamped to [0.5, 2.0].

### Final track score (curation agent)

```
final_score = taste_score × context_multiplier × acoustic_fit
```

### Discovery scoring (`src/discovery/agent.ts`)

Candidates scored by:
- Primary artist taste score (60% weight)
- Collaborator artist scores (20% weight each)
- Seasonal artist bonus (+2)
- Followed artist source bonus (+1.5)

30% of pool slots reserved for editorial sources (Last.fm, Hype Machine, RSS feeds) to ensure novel discoveries aren't crowded out by taste-model-adjacent artist-search candidates.

---

## 8. Session modes

7 modes, each with default time window, duration, output, and fresh multiplier:

| Mode | Hours (ET) | Duration | Output | Fresh | Description |
|------|-----------|----------|--------|-------|-------------|
| waking_up | 6–10am | 30 min | play_now | Low | Gentle start, current season playlist |
| working | 9am–6pm wkdays | 90 min | play_now | Medium | Sustained focus, familiar-heavy |
| driving | Any | 45 min | play_now | Very low | Energy, sing-along anchors |
| brainstorming | Any | 60 min | queue | High | Novelty helps; 50/50 familiar/fresh |
| unwinding | 7–11pm | 60 min | play_now | Low-medium | Comfort, low-skip tracks |
| sleeping | 11pm+ | 45 min | playlist | Very low | Calm and known |
| **discover** | **Any** | **45 min** | **queue** | **100%** | **All fresh — dedicated new music exploration** |

Device preference: Smartphone > Computer > Tablet when no device is actively playing.

---

## 9. Dashboard sections (`dashboard/index.html`)

1. **Now Playing** — Live playback with dot animation, track/artist, progress, device. Like/block buttons. Shows play context (agent session vs manual). Up Next: next 3 queued tracks.
2. **Start Session** — 7 mode buttons (Discover has green border) + output selector (play_now/queue)
3. **Why These Tracks** — Per-track explanation: taste reasons, context biases, acoustic fit (dimension + multiplier)
4. **Latest Context** — Captured timestamp, daylight, weather, location, device, wind, cloud
5. **Session Biases Applied** — Context biases active in the last session
6. **Learned Affinities** — Tracks with strongest learned affinities grouped by context bucket
7. **Fresh Pool** — Top 15 discovery candidates with artist name, source origin, score, queue button
8. **Stats** — 4 quadrants: Today's Listening (tracks/time/skip rate), Agent Performance (sessions/accept rate), Discovery (pool/plays/accept rate), Taste Model (tracks scored/seasonal PLs/last rebuild)
9. **Last 24 Hours** — Play history with artist, source badge (Agent/Playlist/Direct·Device), classification, taste score, like/block

---

## 10. iOS Shortcuts

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

## 11. Nightly email (`src/email/summary.ts`)

Sent at 8pm ET via Resend. Light theme for mobile readability. Contains:
- Top tracks of the day with play counts
- Total plays, completed, skipped
- Skip rate
- Fresh discovery stats
- Device breakdown

---

## 12. Known issues and limitations

1. **Spotify Dev Mode is permanent** — all playlist-track reads go through embed scraping, which does not provide `added_at` timestamps, album data, or structured artist IDs.
2. **Embed scraping depends on Spotify's page structure** — if `__NEXT_DATA__` rendering changes, scraping breaks with loud parse errors.
3. **Feb 2026 playlist field rename** — tolerant `items?.total ?? tracks?.total` fix in place. Rollout to grandfathered apps postponed; cleanup deferred until Spotify confirms cutoff.
4. **Seasonal playlist detection** — ownership edge case handled via `EXCLUDE_PLAYLIST_IDS` in seasonal.ts. Undated playlists preserve DB years (never re-inferred).
5. **Audio features coverage** — ~47% of taste model tracks have ReccoBeats features. ~17% not found in ReccoBeats (rescanned after 30 days). 36% not yet attempted (backfilling at 40/day).
6. **Acoustic profile data volume** — working (44 events) and unwinding (32) are trained. Sleeping (12) is thin. Waking_up (6), driving, brainstorming have no time-inferred events (session-only). All fall back to 'overall' (94 events).
7. **RSS title parsing is regex-based** — fails safely (unparseable items skipped).
8. **ReccoBeats undocumented 40-ID batch limit** — handled by automatic chunking in `src/audio/reccobeats.ts`.

---

## 13. Credentials and URLs

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

## 14. Commit history (recent)

```
82e1be9 Add Discover mode: 100% fresh tracks from the discovery pool
67ca8ee Fresh pool: show artist below track name, source as discovery origin
f538546 Fix dashboard session start error on non-JSON responses
fc7a7e0 M20: Acoustic fit in session-explain and dashboard
8d8b487 M20: Integrate acoustic fit into taste rebuild and curation
45366b4 M20: Acoustic fit module, migration, and config
0101534 Reserve 30% of fresh pool for editorial discovery sources
b683d55 M19: Tiered discovery with Aquarium Drunkard, paid tier limits
c01987f M18: Last.fm similar-artist discovery integration
fcadd8c M18: Add lastfm_similar_cache table, ISRC and genre notes
25aa2ab Correct sleeping window to [23,6] based on user behavior
1980a6a M17: Acoustic profile builder, centroid windows, debug endpoints
cde7eb6 M17: Add acoustic_profile table
d8e4cbe M16: Debug endpoints for audio features
085c11d M16: ReccoBeats client, backfill cron, and audio features pipeline
1fa6e79 M16: Add track_audio_features table
b6f270f Remove dead code referencing removed/renamed Spotify endpoints
e449fe0 Tolerant fix for playlist field rename (tracks → items)
f588177 Backfill quick skips from Spotify recently-played API
cf1249a Add replay bonus to taste scoring
51ba439 Fix skip detection: remove impossible 30s time threshold
1f6bcd6 Redesign stats: today's listening, agent, discovery, taste model
9868c81 Now Playing: show next 3 tracks in queue
c33c678 History: store artist names at poll time, show device for direct plays
95665d3 Last 24 Hours: add artist name and play source column
c9024a8 Fix year inference overwriting correct years for undated playlists
cdde6e8 Prefer phone over soundbar when no device is actively playing
2718a18 Fix three features silently broken by Spotify Dev Mode
9986bd5 Add /debug/playlist-tracks for taste archaeology
```

---

## 15. Future ideas (not planned, just bookmarked)

From plan documents and session conversations:
- Tune acoustic_fit clamp [0.7, 1.4] after 2+ weeks of M20 sessions
- Extend audio features backfill to fresh_pool candidates (paid tier makes this feasible)
- Persist artist genres in artist_taste to unlock Last.fm tag.getTopTracks discovery
- ISRC-based dedup (confirmed available in Dev Mode search results)
- Weekly/monthly "personal Wrapped" email with context breakdowns
- Genre-based search discovery
- HomeKit / Home Assistant integration for richer at-home context
- Apple Watch / HealthKit for workout heart-rate signals
- Aquarium Drunkard album-as-seed discovery (different candidate pattern)
- Car Bluetooth auto-trigger automation (user prefers manual control)
