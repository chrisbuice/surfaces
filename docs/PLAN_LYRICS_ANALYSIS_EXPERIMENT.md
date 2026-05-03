# Lyric Analysis Experiment

Validate the central hypothesis behind `PLAN_LYRICS_ANALYSIS_1.md` before committing to the $98 full-catalog build. Specifically: **does a lyric-based recommender predict Chris's rating of unheard songs better than the existing taste model alone?**

If yes, ship Phase 1. If equivalent or worse, redirect spend to audio analysis (Phase 2 of the main plan) or kill the lyric-recommender entirely. Either outcome is information we can't get without running the test.

Budget approved: **$100**. Estimated actual spend: **$8–15** for the core experiment, with headroom for prompt iteration, larger candidate pools, and an audio side-experiment.

Model: **Claude Sonnet 4.6** (`claude-sonnet-4-6`). Locked after Stage 0 iteration. Anthropic Message Batches API for cost (50% off) + prompt caching. No multi-vendor bake-off — see §1 H1 for rationale.

---

## 1. The hypotheses

Stating these explicitly so we know what counts as a result.

| H | Hypothesis | What we measure | Pass threshold |
|---|---|---|---|
| H1 | Sonnet 4.6 produces analyses that read as specific and accurate, not generic. | Spot-grading 30 known songs on (a) subject_paragraph specificity, (b) tone match, (c) emotion match. | ≥24/30 on each axis. |
| H2 | The lyric-similarity recommender ranks unheard songs in an order that correlates with how much you like them on first listen. | Spearman rank correlation between lyric-recommender rank and your blind 1–5 rating, on 200 unheard candidates. | ρ ≥ 0.20 (loose statistical signal) |
| H3 | Lyric ranking adds signal *beyond* the existing taste model + acoustic centroid. | Compare three rankings: lyric-only, existing-system-only, hybrid. Hybrid should beat both. | Hybrid avg-rating-of-top-20 > existing-system top-20 by ≥0.4 stars. |
| H4 | Audio enrichment (Phase 2) materially improves on lyric-only. | Same blind ratings, fourth ranking using lyric+audio features from Gemini Flash on Deezer previews. | Audio-enriched top-20 > lyric-only top-20 by ≥0.3 stars. Optional sub-experiment. |

**The decision tree:**

- **H1 fails** → Stop. Return to Stage 0 and revise the prompt, or reconsider the whole approach.
- **H1 passes, H2 fails** → Lyric similarity is a bad axis for taste prediction. Don't ship the recommender. The analysis fields are still queryable and the "Why this song?" panel is still worth shipping — just not the ranker. Document negative result.
- **H1 + H2 pass, H3 fails** → Lyric ranking works but doesn't add new signal — it recapitulates what the existing taste/acoustic model already knows. Ship Phase 1 only as a *transparency layer* (queryable fields, why-this-song panel) — not as a ranker. Save the lyric-recommender complexity.
- **H1 + H2 + H3 pass** → Green-light Phase 1 as designed. The recommender adds real signal.
- **H4 passes** → Strong case for prioritizing Phase 2 (audio) earlier in the rollout.

Note that even a "negative" outcome on H2/H3 is genuinely useful — it tells us the existing system is capturing more than we thought, which is a happy result.

---

## 2. Cost model

Sonnet 4.6 pricing: $3/$15 per MTok input/output. Batch API halves both. Prompt caching reduces cached system-prompt input to ~$0.30/MTok.

| Stage | Songs | In tokens (avg) | Out tokens (avg) | Cost |
|---|---|---|---|---|
| Stage 0 — prompt iteration on 5 obsession seeds | 5 (×4 iterations = 20) | 600 | 700 | **~$0.40** |
| Stage 1 — H1 quality gate, 30 known songs | 30 | 600 | 700 | **~$1.00** |
| Stage 2 — analysis for the recommender | 250 (200 unheard + 50 obsession) | 600 | 700 | **~$2.50** |
| Voyage embeddings, all 250 + obsession seeds | 250 × 2 | — | — | **$0** (inside free tier) |
| Stage 3 — Sonnet recommendation explanations on top-K | ~60 explanations (top 20 × 3 rankings) | 1500 | 100 | **~$1.50** |
| Stage 4 (optional) — Gemini Flash audio on 130 songs | 130 × 30s | — | — | **~$1.40** |
| Buffer for re-runs, prompt variants, larger pool | — | — | — | **~$5** |
| **Total** | | | | **~$12** |

The $100 budget gives massive headroom. Reasonable upgrades within it: increase candidate pool from 200→500 (adds ~$2.50), add a second analysis variant to compare prompt designs (~$2.50), expand audio analysis from 130→500 songs (~$5), or do one full-blind-rating second pass after a prompt revision.

---

## 3. Architecture

This is a one-shot research experiment, not a production pipeline. **No new D1 tables, no MCP tools, no dashboard changes.** All artifacts live in a flat directory:

```
docs/experiments/lyric-analysis-2026-05/
  README.md                         # this experiment's runbook
  prompts/
    lyric-analysis-v1.md            # locked prompt from Stage 0
    audio-analysis-v1.md            # if Stage 4 runs
  candidates.json                   # 200 barely-heard URIs + metadata
  obsession-seeds.json              # 50 obsession seeds by play count
  golden-set.json                   # 30 known songs for Stage 1
  analyses-stage1.jsonl             # Stage 1 Sonnet output (30 songs)
  analyses.jsonl                    # Stage 2 full output (250 songs)
  embeddings/                       # Float32Array BLOBs
  rankings.csv                      # blind ratings + 3-4 ranks
  audio-features.jsonl              # Gemini Flash output for the audio sub-experiment
  results.md                        # statistics, decision, and what we learned

scripts/experiment/
  00-pick-candidates.ts             # query D1: 200 barely-heard + 50 obsession seeds
  01-pick-golden-set.ts             # validate golden set URIs, fetch lyrics
  02-analyze-sonnet.ts              # call Anthropic Message Batches API
  03-embed-voyage.ts                # call Voyage embeddings API
  04-rank.ts                        # compute lyric / existing / hybrid rankings
  05-rate-blind.html                # Stage 3 blind rating (served from experiment dir)
  06-analyze-audio.ts               # optional (Stage 4)
  07-results.ts                     # compute correlations, write results.md
```

All scripts run from your laptop with `tsx`. None get committed as long-term infrastructure — they're throwaway code that produces a written conclusion. If the experiment passes and Phase 1 ships, the scripts get archived in the experiment directory; the production code in `stack/lyrics-analysis/` is built fresh from the validated prompt.

---

## 4. Stages in detail

### Stage 0 — Prompt iteration (interactive, 1–2 hours)

Use Claude.ai or Claude Code (free under your Max subscription) to draft and refine the analysis prompt against 5 hand-picked obsession songs. Don't burn API budget here — this is the part the subscription is good at.

- Pick 5 songs you know cold and have strong opinions about. Vary genre and reflection. Suggested mix: one folk/Americana, one pop, one alt-rock, one R&B, one country.
- Draft the prompt from §6 of `PLAN_LYRICS_ANALYSIS_1.md`. Iterate until the JSON outputs read as specific and on-target for those 5 songs.
- Lock the prompt as `prompts/lyric-analysis-v1.md`. Version it; if you revise it later, bump to v2 and rerun affected stages.

Pass: you'd be willing to publish the analysis of all 5 songs as your own writing without embarrassment. If you wouldn't, the prompt isn't done. Don't proceed until it is.

### Stage 1 — H1 quality gate: 30 known songs

Run the locked v1 prompt through `02-analyze-sonnet.ts --input=golden-set --output=analyses-stage1.jsonl` (Sonnet 4.6, batch mode, single batch since 30 < 10K). Output goes to `analyses-stage1.jsonl`.

OpenAI bake-off considered and dropped. Stage 0 outputs (Sonnet) passed the user's quality bar; benchmark consensus favors Sonnet for nuanced literary work; the ~$107 one-time savings of GPT-5 didn't justify the second-vendor complexity for a single-user project.

**Grading procedure:**

Open `analyses-stage1.jsonl` in the readable-summary format used in Stage 0 (see `analyses-stage0-v1.jsonl` as reference) and spot-check each analysis against the H1 criteria:

| Field | Pass | Fail |
|---|---|---|
| `subject_paragraph` | Mentions concrete imagery from the actual lyric. Could only describe THIS song. | Generic ("a song about love and loss" / "the narrator reflects on a difficult time"). Could describe 50 other songs. |
| `tones` | Match how YOU experience the song. | Off — "playful" on a song that's genuinely melancholy, or vice versa. |
| `listener_feel_generic.primary_emotion` | Matches your gut on the song. | Off. |

Pass threshold: **≥24/30 on each axis.** Below that, return to Stage 0 and revise the prompt before continuing. Don't waste Stage 2 budget on a prompt that fails Stage 1.

This step is ~$1.00 in API cost and ~1 hour of careful reading. The single most important step in the experiment — if Stage 1 fails, nothing downstream matters.

### Stage 2 — Analyze the candidate pool

After Stage 1 passes, expand to the full 250-song candidate pool:

- **200 barely-heard tracks** from D1 `plays` with 1–3 lifetime plays and last heard >1 year ago, filtered to `track_lyrics.status='ok'` AND non-instrumental AND `lyrics_length > 100`. Stratified ~1/3 each at 1, 2, 3 plays and spread across last-played decades (2011–2015, 2016–2020, 2021–2024). Selected with a fixed RNG seed for reproducibility. These are functionally forgotten — you won't recognize most during blind rating.
- **50 obsession seeds** — top 50 tracks by play count that have `track_lyrics.status='ok'`. Used to build the obsession centroid.

Run `02-analyze-sonnet.ts --input=all --output=analyses.jsonl` against all 250. Same prompt as Stage 1. Submit as one Anthropic batch (250 << 10K). Result lands in `analyses.jsonl` within ~24 hours.

Run `03-embed-voyage.ts` to embed `lyrics_plain` and the analysis text for all 250 songs. Outputs to `embeddings/`.

### Stage 2.5 — Extract obsession themes

After Stage 2 completes, run ONE Sonnet call against the 50 obsession-seed analyses to extract 4–7 recurring themes with exemplar songs. Output: `obsession-themes.json`. This feeds Stage 3 explanations — when explaining why a candidate ranked high, reference the theme it matches rather than listing raw embedding similarity.

### Stage 3 — Build the three rankings + blind rate

Three rankings to compare, each a 1–200 ordering of the unheard candidates:

1. **`lyric_rank`** — cosine similarity of (candidate's `analysis` embedding) to (centroid of obsession seeds' `analysis` embeddings). Highest similarity = rank 1.
2. **`existing_rank`** — the candidate's current `taste_score` from D1's discovery scoring (which already combines artist taste, follow status, audio fit, etc.). This is the system's existing "you might like this" ordering.
3. **`hybrid_rank`** — z-normalize both above, average them. Highest avg = rank 1.

(`audio_rank` from Stage 4 is added if the audio sub-experiment runs.)

**Blind rating workflow:**

`05-rate-blind.html` is a single-file local web page served via `python3 -m http.server` from the experiment directory. It:

- Loads `candidates.json`, shuffles it into a random order using a seeded RNG (write the seed to disk so the order is reproducible).
- For each candidate, plays the Spotify track in your active Spotify player via `/api/queue-track` (the existing endpoint). Or, if a Spotify play would taint future taste-model data, falls back to playing the Deezer preview MP3 directly in the browser.
- Shows ONLY: position N of 200, a 5-button rating row (1–5), and a "skip — couldn't form an opinion" button. **No track name. No artist. No rank from any of the three systems.**
- Records each rating to `rankings.csv` keyed by URI.
- Lets you stop and resume.

**Important:** if you find yourself recognizing a song mid-listen, that's fine — rate it honestly anyway. Recognition is a normal part of how you experience music. The blinding is to prevent you from seeing rank labels, not to make you forget your own library.

**Time budget:** at 30 sec/song × 200 = 100 min listening minimum. Realistically 2–3 hours over multiple sessions. The web page is built to make it easy to stop and resume — if you can do 50 songs in a sitting, that's four sittings.

### Stage 4 (optional) — Audio sub-experiment

Only worth doing if you want H4 answered before Phase 1 ships. Adds ~$1.50.

For each of the 250 songs (or a 130-song subset to save: the 50 obsession seeds + a random 80 unheard candidates):

- Look up `track_lyrics.isrc`. Skip if null.
- Fetch `https://api.deezer.com/track/isrc:{isrc}` → `preview` URL.
- Download the 30-sec MP3.
- Send to Gemini 2.5 Flash with a vocal-delivery prompt (in `prompts/audio-analysis-v1.md`). Get back JSON: vocal delivery, perceived emotion, instrumental density, production reflection, notable moments.
- Embed the audio analysis text via Voyage.
- Compute `audio_rank` analogous to `lyric_rank`.

Add `audio_rank` and a `audio_hybrid_rank` (lyric + existing + audio averaged) to `rankings.csv`. Compare against H4 threshold.

### Stage 5 — Compute results

`07-results.ts` writes `results.md` with:

- Spearman rank correlation between each ranking and `blind_rating`.
- Mean blind_rating of each ranking's top-20 vs. bottom-20.
- Distribution of 5-star ratings across each top-20.
- The H1–H4 pass/fail table.
- A one-paragraph "what we learned" written by hand after looking at the numbers.

Commit `results.md` to the repo regardless of outcome — negative results are repo-worthy.

---

## 5. Statistical methodology

Honest about the small-N nature of this experiment. We're not running a published study; we're running a personal-stakes decision-support test. The numbers shouldn't be more precise than they are.

- **Sample size: 200 unheard songs.** Enough to detect a Spearman correlation of ρ=0.20 at p<0.05 (rough power calc). Not enough to confidently distinguish ρ=0.20 from ρ=0.30, which is fine — we don't need that resolution to decide whether to spend $98.
- **Blind randomization seed** written to disk so the listening order is reproducible if you need to re-listen any song to break a tie.
- **Pre-registration:** the H1–H4 thresholds in §1 are committed BEFORE looking at any data. No post-hoc threshold revision allowed. If they look generous after the fact, that's a signal that the experiment was easy to pass — not a license to retighten.
- **One thing we're NOT controlling for:** mood on rating day. If you rate 50 songs on a stressful Wednesday and 150 on a calm Saturday, ratings will drift. Mitigation: spread the listening across at least 3 sessions, ideally on 3 different days. Note any unusual life-context-during-listening in `results.md`.
- **One thing that will skew results regardless:** familiarity bias. If 8 of the "unheard" 200 turn out to be ones you actually heard once and forgot, your rating will be inflated relative to truly novel songs. The existing-system ranking will know about plays in `play_events` and may filter them; the lyric ranking won't. Cross-check `play_events` for any URI rated ≥4 to make sure it's truly unheard. Document any leakage.

---

## 6. Files to create

```
docs/experiments/
  lyric-analysis-2026-05/
    README.md                       # human-runnable runbook (this plan, condensed)
    prompts/
      lyric-analysis-v1.md          # locked prompt from Stage 0
      audio-analysis-v1.md          # if Stage 4 runs
    candidates.json                 # 200 barely-heard URIs + metadata
    obsession-seeds.json            # 50 obsession seeds by play count
    golden-set.json                 # 30 known songs for Stage 1
    analyses-stage1.jsonl           # Stage 1 output (30 songs)
    analyses.jsonl                  # Stage 2 full output (250 songs)
    obsession-themes.json           # Stage 2.5 theme extraction
    embeddings/                     # Float32Array BLOBs
    rankings.csv                    # blind ratings + 3-4 ranks
    results.md                      # final write-up

scripts/experiment/
  00-pick-candidates.ts
  01-pick-golden-set.ts
  02-analyze-sonnet.ts              # Anthropic Message Batches API
  03-embed-voyage.ts
  04-rank.ts
  05-rate-blind.html                # Stage 3 blind rating (served from experiment dir)
  06-analyze-audio.ts               # optional (Stage 4)
  07-results.ts
```

All scripts use the existing patterns from `stack/lyrics-backfill/lib/` for D1 access (HTTP API, no Worker bindings — these run on your laptop). New deps to add to a dedicated `package.json` in the experiment directory: `@anthropic-ai/sdk`, `voyageai` (or hand-rolled fetch), `@google/generative-ai` (for Stage 4).

---

## 7. What needs to happen before code

Same gate as the main plan: confirm before scaffolding.

1. **Confirm Stage 4 inclusion.** Audio sub-experiment is optional — adds ~$1.50, ~1 hour to add 130 songs through Gemini Flash, and answers H4 (whether to prioritize Phase 2 audio in the main plan). Recommend yes; the marginal cost is rounding error against the $100 budget.
2. **Pick the 5 Stage 0 prompt-iteration seeds and the 30 Stage 1 golden-set songs.** This is the first task and the bottleneck — without these we can't even start. Hand them to me as `(spotify_track_uri | track_name + artist)` lists.
3. **Decide on listening UX.** Spotify-via-active-device (uses your real Spotify; rated songs may end up in recently-played and slightly nudge the taste model) or Deezer-preview-via-browser (cleaner experiment, less convenient, only 30 sec instead of full song). Recommend Spotify — full songs give honest ratings, and 200 plays in a few weeks won't materially shift your taste model.
4. **Pre-register the thresholds.** §1's H1–H4 thresholds. If you want to tighten or loosen any, do it now and commit. After data is collected, no changes allowed.

Once those four are nailed, Stage 0 is one focused evening's work and the rest follows from there.

---

## 8. What this experiment does NOT prove

Listed so we don't oversell the result either way.

- It doesn't prove anything about songs *outside* the candidate distribution. fresh_pool candidates have already been pre-filtered by the existing system — testing on them tests "does lyric ranking refine an already-good list," not "does lyric ranking work on randomly-selected music." A negative H2 doesn't mean the lyric recommender is useless on a different candidate population (e.g. across the entire local-history catalog for time-machine queries).
- It doesn't prove anything about the *interpretive value* of the analysis fields independent of the recommender. Even if H2 fails, the "Why this song?" panel and queryable corpus might still be worth shipping.
- It doesn't test the full-catalog Phase 1.5 (`listener_feel_chris`) because that requires the full obsession + dislike centroids built from thousands of analyzed tracks. The experiment uses 50 obsession seeds; the production system would use 100s–1000s.
- It doesn't test Phase 2 (audio) at production scale. Stage 4 tests whether audio adds signal *on top of* lyric on a 130-song subset; it doesn't tell us whether audio-only on 47K tracks would be worth the spend.

These limits matter when we read `results.md`. Each H tells us about the *specific* hypothesis it was designed to test. Don't over-extrapolate.

---

## 9. Out of scope

- Production-grade error handling in the experiment scripts. Crash, retry, restart — fine. The scripts are throwaway.
- Multi-model comparison. Sonnet 4.6 locked after Stage 0; no OpenAI bake-off.
- Any Phase 1 production code. The point of the experiment is to decide whether to *write* Phase 1. No `stack/lyrics-analysis/` container, no D1 migrations, no MCP tools, no dashboard changes during this experiment.
- Re-evaluation criteria for "what counts as Phase 1 success" if it does ship. That's a separate concern; if the experiment passes, we revisit `PLAN_LYRICS_ANALYSIS_1.md` Section 10 (Coverage targets) to decide what to monitor in production.
