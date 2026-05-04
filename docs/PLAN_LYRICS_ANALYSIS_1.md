# Lyrics Analysis & Taste-Prediction

> **PIVOT (2026-05-04):** The lyric-analysis experiment (`docs/experiments/lyric-analysis-2026-05/results.md`) confirmed H1 (analysis quality) but H2 and H3 both failed — lyric similarity does not predict taste (ρ=0.034), and the hybrid ranking was worse than existing alone (Δ=-0.07). Per the pre-registered decision tree in `PLAN_LYRICS_ANALYSIS_EXPERIMENT.md` §1, this plan is now scoped to a **transparency layer only**: queryable analysis fields, "Why this song?" panel, and lyric-similarity search. The recommender (§6), Phase 1.5 (`listener_feel_chris`), and the `recommend_by_lyrics` MCP tool are struck. See `PLAN_LYRICS_TRANSPARENCY_PIVOT.md` for the full rationale and revised architecture.

Add per-track lyric analysis to Surfaces, keyed on `spotify_track_uri`. Source-of-record is Claude Sonnet 4.6 (text) + Voyage-3.5 (embeddings) for lyrics analysis; Gemini 2.5 Flash Native Audio (Phase 2 only) for vocal-delivery analysis on a small high-value subset. Compute is ~~a one-shot batch container~~ a lazy on-demand pipeline on grimmauldplace; ongoing capture is a chained cron every 10 minutes.

This is additive — nothing in the existing tracker, taste model, curation, discovery, or lyrics-backfill code changes. It builds on top of `track_lyrics` (status=`ok`) the same way `track_lyrics` builds on top of `plays`.

The previous lyrics+credits doc (`docs/PLAN_LYRICS_CREDITS_1.md` §7) explicitly defers "lyrics analysis (theme detection, TF-IDF, embeddings clustering)" to a separate project once the data is in place. This is that project.

---

## 0. Why now, and why this is worth a milestone

The CLAUDE.md capability priorities are (in order): lost-favorites rediscovery, smart queues with skip-aware feedback, time-machine memory queries. None of those *require* lyric analysis. So the case for sequencing this in has to be made on what it unlocks downstream:

- **Smart queues get a "why" they don't have today.** The current taste signal is behavioral (plays/skips/replays/library/seasonal) plus acoustic (ReccoBeats centroids per mode). It can't say "you don't like this song because the lyric subject is breakup-with-self-blame and that pattern shows up in your skips." Lyric-based explanations close that loop.
- **Lost-favorites get smarter.** Today the candidate pool is just "≥20 plays, not heard in 2+ years." With lyrics, it can also be "songs whose subject/feel matches what you've been obsessing over this season."
- **Discovery gets a third axis.** Today's fresh_pool scoring is taste-of-primary-artist plus a few editorial sources. Adding lyric-vibe similarity to the obsession centroid reveals candidates that share the *thing* you like about your favorites, not just the artist graph.
- **The data is already there.** ~9,500 of 47,650 tracks have ok lyrics today; backfill continues nightly. Building on the existing `track_lyrics` pipeline is much cheaper than building a parallel one.

If the priority feels wrong — e.g. lost-favorites and time-machine should ship first — defer. The plan stands either way; analysis can run on whatever subset of `track_lyrics(status='ok')` exists at trigger time.

---

## 1. Architecture decisions (short version)

| Decision | Choice | Why |
|---|---|---|
| Where compute runs | New container `stack/lyrics-analysis/` on grimmauldplace | Same pattern as the proven `stack/lyrics-backfill/`. Worker can't run multi-second LLM batches inside the 30s CPU limit. |
| Storage | D1 — three new tables alongside `track_lyrics` | Stays inside the existing schema; no Postgres, no Vectorize binding required for v1. |
| LLM | Claude Sonnet 4.6 via Anthropic Message Batches API | Sonnet over Haiku: the pipeline's value depends on nuanced tone/emotion extraction. Batch API is 50% off, prompt caching stacks on top. ~$290 one-time for 47K tracks. |
| Embeddings | Voyage-3.5-lite, 512-D, stored as BLOB in D1 | First 200M tokens free covers our entire catalog. BLOB + JS-side cosine on a centroid query stays well under 30s for 47K vectors. |
| Vector search | JS cosine over an in-memory load of all embeddings, lazy-loaded into a Worker `caches.default` for warm hits | No Vectorize subscription needed; D1 read of 47K × 512 fp16 = ~48MB ≈ borderline but cacheable. If it bites, fall back to Cloudflare Vectorize (free tier covers our scale). |
| Audio analysis | Phase 2 only. Deezer-by-ISRC for previews + Gemini 2.5 Flash Native Audio. ISRC is already cached in `track_lyrics.isrc`. | Claude doesn't accept audio input as of May 2026. Gemini Flash audio at ~$0.0036 per 30-sec clip is cheap on the obsession tier (~500 tracks). |
| User-facing aggregation | Always song-level (`track_name COLLATE NOCASE, artist_name COLLATE NOCASE`). Internal queue ops stay URI-level. | Per LISTENING_HISTORY.md "URI vs song-level queries" rule. Re-releases with different URIs share lyrics; analysis attaches to URI but is rolled up to song for any human-shown view. |
| Provenance | Every new MCP tool response and dashboard view tagged `From local history` (analysis is computed offline against `track_lyrics`, derived from your library). | Per CLAUDE.md "Surface data-source provenance" rule. |
| Tests | vitest with `@cloudflare/vitest-pool-workers` for Worker-side helpers; standard vitest for container-side. | Matches existing pattern. |

---

## 2. Sources and external dependencies

### Anthropic Claude API (lyrics analysis)
- Claude Sonnet 4.6 (`claude-sonnet-4-6-20250514`), $1.50/$7.50 per MTok input/output. Batch API halves both. Prompt caching reduces cached system-prompt input to ~5% of standard. Sonnet over Haiku because the whole pipeline's value depends on nuanced tone/emotion extraction — saving $190 on a one-time batch isn't worth degraded taste predictions.
- Message Batches API: ≤10K requests per batch, ≤24h turnaround. Our catalog fits in 5 batches.
- Library: `@anthropic-ai/sdk` (Node-compatible; container only — Worker bundle stays untouched).
- Auth: `ANTHROPIC_API_KEY` as a Docker secret on grimmauldplace; never on Workers.

### Voyage AI embeddings
- `voyage-3.5-lite`, 512-D, $0.06/1M tokens (first 200M tokens free).
- Anthropic's recommended embedding partner; same SDK pattern.
- Auth: `VOYAGE_API_KEY` as a Docker secret on grimmauldplace.

### Deezer (Phase 2 — preview audio)
- Free, no auth for catalog lookups.
- Endpoint: `GET https://api.deezer.com/track/isrc:{isrc}` returns metadata including `preview` (30-sec MP3 URL).
- Coverage expectation: 80–95% of major-label catalog; lower for indie. ISRC match is precise; no fuzzy match needed.

### Gemini API (Phase 2 — vocal-delivery analysis)
- `gemini-2.5-flash` native audio input, $3/1M audio tokens at 25 tokens/sec ≈ $0.0036 per 30-sec preview.
- Used only on the obsession-tier subset (~500 tracks) and on borderline recommendations on demand.
- Auth: `GEMINI_API_KEY` as a Docker secret.
- Same architectural argument as Anthropic — container-only.

---

## 3. Schema

Three new tables. Migration `009_lyrics_analysis.sql` (next available number after `008_hello_heartbeat.sql`).

```sql
-- =========================================================
-- LYRIC ANALYSIS (one row per analyzed URI)
-- =========================================================
CREATE TABLE IF NOT EXISTS track_lyric_analysis (
  spotify_track_uri TEXT PRIMARY KEY,

  -- Asked-for core fields
  subject_paragraph TEXT NOT NULL,            -- 2-4 sentences: narrator/setting/action/resolution
  subject_tags TEXT NOT NULL,                 -- JSON array of 3-6 short noun phrases
  listener_feel_generic TEXT NOT NULL,        -- JSON: {valence, arousal, dominance, primary_emotion, secondary_emotions, intensity, ambivalence}
  listener_feel_chris TEXT,                   -- JSON, populated in Phase 1.5 once obsession centroid exists
  tones TEXT NOT NULL,                        -- JSON array of 2-5 tone labels
  language TEXT NOT NULL,                     -- BCP-47, e.g. 'en'

  -- Narrative
  narrative_pov TEXT,                         -- 'first' | 'second' | 'third' | 'mixed'
  addressed_to TEXT,                          -- 'lover' | 'self' | 'friend' | 'family' | 'god' | 'crowd' | 'enemy' | 'abstract' | 'none'
  time_frame TEXT,                            -- 'present' | 'retrospective' | 'prospective' | 'timeless'
  story_arc TEXT,                             -- one sentence
  narrator_reliability TEXT,                  -- 'straight' | 'ironic' | 'unreliable' | 'persona'

  -- Sonic-adjacent (lyric-inferred; Phase 2 audio pass overrides)
  vocal_delivery_inferred TEXT,               -- JSON array
  tempo_feel TEXT,                            -- 'dragging' | 'slow' | 'mid' | 'driving' | 'frantic'
  energy_curve TEXT,
  dynamic_range TEXT,                         -- 'flat' | 'moderate' | 'wide'

  -- Cultural & lexical
  vocab_level TEXT,                           -- 'simple' | 'colloquial' | 'literary' | 'arcane'
  slang_era TEXT,                             -- JSON array
  references_json TEXT,                       -- JSON: {people, places, brands, works}
  explicitness REAL,                          -- 0-1
  content_flags TEXT,                         -- JSON array
  quotability INTEGER,                        -- 0-10

  -- Structural
  rhyme_scheme TEXT,
  repetition_density REAL,
  chorus_verse_balance REAL,
  line_length_variance REAL,
  has_bridge INTEGER,
  structure_signature TEXT,

  -- Activity-fit (Phase 1.5)
  activity_fit TEXT,                          -- JSON: {deep_work, creative_ideation, code_review, brainstorm, debugging, writing, reading, low_focus_admin}
  lyric_intrusion REAL,                       -- 0-1, "how much lyrics demand attention"

  -- Provenance
  analyzed_at INTEGER NOT NULL,
  analysis_version TEXT NOT NULL,             -- semver of the prompt
  model_id TEXT NOT NULL,                     -- 'claude-sonnet-4-6-20250514'
  lyrics_hash TEXT NOT NULL,                  -- sha256 of lyrics_plain at analysis time

  -- Phase 2 audio enrichment (nullable)
  audio_analyzed_at INTEGER,
  audio_features_inferred TEXT,               -- JSON
  audio_source TEXT                           -- 'deezer:gemini-2.5-flash' | null
);
CREATE INDEX IF NOT EXISTS idx_lyric_analysis_lang ON track_lyric_analysis(language);
CREATE INDEX IF NOT EXISTS idx_lyric_analysis_version ON track_lyric_analysis(analysis_version);

-- =========================================================
-- LYRIC EMBEDDINGS (BLOB-stored Voyage vectors)
-- =========================================================
-- Two embeddings per track:
--   'lyrics'   = embedding of lyrics_plain (literal language similarity)
--   'analysis' = embedding of subject_paragraph || tones || emotion JSON (vibe similarity)
-- Stored as Float32Array BLOBs (512 dims × 4 bytes = 2KB each).
CREATE TABLE IF NOT EXISTS track_lyric_embedding (
  spotify_track_uri TEXT NOT NULL,
  kind TEXT NOT NULL,                         -- 'lyrics' | 'analysis'
  vector BLOB NOT NULL,                       -- Float32Array(512)
  model TEXT NOT NULL,                        -- 'voyage-3.5-lite'
  embedded_at INTEGER NOT NULL,
  PRIMARY KEY (spotify_track_uri, kind)
);

-- =========================================================
-- ANALYSIS BACKFILL STATUS (independent of track_lyrics status)
-- =========================================================
-- Mirrors the three-state pattern used by track_credits_status: lets the
-- batch worker distinguish "never analyzed" from "tried, returned junk".
CREATE TABLE IF NOT EXISTS track_lyric_analysis_status (
  spotify_track_uri TEXT PRIMARY KEY,
  status TEXT NOT NULL,                       -- 'ok' | 'instrumental' | 'too_short' | 'parse_error' | 'pending'
  last_attempted_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_lyric_analysis_status ON track_lyric_analysis_status(status);
```

**Why a separate `_status` table:** matches the existing `track_credits_status` pattern. Lets the batch retrieve `WHERE status IN ('pending', 'parse_error') AND attempts < 3` without scanning `track_lyric_analysis` itself.

**Why store embeddings as BLOB rather than JSON:** 512 floats as JSON is ~6KB; as Float32Array BLOB it's 2KB. At 47K rows × 2 embeddings = ~190MB total. JSON would put us at ~570MB and break D1 query response sizes.

**Why keep `subject_tags` etc. as JSON-text columns rather than separate tables:** every consumer reads the whole row. Normalizing tags into `track_lyric_subject_tags(uri, tag)` would be queryable but the only query that needs it ("songs tagged X") can be answered in JS over a single `SELECT subject_tags`. Defer the normalization to a Phase 3 if it actually proves useful for filter UIs.

---

## 4. Files to create

```
scripts/
  analyze-lyrics.ts             # local one-shot driver, mirrors backfill-lyrics.ts shape

src/
  lyrics_analysis/
    schema.ts                   # zod-style runtime validators for the JSON columns
    prompt.ts                   # the system prompt + JSON output schema
    types.ts                    # LyricAnalysis, EmbeddingKind, etc.
    similarity.ts               # cosine, taste-vector centroid math (Worker-side, hot path)
    recommend.ts                # rank candidates against taste vector, optional Sonnet explain pass
  db/
    migrations/
      009_lyrics_analysis.sql

  mcp/
    tools.ts                    # add 4 new tools (see §6)
  index.ts                      # add /api/lyric-recommend, /api/song-explain (see §7)

stack/
  lyrics-analysis/              # mirrors stack/lyrics-backfill/ shape
    Dockerfile
    docker-compose.yml
    package.json                # @anthropic-ai/sdk, voyageai, tsx
    main.ts                     # dispatcher: 'analyze' | 'embed' | 'audio' subcommands
    phase-analyze.ts            # batch lyrics → analysis JSON via Anthropic Message Batches
    phase-embed.ts              # voyage embeddings for lyrics + analysis text
    phase-audio.ts              # Phase 2 only: Deezer fetch + Gemini transcribe (obsession tier)
    lib/
      d1.ts                     # SHARED with stack/lyrics-backfill — symlink or copy
      anthropic-batch.ts        # batch submission, polling, result parse
      voyage.ts                 # embedding client with chunking
      taste-cohort.ts           # build the obsession-tier seed list from track_taste

dashboard/
  index.html                    # add a "Why this song?" panel + lyric-vibe similarity widget
```

Keep `src/lyrics_analysis/` parallel to `src/lyrics/` and `src/audio/` — same shape pattern (client + types + helpers).

---

## 5. The pipeline

Three phases, restartable, each writes to D1 via the same HTTP API pattern as `lyrics-backfill`.

### Phase 1: Bulk lyric analysis
- **Input:** every URI in `track_lyrics WHERE status='ok' AND lyrics_plain IS NOT NULL` not already in `track_lyric_analysis_status` with `status='ok'`.
- **Filtering:** skip rows where `lyrics_length < 50` (likely junk match) — write `track_lyric_analysis_status` row with `status='too_short'`. Skip `instrumental=1` — write `status='instrumental'`.
- **Build batch request:** one Anthropic Message API call per song. System prompt + JSON schema is identical across all songs (cache hit on every call after the first).
- **Submit:** Anthropic Message Batches API in 10K-request chunks. ~5 batches. Each batch returns within 24 hours.
- **Parse:** validate output against a strict zod-style schema. On parse failure, retry once at temperature 0.2; on second failure, write `status='parse_error'` with the error in `last_error`.
- **Pacing:** Anthropic batch handles pacing. Container itself is just submit + poll + write.
- **Coverage report:** `total / ok / instrumental / too_short / parse_error / pending`.

### Phase 2: Embeddings
- **Input:** every URI in `track_lyric_analysis WHERE NOT EXISTS (SELECT 1 FROM track_lyric_embedding WHERE spotify_track_uri = X AND kind = 'lyrics')`.
- **Per song, embed twice:**
  - `kind='lyrics'`: embed `lyrics_plain` (truncated to 8K tokens for safety).
  - `kind='analysis'`: embed `subject_paragraph || ' ' || tones || ' ' || JSON.stringify(listener_feel_generic)`.
- **Voyage batch endpoint** accepts up to 128 inputs per call. Process in chunks.
- **Store as Float32Array BLOB.**
- **Idempotent:** safe to rerun; existing rows skipped.

### ~~Phase 1.5: Predicted-Chris-feel + activity-fit~~ [STRUCK — see pivot]
> **Killed.** `listener_feel_chris` and `activity_fit` both depended on centroid infrastructure that no longer exists. The text-profile alternative was rejected as paraphrasing theater. Ship `listener_feel_generic` for now; revisit personalization with evidence about what texture is actually missing. `lyric_intrusion` is retained (has a consumer in focus-block cold-start rules, `src/context/rules.ts`).

### Phase 2 (optional, after Phase 1+1.5 prove value): Audio enrichment
- **Tier:** obsession-only at first (~500 tracks). Expand if it pays off.
- **Per track:** look up `track_lyrics.isrc`, fetch Deezer preview URL, download MP3 to a tmpfile, send to Gemini 2.5 Flash with a vocal-delivery prompt, parse JSON, write to `audio_features_inferred`.
- **Cost:** ~$2 for 500 tracks. Cheap.
- **Open question:** whether to re-fold audio findings back into `tones`/`vocal_delivery_inferred` or keep them in their own column. Recommend: keep separate (`audio_features_inferred`), let downstream code prefer audio when present.

---

## ~~6. The recommender~~ [STRUCK — see pivot]

> **Killed.** The experiment (H2: ρ=0.034, H3: Δ=-0.07) showed lyric similarity does not predict taste. The entire recommender — centroid math (§6.1), scoring/ranking (§6.2), Sonnet explanation pass (§6.3), and listening-history cohort builder (§6.4) — is removed. Files `src/lyrics_analysis/similarity.ts` and `src/lyrics_analysis/recommend.ts` will not be created. The nightly centroid-rebuild cron and `/api/lyric-recommend` route are dropped.
>
> The embeddings in `track_lyric_embedding` are retained — they serve `find_similar_lyrics` (track-to-track cosine, a different task than centroid-based recommendation) and `lyric_search` (free-text → embedding search).

---

## 7. MCP tools and dashboard surfaces

Both surfaces are first-class per CLAUDE.md.

### 7.1 New MCP tools (added to `src/mcp/tools.ts`)

| Tool | Args | Returns |
|---|---|---|
| ~~`recommend_by_lyrics`~~ | ~~`{count?: number, mode?: string, language?: string}`~~ | ~~Ranked array~~ **[STRUCK — recommender killed]** |
| `explain_song` | `{uri: string}` | `{subject_paragraph, tones, listener_feel_generic, source}` |
| `find_similar_lyrics` | `{seed_uri: string, count?: number}` | Tracks whose lyric/analysis embedding is closest to seed |
| `lyric_search` | `{query: string, count?: number}` | Free-text query embedded via Voyage, ranked against `lyrics_embedding` |

All three MUST include the `source` field. Per CLAUDE.md: lyric analysis is derived from local data, so `source: 'local-history-derived'` is the right tag (distinct from "local-history" which means `streams.feather`-direct, and from "spotify-live").

### 7.2 New dashboard sections

Two additions to `dashboard/index.html`:

1. **"Why this song?" panel on Now Playing.** When a track is currently playing, show its `subject_paragraph`, `tones`, `primary_emotion` from `listener_feel_generic`. Loaded from `/api/song-explain?uri=X`.
2. **"Lyric vibe twins" widget.** Shows the 5 tracks closest to the currently-playing track in the analysis embedding space. Each row clickable to queue. Loaded from `/api/find-similar-lyrics?uri=X`.

Both panels carry a small "From local history (analyzed)" badge per the provenance rule.

### 7.3 New API routes

| Route | Method | Description |
|---|---|---|
| `/api/song-explain` | GET | Frontend for `explain_song` MCP tool |
| `/api/find-similar-lyrics` | GET | Frontend for `find_similar_lyrics` |
| ~~`/api/lyric-recommend`~~ | ~~GET~~ | ~~Frontend for `recommend_by_lyrics`~~ **[STRUCK]** |

---

## 8. Cron additions

> **Revised (pivot):** No new Worker crons. The centroid-rebuild cron and Phase 1.5 weekly refresh are both struck. The only new cron is a **grimmauldplace host cron** that chains lyrics-backfill → analysis → embedding every 10 minutes. See `PLAN_LYRICS_TRANSPARENCY_PIVOT.md` §4.3 and §6.2 for the chained cron design.

```bash
# grimmauldplace crontab — every 10 minutes
*/10 * * * * cd ~/stack && \
  docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 20 && \
  docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis analyze --limit 50 && \
  docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis embed --limit 50
```

---

## 9. Match quality safeguards

Things that will silently corrupt the data if we don't guard against them:

1. **LRCLIB returned the wrong song.** Already caught at backfill time (see PLAN_LYRICS_CREDITS_1 §5). But: Phase 1 should re-validate by checking that the LLM's `subject_paragraph` mentions an artist or title term that matches the track. Simple regex check; logs warnings, doesn't reject — too noisy to reject and we'd lose real obsession-tier songs to false positives.
2. **Hallucinated subject for placeholder lyrics.** Some LRCLIB rows are placeholder-only ("Instrumental" written out, or "Lyrics coming soon"). Phase 1 should reject any row where `lyrics_plain` is < 50 chars or contains only a single repeating phrase. Write `status='too_short'`.
3. **Language detection failure.** Voyage and Claude both handle multilingual but tagging matters for filtering. Run a simple script-based detector (`Intl.Segmenter` is enough for Latin vs CJK vs Cyrillic vs Arabic) at analysis time. Tag as 'unknown' if ambiguous; don't guess.
4. **Cover versions inheriting wrong analysis.** If two URIs map to the same `(track_name, artist_name)` after collation but one is a remix, they should get *separate* analyses (lyrics may differ in remix; tones definitely differ). Don't dedup at analysis time. Per LISTENING_HISTORY.md anti-pattern: track URIs are the truth.
5. ~~**Centroid drift if the obsession set is empty.**~~ [STRUCK — no centroids in transparency-only mode.]

---

## 10. Coverage targets and what counts as success

> **Revised (pivot):** Recommender quality metrics are struck. Success criteria are now about analysis quality and transparency-layer latency.

- **Analysis:** ≥95% of input rows yield `track_lyric_analysis_status='ok'`. Spot-check 20 random analyses: subject_paragraph should be specific (mentions concrete imagery from the lyric, not generic adjectives like "love and loss"). `listener_feel_generic.valence` should agree with intuition on 18+ of 20 spot checks.
- **Embeddings:** 100% of analyzed rows have both `kind='lyrics'` and `kind='analysis'` embeddings.
- ~~**Recommender quality:**~~ [STRUCK — no recommender.]
- **Latency:** `/api/song-explain?uri=X` returns in <200ms p95 from a warm Worker for pre-analyzed tracks. `find_similar_lyrics` returns in <800ms p95.
- **Twins coherence (gates dashboard widget):** ≥70% of twin pairs judged coherent+partial in the 20-seed validation. See `PLAN_LYRICS_TRANSPARENCY_PIVOT.md` §7.

If analysis coverage on the obsession-tier eager batch is below 90%, stop and reassess prompts before expanding.

---

## 11. Cost model

> **Revised (pivot):** Full-catalog batch is replaced by lazy on-demand analysis. See `PLAN_LYRICS_TRANSPARENCY_PIVOT.md` §5 for detailed breakdown.

Avg lyrics ≈ 600 tokens input. Avg analysis output ≈ 650 tokens (reduced from 700 — `activity_fit` removed). System prompt ≈ 200 tokens (cached after first call at $0.30/MTok).

| Line item | Cost |
|---|---|
| **Obsession-tier eager batch (~800 tracks, one-time, batch pricing)** | **~$5.60** |
| **Voyage embeddings (2× per track, one-time)** | **$0** (free tier) |
| **Ongoing on-demand (~260 tracks/month, sync pricing)** | **~$2.86/month** |
| **Monthly steady-state** | **~$3/month ≈ $36/year** |

Per-track cost breakdown: system prompt cached at $0.30/MTok (negligible), lyrics uncached at $1.50/MTok (~$0.0009), output at $15/MTok (~$0.010). Total ~$0.011/track.

Compare to the original plan: $148 one-time + $8/month ($244/year). The transparency-only model is ~96% cheaper up front and ~85% cheaper annually.

---

## 12. Risks and decisions to make

| Risk | Mitigation |
|---|---|
| Lyrics copyright in storage. We're storing 47K sets of full lyrics in D1 (already a current state via `track_lyrics`). | Out of scope to fix here; flagged in PLAN_LYRICS_CREDITS_1.md. The analysis we add is derivative, much safer to store than raw lyrics, and could potentially let us drop `lyrics_plain` storage later (re-fetch from LRCLIB on demand using `isrc` + match). Future cleanup. |
| Anthropic batch latency. Up to 24h per batch means a fresh full backfill takes 5 days end-to-end. | Acceptable for a one-time job. Ongoing nightly catch-up handles ≤200 new tracks/night, well within batch latency. |
| Worker cold-load of 47K embeddings. ~190MB in D1; D1 query response is capped (~10MB per result). Need pagination or compression. | Use Float16 on disk (1KB per embedding, ~95MB total) — Voyage supports int8/binary quantization with minimal recall loss. If still too big, split by `language` and load only the relevant slice. Final fallback: Cloudflare Vectorize binding (free tier covers our scale). |
| Generic listener_feel ≠ Chris's feel. The known weakness of lyric-only emotion models is the gap between text and what the song actually does. | Acknowledged. `listener_feel_generic` is what ships. If the panel feels too generic, revisit personalization with evidence about what texture is missing. Phase 2 (audio) could help if revisited. |
| Multilingual catalog of unknown size. We don't yet know language distribution. | Run a one-shot `langdetect`-equivalent over the existing 9,500 lyrics in `phase-analyze.ts`'s dry-run mode before kicking off the real batches. Decide translate-vs-analyze-in-place from the result. |
| ~~Centroid stability.~~ | [STRUCK — no centroids.] |
| ~~The 14 evergreen artists shouldn't dominate.~~ | [STRUCK — no recommender ranking to bias.] |

---

## 13. What needs to happen before any code

1. **Confirm priority sequencing.** Lyric analysis isn't currently in the top-3 of CLAUDE.md. If lost-favorites and time-machine should ship first (as the priority list says), defer this and revisit when those land.
2. **Hand-pick 20 obsession-tier songs.** I can run them through a draft of the Phase 1 prompt and we iterate on the JSON output before scaling. Cheap (under $0.50) and catches prompt-quality issues that look fine on 1 song but fail on 20.
3. **Decide on Cloudflare Vectorize from the start vs. defer.** D1 BLOB + JS cosine should work; Vectorize is an easier-but-paid alternative. Recommend: BLOB for v1, Vectorize as a clean migration path if §12's cold-load risk hits us.
4. **Approve the schema in §3.** It's additive but it's three new tables — once data starts landing, schema changes get more expensive.

Once those four are settled, Phase 1's container can be scaffolded by reusing 80% of `stack/lyrics-backfill/` shape.

---

## 14. Out of scope for this build (deferred)

- **Vocal-delivery LLM analysis on the full catalog.** $170+ at full scale; only worth it if Phase 2 on the obsession tier proves the explanations are meaningfully better than text-only.
- **MERT / open-source music embeddings.** A second audio embedding source. Strong complement but adds GPU dependency (grimmauldplace can run it but slowly). Defer until audio analysis proves its worth.
- **Cross-artist songwriter affinity.** With `track_credits` populated, "songs by writers I like" is a real query. Lives at the intersection of this plan and the credits work; build it after both have shipped.
- **Playlist-level mood targeting.** "Build me a 90-min set that arcs from melancholy to defiant." Live recommender is the foundation; mood-arc curation is a follow-on for the curation agent.
- **Reverse search.** "Find me the song where the narrator says X." Solvable with the lyrics embedding but uses a different query path. Add when there's demand.

---

## 15. What changes outside this plan

Genuinely: very little. The intent is for this to land cleanly atop the existing system.

- ~~`wrangler.toml` gains 1 cron line.~~ [No new Worker crons — grimmauldplace cron only.]
- `src/index.ts` gains 2 new routes (`/api/song-explain`, `/api/find-similar-lyrics`).
- `src/mcp/tools.ts` gains 3 new tools (`explain_song`, `find_similar_lyrics`, `lyric_search`).
- `dashboard/index.html` gains 2 panels (vibe twins gated on validation).
- Three new D1 tables + two migration files (009 + 010 deprecation).
- One new container directory (`stack/lyrics-analysis/`).

No changes to: tracker, taste model, curation agent, discovery agent, context capture, audio profile, feedback loop, OAuth, KV layout, existing MCP tools, existing dashboard sections, existing crons.
