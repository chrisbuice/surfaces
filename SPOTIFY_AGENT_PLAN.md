# Personal Spotify Curation Agent — Project Plan

A planning document for a personal music curation system that learns from listening habits, integrates with Spotify, and surfaces both familiar favorites and fresh discoveries based on context.

**Audience:** This document is for Claude Code (or another coding assistant). The end user is a non-developer who has used Claude Code before and needs hand-holding. Be explicit about every step. Show commands. Explain what files do. When in doubt, ask before doing something destructive.

---

## 1. What we're building, in plain English

A personal service that:

1. **Always-on listening tracker** — quietly logs what the user actually listens to on Spotify (not just what's saved), including skips, replays, and time-of-day patterns.
2. **Discovery agent** — runs on a schedule, scouts new music from Spotify's editorial channels and external sources (NPR Music to start), scores candidates against the user's taste, and holds vetted candidates in a "fresh pool."
3. **Curation agent** — invoked by the user (via Claude chat, iOS shortcut, or a web dashboard) with a mode like "working" or "driving." Builds a session: starts with familiar hits, drifts toward fresh tracks across the session. Biases selection by **physical context** (weather, location, daylight, calendar, device, motion) when available.
4. **Playback controller** — plays immediately, queues, or saves the session as a Spotify playlist.
5. **In-session feedback** — watches what happens during a curated session and adjusts on the fly (skipped songs become negative signal; replayed songs become positive).
6. **Web dashboard** — a small page showing what's playing, what's in the fresh pool, listening stats, and controls. Behind Cloudflare Access auth.

---

## 2. Critical context: Spotify API restrictions (Nov 2024)

**Spotify deprecated several endpoints in late 2024.** This shapes our design. Do not write code that depends on the deprecated endpoints listed below — they will return 403.

### Deprecated (do not use):
- `GET /audio-features` — track tempo, energy, valence, danceability, acousticness, etc.
- `GET /audio-analysis` — deeper acoustic structure
- `GET /recommendations` — seed-based "give me similar songs"
- Related Artists endpoint
- Algorithmic playlist endpoints (Discover Weekly, Daily Mixes, etc., as API targets)

### Still works (this is what we use):
- `GET /me/top/tracks` and `GET /me/top/artists` (short/medium/long term)
- `GET /me/tracks` (saved/liked songs)
- `GET /me/playlists`, `GET /playlists/{id}/tracks`
- `GET /me/player/recently-played`
- `GET /me/player`, `GET /me/player/currently-playing` (the listening tracker)
- `PUT /me/player/play`, `POST /me/player/queue`, `POST /me/player/next`, etc. (playback control)
- `GET /me/following` (followed artists)
- `GET /artists/{id}/albums` (for new releases from followed artists)
- `GET /browse/new-releases`
- `GET /browse/featured-playlists`
- `GET /search`
- Playlist creation/modification endpoints

### Implications for our design:
- We **cannot** match tracks to a mode using Spotify's audio features. Instead, we infer mode-fit from **user behavior**: which tracks the user actually plays during which hours/contexts, which playlists they pull from, and which editorial playlists they engage with.
- We **cannot** use Spotify's recommendation engine. Instead, we build our own simple recommender from: followed artists' new releases, editorial playlists (New Music Friday, etc.), NPR Music feeds, and artist co-occurrence in user playlists.
- If audio features become genuinely necessary later, **ReccoBeats** (free) and **SoundNet Track Analysis** (paid, via RapidAPI) are drop-in replacements. Do not integrate them in v1.

---

## 3. Tech stack

All Cloudflare. The user has a Cloudflare account and is comfortable with that ecosystem.

| Concern | Choice | Why |
|---|---|---|
| Compute | **Cloudflare Workers** | Free tier, always-on, no servers to maintain. |
| Scheduled jobs | **Cloudflare Cron Triggers** | For the listening poll loop and the discovery agent. |
| Database | **Cloudflare D1** (SQLite) | Free tier generous; SQLite is plenty for one user. |
| Token / hot data | **Cloudflare KV** | OAuth refresh tokens, last-poll cursor, small state. |
| Dashboard hosting | **Cloudflare Pages** | Static site, free. |
| Auth on dashboard | **Cloudflare Access** | Free for our scale; ties to user's Google/GitHub login. |
| Language | **TypeScript** | Native to Workers; modern tooling; what `wrangler` expects. |
| Deployment CLI | **Wrangler** | Cloudflare's official CLI. |
| External music data (v1) | **Spotify Web API only** | NPR Music integration in v2. |
| MCP server | **Workers** with HTTP MCP transport | So Claude (chat) can invoke the curation agent. |

### Constraint to keep in mind: Cron minimum is 1 minute
Cloudflare Cron Triggers run at most once per minute. For listening tracking this means we poll Spotify every 60 seconds, not every 30. We compensate by using Spotify's `progress_ms` and `is_playing` fields to reason about skips ("if a track that was at 0:15 last poll is now a different track, we know the previous track was skipped"). Good enough for our needs.

---

## 4. Repository structure

```
spotify-agent/
├── README.md                       # how to install, deploy, and use
├── SETUP.md                        # one-time setup steps for the user
├── package.json
├── tsconfig.json
├── wrangler.toml                   # Cloudflare config (workers, crons, D1, KV bindings)
├── .dev.vars.example               # template for local secrets
├── .gitignore
│
├── src/
│   ├── index.ts                    # Worker entrypoint: HTTP routing + scheduled handler
│   ├── config.ts                   # mode definitions, tunable constants
│   │
│   ├── auth/
│   │   ├── spotify-oauth.ts        # OAuth login, callback, token refresh
│   │   └── tokens.ts               # KV-backed token storage
│   │
│   ├── spotify/
│   │   ├── client.ts               # thin wrapper around fetch with auth + retry
│   │   ├── library.ts              # playlists, saved tracks, top tracks/artists
│   │   ├── playback.ts             # play, queue, current state, devices
│   │   └── browse.ts               # new releases, featured playlists, followed artists
│   │
│   ├── tracker/
│   │   ├── poll.ts                 # cron handler: fetch currently-playing, log to D1
│   │   └── derive.ts               # turn raw events into play/skip/repeat records
│   │
│   ├── taste/
│   │   ├── model.ts                # build/refresh the taste model from D1
│   │   ├── seasonal.ts             # seasonal playlist parsing and weighting
│   │   └── score.ts                # score a track against the model
│   │
│   ├── discovery/
│   │   ├── agent.ts                # cron handler: scout new candidates, score, store
│   │   ├── sources.ts              # spotify new releases, editorial, followed artists
│   │   └── pool.ts                 # fresh pool management (add, expire, mark-used)
│   │
│   ├── context/
│   │   ├── capture.ts              # build a context_snapshot from inputs + APIs
│   │   ├── weather.ts              # Open-Meteo client; daylight phase calc
│   │   ├── calendar.ts             # iCal fetcher + event categorization
│   │   ├── rules.ts                # cold-start rule biases
│   │   └── affinity.ts             # learned track_context_affinity refresh job
│   │
│   ├── curation/
│   │   ├── agent.ts                # main entrypoint: build a session for a mode
│   │   ├── modes.ts                # mode logic, defaults, time-of-day inference
│   │   ├── arc.ts                  # position-based fresh/familiar curve
│   │   ├── context_score.ts        # blend rule + learned context multipliers
│   │   └── feedback.ts             # in-session adjustments
│   │
│   ├── api/
│   │   ├── routes.ts               # HTTP routes for dashboard + iOS shortcut + MCP
│   │   ├── mcp.ts                  # MCP server endpoint
│   │   └── shortcuts.ts            # simplified endpoints for iOS shortcuts
│   │
│   └── db/
│       ├── schema.sql              # D1 schema (also embedded as migration)
│       ├── migrations/             # numbered SQL migrations
│       └── queries.ts              # typed query helpers
│
├── dashboard/                      # Cloudflare Pages site
│   ├── package.json
│   ├── index.html
│   └── src/
│       ├── main.ts                 # vanilla TS or small framework
│       └── components/...
│
└── scripts/
    ├── seed-taste-model.ts         # one-time backfill from existing playlists
    └── inspect-db.ts               # local helper for poking at D1
```

### Why this layout
- Each "agent" (tracker, discovery, curation) is its own folder with a clear entrypoint. The curation `agent.ts` is the brain that the user invokes; the others run on cron.
- `spotify/` is a reusable client layer. Don't put business logic in there.
- `db/queries.ts` is the only place SQL lives in TypeScript code. Keep raw SQL out of business logic.
- The dashboard is a separate package because it deploys to Pages, not Workers.

---

## 5. Database schema (D1)

This is the source of truth for state. Iterate carefully — D1 migrations are forward-only.

```sql
-- =========================================================
-- USER & AUTH (single-user app, but model it cleanly anyway)
-- =========================================================
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  spotify_user_id TEXT UNIQUE NOT NULL,
  display_name TEXT,
  created_at INTEGER NOT NULL  -- unix seconds
);

-- =========================================================
-- LISTENING HISTORY
-- raw poll observations and derived play events
-- =========================================================

-- Every successful poll writes one row. Most rows are boring
-- ("still playing the same track") and can be pruned after derivation.
CREATE TABLE poll_observations (
  id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,         -- unix seconds
  is_playing INTEGER NOT NULL,          -- 0/1
  track_id TEXT,                        -- spotify track id, null if nothing playing
  track_name TEXT,
  artist_ids TEXT,                      -- JSON array of artist ids
  album_id TEXT,
  progress_ms INTEGER,
  duration_ms INTEGER,
  device_type TEXT,                     -- 'Computer' / 'Smartphone' / 'Speaker' / etc.
  context_uri TEXT,                     -- playlist/album/artist context if any
  context_type TEXT                     -- 'playlist' / 'album' / 'artist' / null
);
CREATE INDEX idx_poll_observed_at ON poll_observations(observed_at);
CREATE INDEX idx_poll_track ON poll_observations(track_id);

-- Derived from poll_observations: one row per "the user listened to track X"
-- with skip / complete / partial classification.
CREATE TABLE play_events (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  duration_listened_ms INTEGER NOT NULL,
  track_duration_ms INTEGER,
  classification TEXT NOT NULL,         -- 'completed' | 'skipped' | 'partial' | 'replayed'
  context_uri TEXT,
  context_type TEXT,
  device_type TEXT,
  hour_of_day INTEGER,                  -- 0-23, local time
  day_of_week INTEGER,                  -- 0-6, 0=Sunday
  session_id TEXT                       -- groups events into listening sessions
);
CREATE INDEX idx_play_events_track ON play_events(track_id);
CREATE INDEX idx_play_events_started ON play_events(started_at);
CREATE INDEX idx_play_events_hour ON play_events(hour_of_day);

-- =========================================================
-- TASTE MODEL — cached, rebuilt periodically
-- =========================================================

-- Aggregated stats per track
CREATE TABLE track_taste (
  track_id TEXT PRIMARY KEY,
  track_name TEXT NOT NULL,
  artist_ids TEXT NOT NULL,             -- JSON
  primary_artist_id TEXT NOT NULL,
  album_id TEXT,
  in_liked_songs INTEGER DEFAULT 0,     -- 0/1
  in_top_tracks_short INTEGER DEFAULT 0,
  in_top_tracks_medium INTEGER DEFAULT 0,
  in_top_tracks_long INTEGER DEFAULT 0,
  seasonal_playlist_count INTEGER DEFAULT 0,  -- across all seasons
  current_season_present INTEGER DEFAULT 0,   -- 0/1
  play_count INTEGER DEFAULT 0,
  skip_count INTEGER DEFAULT 0,
  complete_count INTEGER DEFAULT 0,
  last_played_at INTEGER,
  taste_score REAL,                     -- computed; see taste/score.ts
  refreshed_at INTEGER NOT NULL
);
CREATE INDEX idx_track_taste_score ON track_taste(taste_score DESC);
CREATE INDEX idx_track_taste_artist ON track_taste(primary_artist_id);

-- Per-artist taste signal
CREATE TABLE artist_taste (
  artist_id TEXT PRIMARY KEY,
  artist_name TEXT NOT NULL,
  in_top_artists_short INTEGER DEFAULT 0,
  in_top_artists_medium INTEGER DEFAULT 0,
  in_top_artists_long INTEGER DEFAULT 0,
  is_followed INTEGER DEFAULT 0,
  total_plays INTEGER DEFAULT 0,
  unique_tracks_played INTEGER DEFAULT 0,
  taste_score REAL,
  refreshed_at INTEGER NOT NULL
);

-- Mode profiles, derived from listening behavior
-- Each mode is a soft definition: which tracks/artists/contexts
-- the user tends to play during this mode.
CREATE TABLE mode_profiles (
  mode TEXT PRIMARY KEY,                -- 'waking_up' | 'working' | 'driving' | 'brainstorming' | 'unwinding' | 'sleeping'
  hour_distribution TEXT NOT NULL,      -- JSON: {"0": 0.01, "1": 0.0, ...} probability mass per hour
  top_artists TEXT,                     -- JSON: [{artist_id, weight}, ...]
  top_tracks TEXT,                      -- JSON: [{track_id, weight}, ...]
  top_playlists TEXT,                   -- JSON: [{playlist_id, weight}, ...]
  refreshed_at INTEGER NOT NULL
);

-- =========================================================
-- SEASONAL PLAYLISTS — the user's manually curated taste signal
-- =========================================================
CREATE TABLE seasonal_playlists (
  id INTEGER PRIMARY KEY,
  spotify_playlist_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  season TEXT NOT NULL,                 -- 'winter' | 'spring' | 'summer' | 'fall'
  year INTEGER NOT NULL,
  is_current INTEGER DEFAULT 0,         -- 0/1, recomputed on schedule
  last_synced_at INTEGER
);
CREATE INDEX idx_seasonal_year ON seasonal_playlists(year DESC);

-- =========================================================
-- PHYSICAL CONTEXT
-- snapshots captured at session-start and (later) periodically,
-- plus per-track context affinities derived from history
-- =========================================================

-- One row per context capture. A snapshot is taken whenever a session
-- starts, and (optional v2) hourly via cron for ambient observation.
CREATE TABLE context_snapshots (
  id INTEGER PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  trigger TEXT NOT NULL,                -- 'session_start' | 'hourly_cron' | 'manual'
  -- Time / daylight
  local_hour INTEGER NOT NULL,
  local_minute INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL,         -- 0-6, 0=Sunday
  daylight_phase TEXT NOT NULL,         -- 'pre_dawn' | 'morning' | 'midday' | 'golden_hour' | 'dusk' | 'night'
  sunrise_at INTEGER,                   -- unix seconds, today
  sunset_at INTEGER,
  -- Weather (Open-Meteo)
  weather_temp_f REAL,
  weather_condition TEXT,               -- 'clear' | 'partly_cloudy' | 'overcast' | 'rain' | 'snow' | 'thunderstorm' | 'fog'
  weather_precipitation_mm REAL,
  weather_wind_mph REAL,
  weather_cloud_pct INTEGER,
  -- Location (best-effort, from shortcut payload or default home)
  location_label TEXT,                  -- 'home' | 'work' | 'gym' | 'in_transit' | freeform
  location_lat REAL,
  location_lon REAL,
  location_source TEXT,                 -- 'shortcut' | 'default_home' | 'inferred_device' | 'unknown'
  -- Spotify device / activity hints
  device_type TEXT,                     -- mirrors poll_observations.device_type at capture time
  is_in_motion INTEGER,                 -- 0/1, from shortcut if available
  bluetooth_context TEXT,               -- 'car' | 'headphones' | 'speaker' | null, from shortcut
  -- Calendar (if connected)
  calendar_event_title TEXT,
  calendar_event_category TEXT,         -- inferred: 'focus' | 'meeting' | 'workout' | 'meal' | 'travel' | 'social' | null
  calendar_event_ends_at INTEGER,
  -- Free-text user note ("about to cook dinner")
  user_note TEXT
);
CREATE INDEX idx_context_captured_at ON context_snapshots(captured_at);

-- Link each play_event to the context that was active when it started.
-- This is what lets us learn "this track gets played in the rain."
CREATE TABLE play_event_context (
  play_event_id INTEGER PRIMARY KEY,
  context_snapshot_id INTEGER NOT NULL,
  FOREIGN KEY(play_event_id) REFERENCES play_events(id),
  FOREIGN KEY(context_snapshot_id) REFERENCES context_snapshots(id)
);

-- Per-track affinity for various context dimensions, refreshed on a schedule.
-- Score is roughly: P(track played | context) / P(track played overall),
-- clamped and smoothed. >1 means "more likely in this context", <1 means less.
CREATE TABLE track_context_affinity (
  track_id TEXT NOT NULL,
  dimension TEXT NOT NULL,              -- 'daylight_phase' | 'weather_condition' | 'location_label' | 'device_type' | 'day_of_week' | 'calendar_category'
  bucket TEXT NOT NULL,                 -- e.g. 'night', 'rain', 'home', 'Smartphone', 'Saturday', 'focus'
  affinity REAL NOT NULL,               -- multiplier, default 1.0
  sample_size INTEGER NOT NULL,         -- # of plays this is based on; small samples get pulled toward 1.0
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY(track_id, dimension, bucket)
);
CREATE INDEX idx_track_context_track ON track_context_affinity(track_id);

-- Default home location and time zone, plus enabled context features.
-- Single row, id=1.
CREATE TABLE settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  home_lat REAL,
  home_lon REAL,
  home_label TEXT DEFAULT 'home',
  time_zone TEXT NOT NULL,              -- IANA, e.g. 'America/New_York'
  weather_enabled INTEGER DEFAULT 1,
  calendar_enabled INTEGER DEFAULT 0,
  calendar_ical_url TEXT,
  shortcut_token_hash TEXT
);

-- =========================================================
-- DISCOVERY / FRESH POOL
-- =========================================================

-- Candidates the discovery agent has found and scored
CREATE TABLE fresh_pool (
  id INTEGER PRIMARY KEY,
  track_id TEXT NOT NULL,
  track_name TEXT NOT NULL,
  artist_ids TEXT NOT NULL,
  primary_artist_id TEXT NOT NULL,
  source TEXT NOT NULL,                 -- 'spotify_new_releases' | 'spotify_editorial:<playlist_id>' | 'followed_artist_release' | 'npr_music' (v2)
  source_detail TEXT,                   -- e.g. specific editorial playlist name
  found_at INTEGER NOT NULL,
  taste_score REAL NOT NULL,            -- predicted-fit score
  status TEXT NOT NULL DEFAULT 'fresh', -- 'fresh' | 'queued' | 'played' | 'liked' | 'skipped' | 'expired'
  status_changed_at INTEGER,
  expires_at INTEGER,                   -- after this, considered stale
  UNIQUE(track_id)
);
CREATE INDEX idx_fresh_status ON fresh_pool(status);
CREATE INDEX idx_fresh_score ON fresh_pool(taste_score DESC);

-- =========================================================
-- SESSIONS — what the curation agent built and how it went
-- =========================================================
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  session_id TEXT UNIQUE NOT NULL,      -- uuid; matches play_events.session_id
  mode TEXT NOT NULL,
  invoked_at INTEGER NOT NULL,
  invoked_via TEXT NOT NULL,            -- 'mcp' | 'shortcut' | 'dashboard'
  fresh_ratio_target REAL,
  duration_target_min INTEGER,
  output TEXT NOT NULL,                 -- 'play_now' | 'queue' | 'playlist'
  spotify_playlist_id TEXT,             -- if output=playlist
  ended_at INTEGER
);

CREATE TABLE session_tracks (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  track_id TEXT NOT NULL,
  source TEXT NOT NULL,                 -- 'familiar' | 'fresh:<source>'
  was_swapped INTEGER DEFAULT 0,        -- did feedback replace this track later?
  outcome TEXT,                         -- filled in post-hoc: 'completed' | 'skipped' | etc.
  FOREIGN KEY(session_id) REFERENCES sessions(session_id)
);
CREATE INDEX idx_session_tracks_session ON session_tracks(session_id);
```

### Notes for Claude Code
- Keep the schema in `src/db/schema.sql` and apply it via `wrangler d1 execute`. Use migration files for any later changes.
- `poll_observations` will grow fast (every 60s). Add a cleanup cron that prunes observations older than 30 days, keeping only the derived `play_events`.
- All timestamps are unix seconds (integer) for D1-friendliness. Convert to/from JS `Date` at the boundary.

---

## 6. Mode definitions

Six modes, defined by **behavioral inference + small overrides**, not by Spotify audio features (which we no longer have).

| Mode | Default time window | Initial seed | Fresh arc | Notes |
|---|---|---|---|---|
| `waking_up` | 6–10am | Recently played in this window + current season playlist | Low fresh ratio (start gentle) | Default 30 min session. Default output: `play_now`. |
| `working` | 9am–6pm weekdays | Top tracks medium-term ∩ instrumental-heavy playlists user has played during work hours | Position-based: 90% familiar → 60% familiar | Long sessions (90+ min). Default output: `play_now`. |
| `driving` | Any | Top tracks short-term + sing-along anchors (high replay rate) | High familiar throughout, occasional fresh | Energy stays steady. Default output: `play_now`. |
| `brainstorming` | Any | Top artists long-term + tracks the user has played repeatedly during brainstorm-coded hours | Higher fresh ratio (50/50) — novelty helps | Default 60 min. Default output: `queue`. |
| `unwinding` | 7–11pm | Tracks played late-evening across history; current season picks with low play counts | Low-medium fresh | 45-90 min. Default output: `play_now`. |
| `sleeping` | 9pm+ | Tracks played in last hour of sessions; tracks tagged via repeat late-night plays | Very low fresh (calm and known is the goal) | Output: `playlist` (so it doesn't autoplay something jarring). |

### How time-of-day inference works
When the user invokes the curation agent without specifying a mode, look up the current hour in each mode's `hour_distribution` (computed from historical `play_events`). Pick the mode with the highest probability mass at that hour, with a small bias toward continuity (if the user invoked a mode in the last 4 hours, prefer that one).

### How modes get populated
On first run, modes are empty profiles. The taste model job (cron, daily) rebuilds `mode_profiles` from `play_events`:
- `hour_distribution`: histogram of play events per mode-time-window, normalized.
- `top_artists` / `top_tracks` / `top_playlists`: most-played and least-skipped during that mode's typical hours.
- For modes that don't naturally fall in a time window (`driving`, `brainstorming`), seed initially from the user's top tracks across all time and let manual mode invocations refine the data.

---

## 7. Physical context — bridging the virtual/physical gap

Mode tells us *what the user is doing*. Physical context tells us *what the world around the user is like*. Both feed the curation agent as **soft biases** (multipliers on track scores), never hard filters.

### Design principles

1. **Soft biases only.** Context never excludes tracks; it only nudges scores. A wrong context guess should produce a slightly-off session, not a broken one.
2. **All context is optional.** Every signal can be missing. The system degrades gracefully: no weather data → just don't apply a weather bias.
3. **Capture once per session, not continuously.** A `context_snapshot` is taken when a session starts. (v2 may add hourly ambient capture for better learning.)
4. **Learn affinities from the user's own behavior.** We don't need to know what music *should* fit a rainy night — we observe what the user actually plays on rainy nights and amplify those patterns. This is why `track_context_affinity` exists.
5. **Cold start with simple rules; let learning take over as data accumulates.** First few weeks, contextual biases come from a small set of hand-coded rules. After ~1000 play events with linked context, learned affinities take precedence.
6. **Privacy stays local.** Location and calendar data live only in your D1. Never logged, never sent anywhere except the third-party APIs they require (Open-Meteo for weather; iCal source for calendar).

### Signals captured per snapshot

| Signal | Source | Notes |
|---|---|---|
| Local hour, minute, day-of-week | Worker + user's TZ from `settings` | Always available. |
| Daylight phase | Computed from sunrise/sunset for location/date | `pre_dawn` / `morning` / `midday` / `golden_hour` / `dusk` / `night`. Better than raw clock for "unwinding." |
| Weather: condition, temp, precipitation, wind, cloud cover | **Open-Meteo** (free, no key) | Single request per snapshot. Cached briefly to avoid hammering. |
| Location label | iOS Shortcut payload OR default home | Shortcut can pass GPS + a label like "home"/"work"/"car"/"gym". If unset, assume home. |
| Lat/lon | Shortcut OR settings.home | Used to look up weather and sunrise/sunset. |
| Device type | Spotify currently-playing | `Computer` / `Smartphone` / `Speaker` / `TV` — strong implicit context. |
| Motion / Bluetooth | iOS Shortcut payload | "Connected to car Bluetooth" → driving signal. "AirPods" → mobile/personal. |
| Calendar event | Optional iCal feed | Title + inferred category (`focus` / `meeting` / `workout` / `meal` / `travel` / `social`). Big signal when present. |
| User note | Optional free-text from shortcut or chat | "About to cook dinner" — overrides inference. |

### How signals reach the Worker

- **Weather, sunrise/sunset, daylight phase:** the Worker fetches Open-Meteo at session-start using `settings.home_lat/lon` (or a more current lat/lon if the shortcut provided one). One API call. No key required.
- **Device type:** already coming in via the listening tracker; we read the most recent `poll_observations` row.
- **Location, motion, Bluetooth:** the iOS Shortcut sends these in the request body when invoking the curation agent. Build the shortcut to pass:
  ```json
  {
    "mode": "driving",
    "context": {
      "location_label": "car",
      "location_lat": 33.78,
      "location_lon": -84.39,
      "is_in_motion": 1,
      "bluetooth_context": "car",
      "user_note": null
    }
  }
  ```
  All fields optional. The dashboard sends `{}` (location defaults to home). Claude chat can include a note ("I'm winding down with a book").
- **Calendar:** the user pastes an iCal URL into settings (e.g., a private Google Calendar share link). A small helper fetches the current event when a snapshot is captured.

### How context affects curation

At session-start, after building the candidate track pool, apply context biases:

```
final_score(track) = taste_score(track) × mode_weight × Π(context_multipliers)
```

Each context multiplier is the product of:
- **Cold-start rule biases** (hand-coded, conservative; e.g., `weather=rain` → `multiplier *= 1.05` for tracks the user has tagged as rainy via behavior or shows naturally on rainy days).
- **Learned affinity biases** from `track_context_affinity`, weighted by sample size (small samples pulled toward 1.0).

Multipliers are clamped to a sensible range (e.g., 0.5 to 2.0) so context can't completely override taste.

### Cold-start rules (initial defaults)

These ship hard-coded in `src/curation/context_rules.ts` and serve until learned affinities accumulate:

| Context | Bias |
|---|---|
| `daylight_phase=night` + mode in (`unwinding`, `sleeping`) | favor tracks the user has played after 8pm (any mode); slightly de-emphasize tracks the user has only played during work hours |
| `daylight_phase=pre_dawn` or `morning` + mode=`waking_up` | favor tracks recently added to current-season playlist; lean toward shorter durations |
| `weather_condition=rain` or `overcast` | small bump (×1.1) for tracks frequently played on rainy days historically (or, cold-start: tracks with skip rate <10% — comfort weighting) |
| `weather_temp_f > 80` and `daylight_phase=midday` | small bump for current-season-summer playlist tracks; slight drop for very mellow tracks |
| `weather_temp_f < 35` | small bump for tracks from winter seasonal playlists |
| `device_type=Speaker` (and not in driving mode) | favor album-coherent picks (multiple tracks from same album) — speaker context suggests background listening |
| `device_type=Smartphone` + `is_in_motion=1` | strong driving-context bias regardless of stated mode (with a confirmation request if mode=`sleeping`) |
| `bluetooth_context=car` | force `mode=driving` if user said `null` or `inferred` |
| `calendar_event_category=focus` | force or strongly bias `mode=working`; bias toward tracks completed in past focus blocks |
| `calendar_event_category=meal` | bias toward tracks played at dinner-time historically |
| `calendar_event_category=workout` | the system can't promise much without audio features; bias toward tracks played during prior workout-tagged contexts; otherwise lean on top-tracks-short |

These are intentionally conservative. Aggressive biases here are how you ruin a session.

### Learned affinity (the long-term play)

Every play event is linked to a context snapshot via `play_event_context`. A nightly cron job rebuilds `track_context_affinity`:

For each `(track_id, dimension, bucket)`:
```
affinity = (plays_in_bucket / total_plays_of_track) / (plays_in_bucket_overall / total_plays_overall)
```
Then smooth toward 1.0 by `sample_size`:
```
smoothed = 1 + (affinity - 1) × min(1, sample_size / 10)
```
Clamp to `[0.5, 2.0]`.

Once we have at least, say, 50 plays in a bucket for a track, the learned affinity dominates the cold-start rule. Until then, the rule wins. This blend is in `src/curation/context_score.ts`.

### Things we explicitly do NOT do

- No microphone or camera input.
- No continuous location tracking. Snapshots only.
- No inference from messages, email, or notifications.
- No third-party data brokers. Weather API is the only external service.
- No learned affinities used unless `sample_size >= 5`. Below that, defer to rules.

### Failure modes and how we handle them

- **Weather API down:** snapshot stores `null` weather fields; weather biases skip silently.
- **No location set, no shortcut payload:** assume `settings.home_lat/lon`. If those are also null, weather/daylight biases skip.
- **Calendar feed errors:** ignore; calendar bias skips.
- **Context bias produces a session the user clearly hates** (>3 skips in first 5 tracks): the in-session feedback loop falls back to mode + taste only, ignoring context for the rest of the session, and logs the snapshot for review.

---

## 8. The position-based freshness arc

For a session of length N tracks (or N minutes), define a curve `fresh_ratio(position)` that controls how much fresh-pool content shows up.

```
position 0%  ──────────  hits-only (familiar 100%)
position 25% ──────────  warming up (familiar 90%, fresh 10%)
position 50% ──────────  balanced (familiar 70%, fresh 30%)
position 75% ──────────  exploration peak (familiar 50%, fresh 50%)
position 90% ──────────  cool down to familiar (familiar 80%, fresh 20%)
position 100% ─────────  end on something known
```

Each mode has a multiplier on the fresh side of the curve (e.g., `sleeping` multiplies fresh by 0.2; `brainstorming` multiplies fresh by 1.5, capped at 0.7). Keep this configurable in `src/config.ts`.

---

## 9. The discovery agent

Runs as a Cron Trigger, ideally **daily at ~6am local** (configurable). Workflow:

1. **Pull candidate pool from sources:**
   - `GET /browse/new-releases` (limit 50)
   - For each followed artist: `GET /artists/{id}/albums` filtered to `album_type=single,album` and `release_date >= today - 14 days`
   - A configurable list of editorial playlists (`New Music Friday`, `Fresh Finds`, etc.). Fetch their tracks.
2. **Score each candidate against the taste model** (`taste/score.ts`):
   - +weight if primary artist is in `artist_taste` with high score
   - +weight if collaborator artists are in `artist_taste`
   - +weight if the artist appears in seasonal playlists (any season)
   - +weight per editorial playlist appearance the user has historically engaged with
   - −weight if track is already in `track_taste` (not fresh — would be redundant)
3. **Insert top scorers into `fresh_pool`** with `status='fresh'` and `expires_at = now + 21 days`.
4. **Auto-add to a Spotify "Discovery Queue" playlist:** maintain a single Spotify playlist (created on first run) and replace its contents with the current fresh pool, ordered by score descending. This satisfies the "let me browse it myself" requirement.
5. **Expire stale pool entries:** anything past `expires_at` and never played → `status='expired'`.

### What "fresh" means for scoring
A candidate is considered fresh if **the user has not played it before** (no `play_events` for that `track_id`) AND it is not currently in `track_taste`. Re-releases or remasters of known tracks should be filtered out by checking ISRC overlap when available.

---

## 10. The curation agent (the main one the user talks to)

This is the function that runs when the user says "play me working music" or taps an iOS shortcut. Inputs:

- `mode`: one of the six, or `null` to infer from time-of-day + context
- `output`: `play_now` | `queue` | `playlist` (defaults from mode)
- `duration_min`: optional override
- `device_id`: which Spotify device to play on (defaults to last-used)
- `fresh_bias`: optional `-1` to `+1` shift on the freshness curve
- `context`: optional context payload (see §7) — location label, lat/lon, motion, Bluetooth, user note. Anything missing is filled in by the Worker (weather, daylight, calendar, device).

Workflow:

1. **Capture context snapshot** (`src/context/capture.ts`): assemble a row for `context_snapshots` from the input payload + Open-Meteo + calendar + most recent `poll_observations`. Save it; remember the `context_snapshot_id`.
2. **Resolve mode**: use input if provided, otherwise infer from `local_hour`, `daylight_phase`, `calendar_event_category`, `bluetooth_context`, `is_in_motion`, and recent invocation history. Some context strongly forces a mode (e.g. `bluetooth_context=car` → `driving`).
3. **Compute target track count** from `duration_min` (assume avg 3.5 min/track). If a calendar event ends soon, default duration to the time remaining minus 5 minutes.
4. **Build the candidate pool:**
   - Familiar: `track_taste` filtered by `mode_profiles[mode].top_tracks`, with a recency penalty so we don't repeat the last 50 played.
   - Fresh: top-scoring entries in `fresh_pool` (status='fresh').
5. **Apply scoring with context multipliers** (`src/curation/context_score.ts`):
   - For each candidate, compute `final_score = taste_score × mode_weight × Π(context_multipliers)`.
   - Context multipliers blend cold-start rules and learned `track_context_affinity` based on sample size.
   - Clamp the product of multipliers to `[0.5, 2.0]`.
6. **Build the session list** position-by-position:
   - Compute `fresh_ratio(position)` after mode multiplier (see §8).
   - Pick familiar vs. fresh; weighted random from the scored pool.
   - Avoid back-to-back same-artist unless very high score.
7. **Execute the output:**
   - `play_now`: clear queue, play first track, queue the rest in order.
   - `queue`: append to current queue without disrupting playback.
   - `playlist`: create a new playlist `{Mode} — {Date}` and add tracks.
8. **Persist the session** (`sessions` + `session_tracks`), with the `context_snapshot_id` linked.
9. **Start watching for feedback** if `play_now` or `queue`: the listening tracker continues; `curation/feedback.ts` reads `play_events` and reacts. Each play event for this session is also written to `play_event_context` linking it back to the snapshot — this is what feeds `track_context_affinity` over time.

### In-session feedback rules
- **Skip in first 25%:** strong negative. Mark the track outcome, and if it was a fresh pick, lower scores for that source/style for the rest of the session.
- **Skip after 75%:** mild negative; treat track as "fine but not now."
- **Replay:** strong positive. If a fresh track is replayed, mark it `status='liked'` in the fresh pool and consider promoting it (next refresh of `track_taste` will pick this up).
- **Three skips in a row:** swap the rest of the session to higher-familiarity weighting (multiply familiar ratio by 1.3, cap 0.95).
- **Three skips in first 5 tracks AND context biases were applied:** assume context guess is wrong; rebuild remaining queue using mode + taste only (context multipliers all set to 1.0). Log the snapshot for later review.

---

## 11. Interfaces

### a. MCP server (Claude chat invocation)
HTTP MCP server exposed at `/mcp`. Tools:

- `start_session(mode?, duration_min?, output?, fresh_bias?, user_note?)` — `user_note` is free-text physical context ("about to cook dinner", "long drive home") that gets stored in the snapshot and influences inference.
- `current_session_status()` → returns active session, what's playing, upcoming queue, applied context biases
- `end_session()` → marks session ended, stops if `play_now`
- `add_to_seasonal(track_id?)` → if no track_id, uses currently-playing; adds to current season's playlist
- `get_fresh_pool(limit?)` → returns top-N fresh candidates for review
- `mark_track(track_id, action: 'love'|'block')` → influences future scoring
- `stats(period: 'today'|'week'|'month')` → top played, skip rate, fresh ratio observed
- `current_context()` → returns the latest snapshot (weather, daylight, calendar, location label) — useful for Claude to explain its picks

User connects this MCP server to Claude.ai via the connectors UI. Then in chat: "Hey Claude, start a working session for 90 minutes — I'm at a coffee shop and it's pouring rain."

### b. iOS Shortcut endpoints
HTTPS endpoints, Bearer-token auth (single static token in KV). Shortcuts post a JSON body with optional context fields:

- `POST /shortcut/start` body: `{ "mode": "working", "minutes": 90, "context": { "location_label": "home", "location_lat": 33.78, "location_lon": -84.39, "is_in_motion": 0, "bluetooth_context": "headphones", "user_note": null } }`
- `POST /shortcut/queue` — same body shape, queues without disrupting playback
- `POST /shortcut/save` — same body shape, output=playlist; returns the spotify URI
- `POST /shortcut/save_to_seasonal` — current track to current season; no body needed

The shortcut populates `context` from "Get Current Location," "Get Current Network," and "Get Current Bluetooth" actions. Any field can be omitted — the Worker fills in what it can.

Each endpoint returns minimal JSON the shortcut can speak back: `{"ok": true, "summary": "Started working session, 26 tracks queued. Rainy afternoon mix."}`.

### c. Dashboard
Single-page app on Cloudflare Pages, behind Cloudflare Access. Shows:

- **Now Playing** card (poll the API)
- **Active session** if any: progress, upcoming queue, mode, fresh-vs-familiar count so far, **and the context biases that shaped it** (e.g. "🌧️ rainy bias: +5%, 🌙 night bias: +10%")
- **Latest context snapshot:** weather, daylight phase, location label, calendar event if any
- **Buttons:** "Start [mode]" for each of the six; "End session"; "Add current to seasonal"
- **Fresh Pool** table: candidates with score, source, status; click-to-play
- **Stats:** last 7 days listening hours by mode; skip rate; fresh adoption rate (how many fresh picks you actually completed); context breakdown (e.g. minutes listened in each weather condition / daylight phase)
- **Settings:** home lat/lon; time zone; discovery sources to enable/disable; mode overrides; fresh bias default; calendar iCal URL; context features on/off

Keep it ugly first (plain HTML + a tiny TS file). Pretty later.

---

## 12. OAuth and secrets

Spotify OAuth scopes needed:
```
user-read-private
user-read-email
user-read-playback-state
user-modify-playback-state
user-read-currently-playing
user-read-recently-played
user-top-read
user-library-read
user-library-modify
user-follow-read
playlist-read-private
playlist-read-collaborative
playlist-modify-private
playlist-modify-public
```

### Setup steps for the user (put this in SETUP.md)
1. Go to https://developer.spotify.com/dashboard, create a new app.
2. Add redirect URI: `https://<your-worker-subdomain>.workers.dev/auth/callback` (we'll know this URL after first deploy).
3. Copy Client ID and Client Secret.
4. Run `wrangler secret put SPOTIFY_CLIENT_ID` and paste; same for `SPOTIFY_CLIENT_SECRET`.
5. Generate a strong random string for `SHORTCUT_TOKEN`; save it; `wrangler secret put SHORTCUT_TOKEN`.
6. Visit `https://<your-worker-subdomain>.workers.dev/auth/login` once in a browser. Log in with Spotify. The Worker stores the refresh token in KV.

Refresh tokens are long-lived; access tokens get refreshed automatically by `auth/spotify-oauth.ts` whenever a request returns 401.

### Cloudflare Access on dashboard
Once the dashboard is live, configure a Cloudflare Access application protecting `dashboard.<your-domain>` (or the Pages URL) with the user's email as the only allowed identity. Free for our scale.

---

## 13. Build order — milestones

Each milestone should ship something you can actually use, even if it's small.

### Milestone 0 — repo skeleton, hello world
- Initialize repo, `wrangler.toml`, TypeScript config.
- Bind one D1 DB and one KV namespace.
- Worker responds 200 on `/`. Deploy. Verify URL works.

### Milestone 1 — Spotify OAuth working end to end
- `/auth/login`, `/auth/callback`, refresh-on-401 logic in `spotify/client.ts`.
- `/me` endpoint that returns the user's Spotify profile to prove tokens flow.
- **Acceptance:** user can log in once, then `curl /me` returns their display name a week later.

### Milestone 2 — listening tracker
- D1 schema applied.
- Cron every 1 minute: poll `currently-playing`, write `poll_observations`.
- Daily cron: derive `play_events` from observations, prune old observations.
- Tiny endpoint `/debug/recent-events` for verification.
- **Acceptance:** play music for an hour, then check `play_events` shows accurate skips/completes.

### Milestone 3 — taste model v1
- Sync seasonal playlists into `seasonal_playlists` (auto-detect by name pattern; user may need to confirm the regex).
- Daily cron: rebuild `track_taste` and `artist_taste` from saved tracks, top tracks/artists, seasonal playlists, and `play_events`.
- Endpoint `/debug/top-tracks-by-score`.
- **Acceptance:** top tracks output looks like the user's actual taste, not random.

### Milestone 4 — curation agent v1 (familiar-only)
- `start_session(mode, output)` builds a session entirely from familiar tracks.
- Plays via `PUT /me/player/play` with track URIs.
- Persists session and tracks.
- **Acceptance:** "start a working session" plays tracks the user actually likes, in a sensible order.

### Milestone 5 — discovery agent v1 (Spotify sources only)
- Daily cron pulls new releases + followed artists' new releases + a configured set of editorial playlists.
- Scores against taste model, populates `fresh_pool`.
- Maintains "Discovery Queue" Spotify playlist.
- **Acceptance:** after a couple of days, fresh pool contains plausibly relevant tracks.

### Milestone 6 — full curation with fresh arc
- Curation agent now mixes familiar and fresh per the position curve.
- Mode-specific multipliers applied.
- **Acceptance:** sessions feel like sessions, with a believable arc.

### Milestone 7 — physical context capture
- `settings` table seeded (home lat/lon, time zone).
- Open-Meteo client; daylight-phase calculator.
- `context_snapshots` row created on every session start.
- iOS Shortcut payload schema accepted at `/shortcut/start` (location_label, lat/lon, motion, Bluetooth, user_note).
- `/debug/last-snapshot` endpoint to inspect.
- **Acceptance:** start a session at home and from a coffee shop on a rainy day; both snapshots look correct.

### Milestone 8 — context-aware curation (cold-start rules)
- Implement `context_score.ts` with the cold-start rule biases from §7.
- Curation agent applies multipliers; clamp range and bias size are tunable in `config.ts`.
- Add a "why these tracks?" debug endpoint that explains the biases applied.
- **Acceptance:** rainy-night unwinding session feels meaningfully different from sunny-afternoon driving session, with the same mode.

### Milestone 9 — in-session feedback loop
- New cron (every 2 min while a session is active) reads recent `play_events` and adjusts the queue.
- Skip-rate triggers swap-out logic, including the "context might be wrong" reset.
- Each play_event gets linked via `play_event_context`.
- **Acceptance:** skipping a few fresh tracks visibly shifts the rest toward familiar; mass-skipping resets context biases.

### Milestone 10 — learned context affinities
- Nightly cron rebuilds `track_context_affinity` from `play_events` + `play_event_context`.
- `context_score.ts` blends rules with learned affinities by sample size.
- Dashboard shows "tracks with strong affinity for [rain / night / car / focus]."
- **Acceptance:** after a few weeks of data, a track's affinity scores reflect the user's actual patterns.

### Milestone 11 — iOS shortcut endpoints + the shortcut itself
- `/shortcut/*` endpoints with token auth, accepting context payload.
- Document how to build the iOS shortcut (screenshots in SETUP.md), including the "Get Current Location," "Get Current Network," and "Get Current Bluetooth" actions to populate context.
- **Acceptance:** "Hey Siri, start working music" works and includes location/motion context.

### Milestone 12 — calendar integration (optional)
- Add an iCal URL to `settings.calendar_ical_url`.
- `context/calendar.ts` fetches current event at snapshot time and infers category.
- **Acceptance:** a calendar event titled "Focus block" or "Drive to airport" influences mode and biases.

### Milestone 13 — dashboard
- Pages deployment.
- Now Playing, mode buttons, fresh pool view, stats.
- Context view: latest snapshot + which biases were applied to the current session.
- Cloudflare Access configured.

### Milestone 14 — MCP server
- HTTP MCP transport at `/mcp`.
- Tools listed in §11a, including context-aware variants.
- Connect from Claude.ai, test conversationally.

### Milestone 15 — NPR Music integration (v2)
- New discovery source. Pull from NPR Music feeds (e.g. All Songs Considered, New Music Friday from NPR). Match track titles to Spotify search to get URIs.
- Tag `fresh_pool.source` accordingly.

### Future / nice to have
- Cyanite or ReccoBeats integration if behavioral mode inference proves insufficient.
- "Why am I hearing this?" explanation per track in the dashboard, broken down by taste / mode / each context dimension.
- Weekly/monthly listening summaries (private "Wrapped" via email), with context breakdowns ("you listened to a lot of X on rainy days this month").
- HomeKit / Home Assistant integration for richer at-home context.
- Apple Watch / HealthKit integration for workout heart-rate signals (would need a companion iOS app).

---

## 14. Things to keep telling the user as we go

- **API costs:** zero on Cloudflare's free tier for one-user usage. Spotify is free with the developer account. NPR feeds are free. If we add ReccoBeats/Cyanite later, those have their own pricing.
- **What can break:** Spotify could deprecate more endpoints. The listening tracker has a 1-min polling resolution, so very short skips might be misclassified — that's fine for our purposes.
- **Privacy:** all data lives in the user's own Cloudflare account. No third party sees the listening history.
- **Backups:** export D1 to a local file weekly. Add a simple `/admin/export` endpoint behind Cloudflare Access.

---

## 15. Recommended first prompt for Claude Code

When the user opens this project in Claude Code, here's a good kickoff prompt:

> I want to build the Spotify curation agent described in `SPOTIFY_AGENT_PLAN.md`. I'm not a developer; I need step-by-step guidance and explanations. Please start with **Milestone 0**: read the plan doc, then walk me through setting up the repo, installing wrangler, creating a Cloudflare Workers project with TypeScript, binding a D1 database and a KV namespace, and deploying a hello-world Worker. Stop after Milestone 0 is complete and verified, and we'll do Milestone 1 in the next session.

Each subsequent session, the user can say: "Let's do Milestone N. Here's what's working so far: …"

---

## 16. Open questions to resolve as we go

These don't block starting, but flag them when relevant:

1. **Naming pattern for seasonal playlists.** The taste model auto-detects them by name. What's the user's pattern? E.g. "Summer 2024" or "S24" or "🌞 24" — needs confirmation.
2. **Time zone.** Cloudflare Workers run in UTC. We need to know the user's local time for hour-of-day inference. Default to `America/New_York` (per user's Atlanta location), confirm at Milestone 7.
3. **Default device.** First session will need the user to start playing something on Spotify so we know which device to target. After that, last-used is fine.
4. **"Discovery Queue" playlist size.** 50? 100? Decide before Milestone 5.
5. **Editorial playlists for discovery.** Pick 5–10 to start. Suggested defaults: New Music Friday, Fresh Finds, Pollen, Lorem, Bedroom Pop, Indie Mixtape. Confirm with user before locking in.
6. **Home location.** Need lat/lon for weather and sunrise/sunset. Either ask the user once and store in `settings`, or accept a city name and geocode once. Decide at Milestone 7.
7. **Calendar source.** Google Calendar (private iCal share URL is easiest), Apple Calendar (CalDAV is harder), or skip until v2. Most users find Google iCal export simplest. Decide at Milestone 12.
8. **Context bias magnitudes.** The cold-start rules in §7 use small multipliers (×1.05 to ×1.3). Tune these by feel after Milestone 8.
9. **iOS Shortcut location precision.** Decide whether to round/truncate lat/lon stored in DB for privacy (e.g., 2 decimal places ≈ 1km). Probably yes by default.

---

*End of plan document.*
