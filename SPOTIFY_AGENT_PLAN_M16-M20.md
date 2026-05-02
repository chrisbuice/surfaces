# Surfaces — Milestones M16–M20

Extension to `SPOTIFY_AGENT_PLAN.md`. The original plan ended at M15 (editorial RSS discovery). This document covers the next phase: audio features via ReccoBeats, an acoustic preference profile, Last.fm-driven discovery, expanded external sources, and acoustic-aware curation.

This document is structured so each milestone section can be lifted whole and pasted into a Claude Code prompt. The shared design decisions, schema, and dependencies live in §1–§4 so they're stated once. Milestones reference back to those sections by anchor.

---

## 1. Design decisions (read before any milestone)

These apply across M16–M20. Don't relitigate per milestone unless evidence emerges that a decision was wrong.

### 1.1 Audio features provider: ReccoBeats

Free, drop-in replacement for Spotify's deprecated audio features API. Takes Spotify track IDs, returns the same nine fields (acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence). No rate-limit issues reported at our volume.

Fallback (not implemented in v1): SoundStat. Slightly different scale, freemium pricing. Architect ReccoBeats integration behind an interface so a second provider could be slotted in if ReccoBeats fails or shuts down. Don't actually wire SoundStat now — just don't paint ourselves into a corner.

Local extraction (Essentia) is rejected: Workers can't run it, and Spotify only exposes 30-second previews to Dev Mode apps so we can't reliably source full audio.

### 1.2 Backfill cadence

Audio features are fetched out-of-band by a dedicated cron, not inline during taste rebuild or discovery. The cron processes a chunked batch per run (default: 50 tracks, configurable). It picks tracks that don't yet have features, prioritizing higher taste scores. This means:

- ReccoBeats latency never blocks user-facing flows
- Workers' 30s CPU limit per invocation is never threatened
- Backfill catches up over days, not seconds — fine because audio features are immutable and the order of acquisition doesn't matter

### 1.3 Acoustic profile granularity

Per-mode centroids only. Not per-(mode × context). With ~121 scored tracks today, slicing by both is undertrained. Mode-only gives 6 buckets each with ~20 tracks on average — borderline, but workable. Revisit when total play_events × scored tracks suggest finer slicing would be statistically meaningful. Track in `OPEN_QUESTIONS.md`.

### 1.4 Last.fm integration

API key only — no user authentication, no scrobbling required. We're consuming the public recommendation graph (`artist.getSimilar`, `track.getSimilar`, `tag.getTopTracks`).

Rate limit: 5 req/sec per their docs. We throttle to 2 req/sec to be polite. Similar-artist responses are cached in D1 for 7 days (the underlying graph changes slowly).

### 1.5 Candidate dedup

Primary key: Spotify track ID. Secondary: ISRC (reverted to availability in the March 2026 Spotify changelog). When the same conceptual track resolves to two different Spotify IDs (region/remaster differences), ISRC catches the duplicate.

We dedup the fresh pool aggressively. Same artist+title without ISRC match is allowed — different versions of "Shake It Off" might genuinely be different tracks for our purposes.

### 1.6 Scoring weights

Adding `acoustic_fit` as another multiplier in the curation agent's track scoring. Bounds:

- `taste_score`: unbounded (the base)
- `mode_weight`: [0, ∞), but typically [0.5, 2.0] in practice
- `context_multipliers` (product of): clamped [0.5, 2.0]
- `acoustic_fit`: clamped **[0.7, 1.4]** — narrower than context

The narrower clamp on `acoustic_fit` is deliberate. The acoustic profile is cold-started from limited data; we don't want a half-trained centroid to dominate the session shape. Widen later when the centroid stabilizes.

All weights tunable in `config.ts`.

### 1.7 Provider abstraction

Both ReccoBeats and Last.fm get thin client wrappers in their own modules (`src/audio/reccobeats.ts`, `src/discovery/lastfm.ts`) following the same shape as `src/spotify/client.ts`: a single class with `get`/`post` methods, retry logic, and a typed response interface. Don't fold either into existing modules.

### 1.8 Dashboard surfacing

M20 includes a small enrichment to "Why these tracks?" showing the acoustic fit alongside existing taste/context reasons. No new dashboard milestone needed.

---

## 2. Database schema additions

All schema additions are forward-only migrations. Apply via `wrangler d1 execute` using a numbered migration file under `src/db/migrations/`. Don't modify `src/db/schema.sql` directly — that's the canonical schema for fresh installs, and it should be updated to reflect the cumulative state at the end of M20.

### 2.1 New table: `track_audio_features` (M16)

```sql
CREATE TABLE track_audio_features (
  track_id TEXT PRIMARY KEY,
  acousticness REAL NOT NULL,
  danceability REAL NOT NULL,
  energy REAL NOT NULL,
  instrumentalness REAL NOT NULL,
  liveness REAL NOT NULL,
  loudness REAL NOT NULL,
  speechiness REAL NOT NULL,
  tempo REAL NOT NULL,
  valence REAL NOT NULL,
  source TEXT NOT NULL,             -- 'reccobeats', future: 'soundstat', etc.
  fetched_at INTEGER NOT NULL       -- unix seconds
);
CREATE INDEX idx_audio_features_fetched ON track_audio_features(fetched_at);
```

### 2.2 New table: `acoustic_profile` (M17)

```sql
CREATE TABLE acoustic_profile (
  mode TEXT NOT NULL,                       -- 'waking_up' | 'working' | etc. | 'overall'
  dimension TEXT NOT NULL,                  -- 'acousticness' | 'danceability' | ... | 'valence'
  mean REAL NOT NULL,
  stddev REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  PRIMARY KEY (mode, dimension)
);
```

`mode='overall'` is the user's catch-all centroid across all modes — used as a fallback when a specific mode's `sample_size` is too low.

### 2.3 New table: `lastfm_similar_cache` (M18)

```sql
CREATE TABLE lastfm_similar_cache (
  query_type TEXT NOT NULL,         -- 'artist_similar' | 'track_similar' | 'tag_top_tracks'
  query_key TEXT NOT NULL,          -- artist_name, "artist|title", or tag name
  response_json TEXT NOT NULL,      -- raw response, parsed at read time
  fetched_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (query_type, query_key)
);
CREATE INDEX idx_lastfm_expires ON lastfm_similar_cache(expires_at);
```

### 2.4 Extension: `fresh_pool.source` value space (M18, M19)

No schema change — `source` is already TEXT. New values that will appear:

- `lastfm:artist_similar:<seed_artist_id>` — found via Last.fm similar-artists graph
- `lastfm:track_similar:<seed_track_id>` — found via Last.fm similar-tracks graph
- `lastfm:tag:<tag_name>` — found via tag top tracks
- `rss:pitchfork`, `rss:npr_all_songs`, `rss:bandcamp_daily`, `rss:aquarium_drunkard`, etc. (M19)
- `hype_machine` (M19, if included)

### 2.5 Optional column on `track_taste` (M20)

If the curation agent wants per-track acoustic fit cached alongside taste score:

```sql
ALTER TABLE track_taste ADD COLUMN acoustic_fit_overall REAL;
```

Stores the acoustic fit against the `mode='overall'` centroid. Computed during taste rebuild. Avoids recomputing on every session start. Per-mode acoustic fit is computed at session time (it's cheap given the centroid is already in memory).

---

## 3. New API endpoints

| Path | Method | Description | Milestone |
|------|--------|-------------|-----------|
| `/debug/audio-features?track_id=X` | GET | Show audio features for a track (fetch from ReccoBeats if missing) | M16 |
| `/debug/audio-features-stats` | GET | Counts: total tracks in taste model, with features, missing features | M16 |
| `/debug/run-audio-backfill` | GET | Manually trigger a backfill batch | M16 |
| `/debug/acoustic-profile?mode=X` | GET | Show acoustic centroid for a mode | M17 |
| `/debug/lastfm-similar?artist=X` | GET | Show Last.fm similar artists with cache hit/miss | M18 |
| `/debug/discovery-by-source` | GET | Fresh pool counts grouped by source | M18, M19 |

All debug endpoints stay unauthenticated (matching existing conventions).

---

## 4. Cron schedule changes

| Cron | Current | After M20 | What |
|------|---------|-----------|------|
| `* * * * *` | poll + derive | unchanged | |
| `*/2 * * * *` | feedback | unchanged | |
| `0 5 * * *` (1am ET) | rebuild taste, prune | rebuild taste, prune, **rebuild acoustic_profile** | M17 adds centroid rebuild |
| `0 10 * * *` (6am ET) | discovery | discovery (now multi-source) | M18, M19 expand sources |
| `0 0 * * *` (8pm ET) | nightly email | unchanged | |
| **NEW: `30 */2 * * *`** | — | audio features backfill | M16 — every 2 hours, runs a 50-track batch |

The audio features backfill cron runs frequently but does small batches. It's a slow drip rather than a thundering herd.

---

## 5. Secrets to add

Each is set via `wrangler secret put SECRET_NAME`:

| Secret | When | Notes |
|--------|------|-------|
| `RECCOBEATS_API_BASE` | M16 | Optional override for the API base URL; defaults to the public endpoint |
| `LASTFM_API_KEY` | M18 | Get from https://www.last.fm/api/account/create — Application Name is the only required field |

ReccoBeats does not require an API key as of this writing. If they introduce one, add `RECCOBEATS_API_KEY` and gate the client on it.

---

## 6. Repository structure additions

```
src/
  audio/
    reccobeats.ts            # M16: ReccoBeats client
    backfill.ts              # M16: cron handler for batched feature fetch
    profile.ts               # M17: build acoustic_profile centroids
    fit.ts                   # M17/M20: compute per-track acoustic fit vs. a profile
  discovery/
    lastfm.ts                # M18: Last.fm client + cache layer
    similar.ts               # M18: pull similar-artist/track candidates
    rss_extras.ts            # M19: additional RSS feed adapters
    hype_machine.ts          # M19 (optional): Hype Machine API adapter
  db/
    migrations/
      001_audio_features.sql # M16
      002_acoustic_profile.sql # M17
      003_lastfm_cache.sql   # M18
      004_track_taste_acoustic_fit.sql # M20 (only if §2.5 adopted)
```

Existing files modified by these milestones:

- `src/index.ts` — new debug endpoints, new cron handler routing
- `src/config.ts` — new tunable constants for audio backfill batch size, scoring weights, Last.fm cache TTL
- `src/discovery/agent.ts` — accept candidates from new sources (Last.fm, expanded RSS), unified scoring against taste model
- `src/curation/agent.ts` — apply `acoustic_fit` multiplier (M20)
- `src/taste/model.ts` — optionally compute and cache `acoustic_fit_overall` per track (M20, if §2.5 adopted)
- `dashboard/index.html` — extend "Why these tracks?" with acoustic fit (M20)
- `wrangler.toml` — new cron entry (M16)

---

## 7. Per-milestone prompts

Each subsection below is structured to be pasted whole into a Claude Code prompt. They reference §1–§6 by anchor and assume those sections exist in the repo (save this document as `SPOTIFY_AGENT_PLAN_M16_M20.md` next to the original plan).

### M16 — ReccoBeats integration and audio features backfill

**Prompt for Claude Code:**

```
Read SPOTIFY_AGENT_PLAN_M16_M20.md sections §1.1, §1.2, §1.7, §2.1, §3, §4, §5, §6, then build M16.

Goal: every track in our taste model accumulates audio features from ReccoBeats over time, fetched by a low-priority cron rather than blocking any user-facing flow.

Phase 1 (no commits — show me first):
1. Read the project context from SPOTIFY_AGENT_PLAN.md, PROJECT_STATUS.md, OPEN_QUESTIONS.md.
2. Walk the ReccoBeats API: fetch https://reccobeats.com/docs/apis/get-track-audio-features and the parent API doc to confirm the request/response shape, any auth requirements, and any rate-limit behavior. Note the actual base URL and endpoint path.
3. Propose a plan covering:
   - Files to create (src/audio/reccobeats.ts, src/audio/backfill.ts, src/db/migrations/001_audio_features.sql)
   - The ReccoBeats client interface — keep it provider-agnostic so SoundStat could slot in later (e.g., a generic AudioFeaturesProvider interface that ReccoBeats implements)
   - Backfill batch logic: pick N tracks from track_taste with no row in track_audio_features, ordered by taste_score DESC, fetch features for each with a small delay between requests, write rows
   - Cron entry for `30 */2 * * *` in wrangler.toml
   - Three debug endpoints per §3
   - Tunable constants in config.ts: AUDIO_BACKFILL_BATCH_SIZE (default 50), AUDIO_BACKFILL_REQUEST_DELAY_MS (default 200)
   - Update src/db/schema.sql to include the new table (cumulative source-of-truth)
4. Stop and wait for approval.

Phase 2: implement the plan. One commit for the migration + schema update, one commit for the client + backfill + cron, one commit for debug endpoints.

Phase 3: smoke test.
- Apply migration via `wrangler d1 execute` (locally first if possible, then production)
- Hit /debug/audio-features?track_id=<some_top_track> — should fetch live and store
- Hit /debug/audio-features-stats — should show 1 row
- Hit /debug/run-audio-backfill — should fetch a batch
- Re-hit /debug/audio-features-stats — should show batch_size + 1 rows
- Report results before declaring complete

Constraints:
- Workers' 50-subrequest limit applies. The backfill batch is N sequential fetches, so batch size must be <50 to leave headroom for the request that triggered it. Default 50 → cap to 40 effective. Document this in the cron handler.
- The 30-second CPU limit also applies. With 200ms delays, 40 tracks = ~8 seconds. Fine.
- ReccoBeats may return 404 for tracks it doesn't know about. Don't crash — write a row with a placeholder source like 'reccobeats:not_found' or skip and log. Decide which in the plan.
- Cache the response shape, not just our normalized fields, in case we want to extract more later. Actually no — keep the schema clean. If we want more fields, we'll add columns. Don't store JSON blobs.
- Don't add audio features to taste scoring yet. M16 is just data acquisition.

When done, update PROJECT_STATUS.md milestone table and commit history.
```

### M17 — Acoustic preference profile

**Prerequisites:** M16 complete, audio features accumulating in `track_audio_features`.

**Prompt for Claude Code:**

```
Read SPOTIFY_AGENT_PLAN_M16_M20.md sections §1.3, §2.2, §3, §4, §6, then build M17.

Goal: from the user's actual play history, compute per-mode centroids (mean + stddev) across all 9 audio feature dimensions. These centroids are what M20 will score new candidates against.

Phase 1 (no commits — show me first):
1. Sketch the centroid algorithm. Roughly:
   - For each (mode, dimension), find all play_events that occurred during that mode's typical hours (use mode_profiles.hour_distribution, or a simpler heuristic: events where classification='completed' or 'replayed' during that mode's default time window from config.ts)
   - Join with track_audio_features to get the dimension value per event
   - Compute weighted mean (weight by 1.0 for completed, 1.5 for replayed; skip skipped events)
   - Compute stddev
   - Also compute 'overall' mode = all completed/replayed events regardless of mode
   - Skip writing a row if sample_size < some threshold (propose a value — I'm thinking 10)
2. Propose the file layout (src/audio/profile.ts), the cron integration (extend the 1am cron, don't add a new one — the 9-dimension × 7-mode rebuild is fast), and the debug endpoint.
3. Stop and wait for approval.

Phase 2: implement.

Phase 3: smoke test.
- Trigger taste rebuild manually via /debug/rebuild-taste (or wait for cron)
- Hit /debug/acoustic-profile?mode=overall — should show 9 rows with means and stddevs
- Hit /debug/acoustic-profile?mode=working — should show populated rows IF enough working-mode plays exist; otherwise note which modes are undertrained
- Sanity check: a mode like 'sleeping' should have lower energy mean than 'driving'. If it doesn't, the data is too thin or the mode-time-window filter is wrong. Report findings.

Constraints:
- Don't bias the centroid toward songs that play often vs. seldom-but-completed. Weight is per-event, not per-track; a track played 50 times gets 50x the weight of a one-time play. That's intentional — we're modeling the user's *actual* preferences, not their stated ones.
- Modes whose centroids fall back to 'overall' should be flagged in the debug endpoint output ("sleeping: insufficient samples (n=4), use overall")
- Centroids are read at curation time (M20). M17 just produces the data.

When done, update PROJECT_STATUS.md and OPEN_QUESTIONS.md (add an item: "Acoustic profile granularity — currently mode-only; revisit per-(mode × context) when sample sizes support it").
```

### M18 — Last.fm-driven discovery

**Prerequisites:** M16/M17 not strictly required (M18 produces candidates, doesn't score them acoustically — that's M20), but I recommend doing M16/M17 first so candidates can be scored against the taste model from day one.

**Prompt for Claude Code:**

```
Read SPOTIFY_AGENT_PLAN_M16_M20.md sections §1.4, §1.5, §1.7, §2.3, §2.4, §3, §5, §6, then build M18.

Goal: the discovery agent gains a new source — Last.fm's similar-artists and similar-tracks graphs. This expands candidates beyond artists the user already knows about.

Phase 1 (no commits — show me first):
1. Read the Last.fm API docs (https://www.last.fm/api). Confirm:
   - The endpoints needed: artist.getSimilar, track.getSimilar, tag.getTopTracks
   - That they're free, key-only auth (no OAuth)
   - The actual rate limit (5 req/sec stated, we'll throttle to 2)
2. Propose:
   - src/discovery/lastfm.ts — client with caching layer reading/writing lastfm_similar_cache
   - src/discovery/similar.ts — orchestration: for each top-20 artist, fetch similar; for each high-affinity tag in artist_taste.genres, fetch tag top tracks; resolve all (artist, track) pairs to Spotify track IDs via the existing search; dedup vs. tracks already known
   - Integration into the daily discovery cron alongside the existing artist-search and editorial-RSS sources
   - Updated discovery scoring to handle the new source values per §2.4
3. Migration file 003_lastfm_cache.sql.
4. New debug endpoints per §3 (lastfm-similar, discovery-by-source).
5. Stop and wait for approval.

Phase 2: implement.

Phase 3: smoke test.
- Hit /debug/lastfm-similar?artist=<some_top_artist> — should show similar artists, cache MISS first call, HIT on retry
- Hit /debug/run-discovery — should add new candidates with source='lastfm:*'
- Hit /debug/discovery-by-source — should show non-zero counts for lastfm sources
- Hit /debug/fresh-pool — top results should include tracks the existing artist-search-only flow couldn't have surfaced

Constraints:
- LASTFM_API_KEY must be set as a Worker secret. Document in the commit message that the user needs to set this before discovery will run successfully.
- The 7-day cache means the first run after deployment is slow (cache miss for every query). Design the orchestration to be resilient to a partial run — write candidates as they resolve, not in one final batch, so a CPU timeout doesn't lose all progress.
- Throttle Last.fm requests to 2/sec via setTimeout-style delay between calls. Workers don't have setTimeout but Date.now() spinning works for short waits, and we can use scheduled chunking if needed.
- ISRC dedup per §1.5: when we get a track ID from search, fetch the track and check track_audio_features and track_taste for any existing track with the same ISRC. external_ids.isrc was reverted in March 2026 so it's available.
- Don't remove or weaken existing discovery sources (followed-artist search, top-artist search, RSS feeds). Add to them.

When done, update PROJECT_STATUS.md.
```

### M19 — Expanded external sources

**Prerequisites:** M18 complete (so the multi-source discovery infrastructure exists; M19 mostly adds adapters that plug into it).

**Prompt for Claude Code:**

```
Read SPOTIFY_AGENT_PLAN_M16_M20.md section §2.4 and §6, then build M19.

Goal: expand discovery candidate diversity by adding external editorial and aggregator sources.

Sources to add (in priority order):
1. Pitchfork RSS (https://pitchfork.com/rss/reviews/best/tracks/ — verify exact URL)
2. NPR Music (All Songs Considered RSS, plus the NPR Music New Music Friday feed if accessible)
3. Aquarium Drunkard
4. Bandcamp Daily (per-genre feeds may be more useful than the firehose)
5. Hype Machine — only if their public API is still accessible without an enterprise key. If not, skip silently.
6. Gorilla vs Bear, FADER — only if RSS exists and parses cleanly with the existing regex approach

Phase 1 (no commits — show me first):
1. For each source, confirm the feed URL, fetch a sample, identify the title pattern (the regex we'd use to extract artist+track), and note any that don't have a stable artist-track pattern (e.g., long-form articles that mention many artists). Skip sources where extraction is unreliable.
2. Propose src/discovery/rss_extras.ts containing one adapter per source, all conforming to the same shape as the existing RSS adapters in src/discovery/sources.ts.
3. Propose a rotation strategy — we don't want to hammer all feeds every day. Maybe rotate one feed per day, similar to the existing 3-feed rotation. Or expand to all-feeds-but-cached-per-feed. Recommend one with reasoning.
4. Stop and wait for approval.

Phase 2: implement.

Phase 3: smoke test.
- /debug/run-discovery — should pull from at least one new source
- /debug/discovery-by-source — should show counts under the new source values
- Spot-check a few new candidates: do they make sense given the source? (Pitchfork should bias indie, NPR should bias eclectic, etc.)

Constraints:
- Each adapter should fail soft. If a feed is down or the structure changes, log and continue — don't take down discovery.
- Title parsing is regex-based per existing convention. Some feeds (esp. Bandcamp Daily) have inconsistent title formats; flag any source where extraction success rate is < 50% as low-quality.
- Hype Machine: if you can't confirm a free public API path quickly, skip it and note in OPEN_QUESTIONS.md as a future possibility.
- Reddit (r/listentothis, r/indieheads) is NOT in scope for M19 — too noisy for the regex approach.

When done, update PROJECT_STATUS.md and add a row to the cron summary table noting the rotation strategy.
```

### M20 — Acoustic-aware curation

**Prerequisites:** M16, M17 complete (need both audio features per track and per-mode centroids before scoring can use them). M18, M19 nice-to-have but not required.

**Prompt for Claude Code:**

```
Read SPOTIFY_AGENT_PLAN_M16_M20.md sections §1.6, §1.8, §2.5, §6, then build M20.

Goal: the curation agent applies an `acoustic_fit` multiplier to track scores during session building, so sessions stay within an acoustic envelope appropriate to the mode.

Phase 1 (no commits — show me first):
1. Decide whether to adopt §2.5 (cache acoustic_fit_overall on track_taste). My recommendation: yes — taste rebuild is daily, the cache is fresh enough, and skipping the per-track recompute on session start is worth it. Confirm or push back.
2. Sketch the fit formula. Proposal:
   - For a track and a target centroid (mean_d, stddev_d for each dimension d):
     - distance = sum over dimensions of: ((track_value_d - mean_d) / max(stddev_d, 0.05))^2
     - Smaller distance = better fit
     - Convert to multiplier: fit = 1.0 + (some_constant) × (1 - normalized_distance)
     - Clamp to [0.7, 1.4] per §1.6
   - Propose values for the constant and the normalization. Walk through a sanity check: a track at the centroid → fit ≈ 1.4; a track far away → fit ≈ 0.7.
3. Propose the curation/agent.ts modifications: where in the existing scoring pipeline does acoustic_fit slot in? (Suggested: alongside context_multipliers in the final_score formula.)
4. Propose the dashboard enrichment: extend the /api/session-explain response with the acoustic fit value and the dominant dimension (the one contributing most to fit/misfit), and surface it in dashboard/index.html.
5. Stop and wait for approval.

Phase 2: implement.

Phase 3: smoke test.
- Trigger taste rebuild to populate acoustic_fit_overall on track_taste rows
- Start a session in 'unwinding' mode, observe queue
- Compare against a session in 'driving' mode with the same starting context
- The two queues should differ in their average energy/danceability/valence in the expected directions
- Hit /api/session-explain — verify the acoustic fit field appears
- Open the dashboard, verify the new info renders

Constraints:
- Tracks with no audio features (M16 hasn't backfilled them yet) should default to acoustic_fit = 1.0 (neutral). Don't penalize them — they're not less liked, they're just unscored. Document this.
- If the target mode's acoustic_profile has sample_size < threshold (per M17), fall back to mode='overall'. Document the fallback.
- Don't tune weights in this milestone beyond setting the [0.7, 1.4] clamp. Tuning needs real-world session data, which means we tune in a follow-up after M20 has been running for a couple weeks.
- The dashboard change is small — one extra column or paragraph in "Why These Tracks". Don't redesign the table.

When done, update PROJECT_STATUS.md, add an OPEN_QUESTIONS.md item for "Tune acoustic_fit clamp and weight after 2+ weeks of M20 sessions."

This closes out the M16-M20 phase. Total milestone count: 21 (M0-M20, with M12 still skipped).
```

---

## 8. What this phase doesn't do

Listed so we don't pretend otherwise:

- **Per-(mode × context) acoustic profiles.** §1.3. Wait for more data.
- **Audio features for tracks not in our taste model.** Backfill is taste-model-scoped. A fresh-pool candidate without features will get `acoustic_fit = 1.0` until it enters the taste model (which requires being played at least once) and the next backfill round. This is a known cold-start gap. Acceptable because: fresh pool candidates are evaluated against taste primarily, and acoustic fit is a tiebreaker, not a primary signal.

  *Future improvement (not scheduled):* extend backfill to also cover fresh_pool tracks. Adds load to ReccoBeats but tightens the loop.

- **A second audio features provider.** Architecture allows it (§1.7), but no second provider is wired up. SoundStat is the obvious option if ReccoBeats becomes unavailable.

- **Reddit-based discovery.** §1.4 notwithstanding, Reddit's free-text format defeats the regex extractor. Would need a different parsing approach (LLM-based?). Not scheduled.

- **MusicBrainz integration.** Useful for canonical artist IDs and ISRC verification, but not on the critical path. Add later if dedup proves fragile.

- **ListenBrainz.** Open-source alternative to Last.fm. Not as mature; revisit if Last.fm changes terms.

- **Tuning the acoustic_fit weights.** Initial values are conservative. Real tuning happens after M20 has produced data.

---

## 9. Open questions tracked through this phase

Each milestone's prompt includes "update OPEN_QUESTIONS.md" as a step. Items that should accumulate there:

- Acoustic profile granularity (M17): when to slice by (mode × context)
- Fresh pool audio features coverage (post-M20): worth backfilling?
- Acoustic fit weight tuning (post-M20): adjust [0.7, 1.4] clamp based on observed session behavior
- ReccoBeats failure handling: what happens if the service goes down? Currently we just stop backfilling; old features stay. Acceptable.
- Last.fm cache TTL: 7 days is a guess. Tune based on whether discovery freshness suffers.

---

*End of M16-M20 plan document.*
