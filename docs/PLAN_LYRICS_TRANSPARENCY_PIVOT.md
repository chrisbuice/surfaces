# Lyrics Analysis — Transparency-Layer Pivot

**Context:** The lyric-analysis experiment (May 2026) confirmed H1 (Sonnet produces specific, accurate analyses) but H2 and H3 both failed. Lyric similarity does not predict taste (ρ=0.034 vs threshold 0.20, n=91), and the hybrid ranking was worse than existing alone (Δ=-0.07). Per the pre-registered decision tree in `PLAN_LYRICS_ANALYSIS_EXPERIMENT.md` §1, this is the "H1 passes, H2 fails" branch.

**Decision:** Ship Phase 1 as a transparency layer only. No recommender, no centroid math, no hybrid scoring. The analysis fields are queryable and the "Why this song?" panel is worth shipping — but the ranker is dead.

This plan revises `PLAN_LYRICS_ANALYSIS_1.md` and the `stack/lyrics-analysis/` scaffolding to match that decision.

---

## 1. Revisions to PLAN_LYRICS_ANALYSIS_1.md

### 1.1 Section 6 (The recommender) — gut it

**Remove entirely:**
- §6.1 Taste vectors (obsession/dislike centroids in KV)
- §6.2 Score-and-rank (cosine scoring, hard filters, never-stale-core boost in ranking context)
- §6.3 Always-explain (Sonnet explanation pass on top-K ranked candidates)
- §6.4 Local listening history integration for obsession-cohort building
- `src/lyrics_analysis/similarity.ts` (centroid math)
- `src/lyrics_analysis/recommend.ts` (rank candidates against taste vector)
- `/api/lyric-recommend` route
- The nightly KV centroid-rebuild cron in `wrangler.toml`

**Keep:**
- The "Why this song?" panel (§7.2 item 1) — but fed by the analysis row directly, not by a recommendation explanation pass. The panel shows `subject_paragraph`, `tones`, `primary_emotion` for the currently-playing track. Uses `listener_feel_generic` (see §1.2 for why `listener_feel_chris` is deferred).
- The "Lyric vibe twins" widget (§7.2 item 2) — with a validation gate before shipping. See §3 for the argument and validation sketch.

### 1.2 Section 1.5 (predicted-Chris-feel) — kill

`listener_feel_chris` was a second Sonnet pass that predicted personalized emotion given the obsession/dislike centroids. The recommender that consumed those centroids is dead. A text-profile-based alternative (Sonnet reads "your obsession set clusters around X" and writes "this matches your X register") was considered and rejected — it's the model paraphrasing a profile back at you, not real personalization. Real personalization needed real centroids; without them it's theater.

**Decision:** Kill `listener_feel_chris` from this iteration. Ship the panel with `listener_feel_generic`. If the panel feels too generic in actual use, revisit with evidence about what specific texture is missing — which is the right time to design a personalization layer, not now.

**Remove:** the entire Phase 1.5 pipeline, the quarterly re-run cron on grimmauldplace, and stop populating the `listener_feel_chris` column.

### 1.3 Section 7 (MCP tools) — drop one, keep three

| Tool | Verdict | Reason |
|---|---|---|
| `explain_song` | **Keep** | Shows analysis fields for a URI. Core of the transparency layer. |
| `find_similar_lyrics` | **Keep (with validation gate)** | Cosine between two specific tracks' embeddings. See §1.4–1.5. |
| `lyric_search` | **Keep** | Free-text query embedded via Voyage, ranked against `lyrics` embeddings. Useful for "find me a song about X." |
| `recommend_by_lyrics` | **Drop** | Was the recommender's MCP surface. Dead. |

### 1.4 Section 11 (cost model) — replace with lazy-analysis model

The old cost model assumed a $148 one-time batch of 47K tracks. That's not justified when the only consumers are transparency panels and MCP queries on tracks the user is actively looking at.

New model: **analyze on first surface, batch the obsession tier eagerly.**

See §4 below for the trigger design and §5 for the revised cost projection.

### 1.5 activity_fit — kill. lyric_intrusion — keep.

These are different fields with different consumers. Unbundled:

**`activity_fit`** (JSON: deep_work, creative_ideation, code_review, etc.) was designed for the recommender's mode-aware filtering (§6.2: "For activity-fit recommendations, `activity_fit[mode] > 0.3`"). The recommender is dead; `activity_fit` has no other consumer. **Kill it.** Remove from the prompt and stop populating.

**`lyric_intrusion`** (0–1, "how much the lyrics demand attention") has a real consumer today: the focus-block cold-start rule in `src/context/rules.ts`. The current rule (lines 172–181) uses completion rate as a proxy for "not distracting during focus blocks." That's indirect — a song can have a high completion rate because it's great, not because it's unobtrusive. `lyric_intrusion` is the direct signal: low intrusion = lyrics fade into background, high intrusion = lyrics demand parsing. This is exactly what focus-block bias should weight against.

The field costs ~3 output tokens per track (trivial) and serves a planned consumer in the smart-queue pipeline. **Keep it.** Continue populating in the prompt.

---

## 2. Schema changes (migration 009)

The migration has already been applied to D1 (it shipped with the Phase 1 scaffolding commit `4411be7`). Changes are column removals, which in SQLite/D1 means we either (a) leave the columns in place and stop writing to them, or (b) recreate the table.

**Recommended approach: leave columns, stop writing.** SQLite doesn't support `ALTER TABLE ... DROP COLUMN` cleanly across all versions, and D1's SQLite is version-locked. The unused columns cost nothing in storage (NULL) and nothing in queries (not selected). Add a comment in the migration file and a `-- DEPRECATED` note.

Columns to stop populating:
- `listener_feel_chris` — was Phase 1.5, killed (see §1.2)
- `activity_fit` — was recommender mode-filter, killed

Columns to keep as-is:
- `lyric_intrusion` — kept; consumer in focus-block cold-start rules
- Everything else in `track_lyric_analysis` — the transparency layer reads these
- `track_lyric_embedding` — `find_similar_lyrics` and `lyric_search` need it
- `track_lyric_analysis_status` — unchanged

**New migration 010:** A short migration that adds deprecation comments on `listener_feel_chris` and `activity_fit` (SQL comments only — no DDL changes).

---

## 3. Defending (or gating) the "Lyric vibe twins" widget

### 3.1 Why H2's failure doesn't automatically kill twin-finding

H2 tested whether cosine similarity to a **50-song centroid** predicts taste across **200 unheard songs**. That's a recommender task: "given your aggregate taste profile, rank strangers." It failed (ρ=0.034).

Twin-finding is a different task: "given *this specific song*, find songs with similar lyric content." The user isn't asking "will I like these?" — they're asking "what sounds like this?" The quality bar is "do the twins share subject matter, tone, and narrative feel with the seed?" not "does the user rate them highly."

The analogy: Google "related articles" works even though Google can't predict which articles you'll enjoy. Relatedness and preference are different axes.

**However:** this argument is plausible but unproven. We have the data to test it cheaply before shipping. Don't ship on vibes alone.

### 3.2 Cheap validation using existing experiment data

We have 250 analyzed + embedded tracks (50 obsession seeds + 200 candidates) and 91 blind ratings. That's enough for a quick sanity check:

**Test:** For each of the 91 rated tracks, compute its 5 nearest neighbors by `analysis` embedding cosine among the other 249 tracks. Then check:

1. **Subject coherence:** For 20 randomly sampled seed tracks, manually inspect: do the 5 twins share subject matter / tone / narrative feel? Score as "yes/partial/no" per twin. Pass threshold: ≥70% yes+partial. This directly tests whether the embeddings capture lyric similarity, which is what the widget promises.

2. **Rating-concordance (bonus, not gating):** Among the 91 rated tracks, when a seed and its twin are both rated, compute the mean absolute rating difference. Compare against the mean absolute difference of random pairs. If twins have a smaller gap, that's a nice signal. If not, it doesn't kill the widget (concordance = preference, which we already know embeddings don't predict), but it's worth knowing.

**Cost:** Zero — all data exists. One script (~50 lines), ~30 minutes of manual inspection on the 20-song sample.

**Gate:** If test 1 fails (<70% coherent twins), don't ship the widget. Keep `find_similar_lyrics` as an MCP tool only (where the user can judge relevance in context) and revisit after we understand why the embeddings aren't capturing relatedness.

**Sequence:** Run this validation before building the dashboard widget (step 7 in the work sequence). The MCP tool and the Worker-side plumbing proceed regardless — the validation only gates the dashboard surface.

---

## 4. The lazy-analysis trigger

### 4.1 Architecture

There is no Worker→container push (per OFFLOAD_PLAN_1.md: "No message queue. The cron-and-HTTP pattern is the architecture."). The trigger pattern is:

1. **Worker receives a request** that needs analysis (dashboard "Why this song?" panel, `explain_song` MCP tool call, `find_similar_lyrics` query where the seed has no analysis).
2. **Worker checks D1** for `track_lyric_analysis_status` on that URI.
3. **If `status='ok'`:** return the analysis immediately. Fast path. Latency: one D1 read (~5ms from Worker).
4. **If no row or `status='pending'`:** Worker writes a `pending` row to `track_lyric_analysis_status` (if not already there) and returns a response indicating analysis is queued: `{ status: 'pending', message: 'Analysis queued — check back in a few minutes.' }` The dashboard shows a "Analyzing..." placeholder.
5. **grimmauldplace cron** (every 10 minutes) runs `phase-analyze --limit 50 && phase-embed --limit 50`, which picks up `status='pending'` rows, analyzes them, writes results, then generates embeddings.
6. **Next request** for the same URI hits the fast path.

### 4.2 Where the pending-write lives

A new helper in the Worker: `ensureAnalysisPending(uri: string)`. Called from `explain_song`, `find_similar_lyrics` (for the seed URI), and the dashboard's song-explain endpoint. Writes:

```sql
INSERT OR IGNORE INTO track_lyric_analysis_status
  (spotify_track_uri, status, last_attempted_at, attempts)
VALUES (?, 'pending', ?, 0)
```

`INSERT OR IGNORE` means it's a no-op if the row already exists (whether pending, ok, or error). Cheap, idempotent, no race conditions.

### 4.3 Worst-case panel latency: the stacking problem

A brand-new track (never seen by any pipeline) hits two sequential crons before the "Why this song?" panel can populate:

1. **lyrics-backfill cron** — fetches lyrics from LRCLIB, writes `track_lyrics(status='ok')`. Currently runs on grimmauldplace on a manual/ad-hoc basis, not a fixed interval. Assume it runs nightly.
2. **lyrics-analysis cron** — picks up tracks with lyrics + pending analysis status. Runs every 10 minutes.

In the worst case: track appears → lyrics-backfill runs up to 24h later → analysis cron runs up to 10 min after that → **total worst case: ~24 hours + 10 minutes.**

But in practice, this is less bad than it sounds:
- **Most tracks already have lyrics.** The backfill has been running for weeks. As of the experiment, ~9,500 of 47,650 tracks have `status='ok'`. Any track with existing lyrics skips step 1 entirely — worst case is just the 10-minute analysis cron.
- **The obsession tier (~500 tracks) is pre-analyzed.** The eager batch covers the tracks you listen to most. These never hit the slow path.
- **Brand-new tracks (just discovered or just added to library)** are the real stacking risk. These are genuinely rare — maybe 1–5 per day from the discovery agent.

**Mitigation: chain lyrics-backfill into the analysis cron.** On grimmauldplace, the cron entry becomes:

```bash
# grimmauldplace crontab — every 10 minutes
*/10 * * * * cd ~/stack && \
  docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 20 && \
  docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis analyze --limit 50 && \
  docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis embed --limit 50
```

This chains three steps: fetch lyrics for up to 20 tracks → analyze up to 50 pending → embed up to 50 pending. If lyrics-backfill finds new lyrics, analysis picks them up in the same cron cycle. Worst case drops from 24h to **10 minutes** for any track that has an LRCLIB match.

For tracks with no LRCLIB match (no lyrics available), the panel gracefully shows "No lyrics available for analysis" — same as today's state for instrumental tracks.

**Explicit call: 10 minutes worst case (with lyrics available) is fine.** The "Why this song?" panel is a curiosity/enrichment feature, not a blocking UX element. A brief "Analyzing..." placeholder on first view of a less-common track is acceptable. If it turns out to be annoying in practice, we can tighten the cron to every 5 minutes or add a Tailscale-based direct trigger from the Worker to the container — but that's optimization, not architecture.

---

## 5. Revised cost model

### 5.1 Estimating distinct tracks per month

Sources of "first surface" events that trigger analysis:

| Trigger | Est. distinct tracks/month | Notes |
|---|---|---|
| Dashboard "Why this song?" (Now Playing) | ~200 | ~7 distinct tracks/day from active listening |
| `explain_song` MCP tool | ~30 | Ad-hoc queries during Claude conversations |
| `find_similar_lyrics` MCP tool | ~20 | Seed track + results (results need analysis too for display) |
| `lyric_search` MCP tool | ~10 | Free-text queries; results already analyzed if in the eager batch |
| **Total new analyses/month** | **~260** | After the obsession-tier eager batch is seeded |

### 5.2 Per-track cost

| Component | Tokens | Rate (sync, not batch) | Cost/track |
|---|---|---|---|
| Sonnet input: system prompt (cached) | ~200 | $0.30/MTok | ~$0.00006 |
| Sonnet input: lyrics (uncached, per-track) | ~600 | $1.50/MTok | ~$0.0009 |
| Sonnet output (analysis, no activity_fit) | ~650 | $15/MTok | ~$0.010 |
| Voyage embedding (2× per track) | ~1200 | Free tier (200M tokens) | $0 |
| **Total per track** | | | **~$0.011** |

The system prompt is identical across all tracks and hits the Anthropic prompt cache after the first call in a session. At $0.30/MTok cached vs $1.50/MTok uncached, the cached portion is negligible. The per-track lyrics are always uncached (unique per song).

### 5.3 Monthly projection

| Line item | Cost |
|---|---|
| Obsession-tier eager batch (~800 tracks, one-time, batch pricing) | **~$5.60** |
| Ongoing on-demand (~260 tracks/month, sync) | **~$2.86/month** |
| Voyage embeddings | **$0** (free tier) |
| **Monthly steady-state** | **~$3/month ≈ $36/year** |

Compare to the old plan: $148 one-time + $8/month ($244/year). The transparency-only model is ~96% cheaper up front and ~85% cheaper annually.

---

## 6. Changes to stack/lyrics-analysis/

### 6.1 phase-analyze.ts — no changes needed for the lazy trigger

The current CLI accepts `--uris-file` and `--limit`. The D1 query already picks up `status IN ('parse_error', 'pending')` rows (line 410). The cron just runs `analyze --limit 50` every 10 minutes and processes whatever's pending. No code changes required.

### 6.2 SETUP.md — rewrite Step 7

Current Step 7 says "Full catalog run (later) — `analyze --batch`." Replace with:

> **Step 7: Seed the obsession tier + set up the chained cron**
>
> Run a one-time eager batch on ~500 tracks: the obsession tier (top tracks by affinity with ≥10 plays). These are the tracks most likely to appear in "Why this song?" and "vibe twins" queries, so pre-analyzing them means fast first-load times.
>
> ```bash
> docker compose run --rm lyrics-analysis analyze \
>   --uris-file /app/obsession-tier.csv --batch
> ```
>
> Then set up the chained cron on grimmauldplace that handles lyrics fetch → analysis → embedding in one pass:
>
> ```bash
> # grimmauldplace crontab — every 10 minutes
> */10 * * * * cd ~/stack && \
>   docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 20 && \
>   docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis analyze --limit 50 && \
>   docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis embed --limit 50
> ```
>
> This chains three steps in one cron cycle. No-op when there's nothing pending. At ~2 req/sec synchronous for analysis, a batch of 50 takes ~25 seconds.

### 6.3 phase-embed.ts — still needed, create it

The embeddings are NOT dead code. `find_similar_lyrics` needs track-to-track cosine, and `lyric_search` needs query-to-track cosine. Both require Voyage embeddings in `track_lyric_embedding`.

**phase-embed.ts needs to exist.** It should:
1. Query `track_lyric_analysis_status(status='ok')` LEFT JOIN `track_lyric_embedding` to find tracks with analysis but no embeddings.
2. For each, embed `lyrics_plain` (kind='lyrics') and `subject_paragraph + tones + listener_feel_generic` (kind='analysis').
3. Write to `track_lyric_embedding`.
4. Accept `--limit N` for cron-friendly bounded runs.

Runs as the third step in the chained cron (§6.2).

**phase-audio.ts — defer.** Audio enrichment (Phase 2) is parked. Don't create the file.

### 6.4 prompt.ts — changes

Two changes to the Sonnet prompt:

1. **Remove `activity_fit`** from the requested JSON output schema. Saves ~40 output tokens per track.
2. **Keep `lyric_intrusion`.** No change needed — it's already in the prompt and has a consumer in focus-block cold-start rules.

---

## 7. Vibe-twins validation: the script

Before building the dashboard widget, run a validation script against the existing experiment data.

### 7.1 What to test

**Test 1 — Subject coherence (gating):** For 20 randomly sampled tracks from the 250 analyzed, compute the 5 nearest neighbors by `analysis` embedding cosine. Manually inspect each seed + twins set. Score each twin as coherent/partial/incoherent based on whether it shares subject matter, tone, or narrative feel with the seed.

**Pass threshold:** ≥70% coherent+partial across 100 twin pairs (20 seeds × 5 twins).

**Test 2 — Rating concordance (informational, not gating):** Among the 91 rated tracks, for each pair where both are rated and one is in the other's top-5 twins, compute the mean absolute rating difference. Compare against random-pair baseline. Report the result; don't gate on it.

### 7.2 Script location

`scripts/experiment/08-validate-twins.ts` — lives in the experiment directory with the other scripts. Uses the existing embeddings in `docs/experiments/lyric-analysis-2026-05/embeddings/` and analyses in `analyses.jsonl`. Outputs a readable report to `docs/experiments/lyric-analysis-2026-05/twins-validation.md`.

### 7.3 The gate

- If test 1 passes: ship the dashboard widget.
- If test 1 fails: keep `find_similar_lyrics` as MCP-only (user judges relevance in conversational context). Don't build the dashboard widget until we understand why embeddings aren't capturing relatedness.

---

## 8. Resolved open questions

### 8.1 Cron interval: 10 minutes

**Recommendation: 10 minutes.** The chained cron (lyrics-backfill → analyze → embed) makes each cycle slightly heavier than a bare analysis cron. At 10 minutes, worst-case panel latency for a track with available lyrics is 10 minutes, which is acceptable for a curiosity feature. Going tighter (5 min) would double the Docker container startup overhead for marginal latency improvement. Going looser (15+ min) makes the "Analyzing..." state noticeably long for a user who's actively looking at the Now Playing panel.

10 minutes is the sweet spot: short enough that the placeholder doesn't overstay, long enough that the cron isn't churning on no-ops every 5 minutes.

### 8.2 Obsession-tier size: ~800 tracks (top by affinity OR ≥10 plays)

**Recommendation: expand from 500 to ~800.** The original 500 was scoped to "top by affinity." Adding the ≥10 plays criterion catches tracks that are well-known but may not be in the affinity top-500 (e.g., older favorites with decayed recency). These are prime candidates for "Why this song?" queries — you're more likely to be curious about a song you know well.

Cost impact: ~800 tracks × ~$0.007/track (batch pricing) = ~$5.60 one-time. The $2 increase over 500 tracks is noise.

The threshold is: `track_taste.taste_score` top 500 UNION tracks with ≥10 lifetime plays in the `plays` table. Deduplicated, this should land around 700–900 tracks depending on overlap.

### 8.3 lyric_search coverage: 800-track eager set is sufficient for v1

**Recommendation: accept the constraint for v1.** `lyric_search` ("find me a song about leaving home") searches only tracks with Voyage embeddings in `track_lyric_embedding`. With the ~800-track eager batch, that's the obsession tier + frequently-played tracks. For a personal tool, this covers the songs you're most likely to be asking about.

The gap: truly obscure tracks (1–3 plays, years ago) won't be searchable by lyric content until they're surfaced by another path (dashboard panel, MCP tool) and picked up by the analysis cron.

This is acceptable because:
- The primary use case for `lyric_search` is "I remember a song about X, which one was it?" — which almost always targets well-known tracks.
- The embedding pool grows organically as the on-demand cron processes new tracks. After a few months of normal use, coverage will be 1500+ tracks.
- If coverage proves limiting, a one-time batch expansion (analyze the next 1000 by play count) costs ~$7 and can be run any time.

Don't over-invest in pre-analyzing tracks nobody will ask about.

---

## 9. Files to create or modify

### Create:
| File | Purpose |
|---|---|
| `stack/lyrics-analysis/phase-embed.ts` | Voyage embedding pipeline for analyzed tracks |
| `src/db/migrations/010_lyrics_analysis_deprecations.sql` | Comment-only migration noting `listener_feel_chris` + `activity_fit` deprecated |
| `scripts/experiment/08-validate-twins.ts` | Vibe-twins coherence validation (gates dashboard widget) |

### Modify:
| File | Change |
|---|---|
| `docs/PLAN_LYRICS_ANALYSIS_1.md` | Add pivot header; strike §6 (recommender), Phase 1.5, centroid cron in §8; revise §7 (drop `recommend_by_lyrics`), §11 (new cost model), §10 (no recommender hold-out metric) |
| `stack/lyrics-analysis/SETUP.md` | Rewrite Step 7 per §6.2 above |
| `stack/lyrics-analysis/prompt.ts` | Remove `activity_fit` from JSON output schema |
| `src/mcp/tools.ts` (when tools are built) | Register `explain_song`, `find_similar_lyrics`, `lyric_search` — no `recommend_by_lyrics` |

### Do NOT create:
| File | Reason |
|---|---|
| `stack/lyrics-analysis/phase-audio.ts` | Phase 2 audio deferred |
| `src/lyrics_analysis/similarity.ts` | Centroid math is dead |
| `src/lyrics_analysis/recommend.ts` | Recommender is dead |

---

## 10. Sequence of work

1. **Update docs** — Revise `PLAN_LYRICS_ANALYSIS_1.md` with the pivot header + section changes. Update `SETUP.md` Step 7.
2. **Update prompt** — Remove `activity_fit` from `prompt.ts` output schema.
3. **Write migration 010** — Deprecation comments on `listener_feel_chris` + `activity_fit`.
4. **Build phase-embed.ts** — Voyage embedding pipeline, following the same `lib/d1.ts` + `lib/voyage.ts` pattern.
5. **Run twins validation** — `08-validate-twins.ts` against existing experiment data. Gates step 9.
6. **Build the Worker-side pending trigger** — `ensureAnalysisPending()` helper.
7. **Build MCP tools** — `explain_song`, `find_similar_lyrics`, `lyric_search` (separate milestone).
8. **Run the obsession-tier eager batch** — ~800 tracks, ~$5.60.
9. **Build dashboard panels** — "Why this song?" + "vibe twins" (only if twins validation passes).
10. **Set up the grimmauldplace chained cron** — every 10 minutes.

Steps 1–5 are this session's scope. Steps 6–10 are future sessions.
