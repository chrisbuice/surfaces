# Cover & Alternate-Version Discovery

> Find recordings of compositions Chris loves that **share lyrics but sound radically different** — covers, remixes, reworks, translations, acoustic versions, club versions. Surface them whether they're already in the library or not. The seed examples are Birdy "Words (EDX Remix)" and Milky Chance's cover of "Levitating" — same songs, completely different sonic worlds.

This is a discovery feature, not an analytics one. The output is a ranked list, per seed track, of "alternate universes" of that song, sorted by how different they sound from the version Chris already loves.

This builds on the lyrics + credits backfill (`PLAN_LYRICS_CREDITS_1.md`, complete) and the ReccoBeats audio-features backfill. Nothing in those pipelines changes; this is purely additive.

---

## ⚠️ Current scope: Step 1 (calibration spike) only

**Do not implement Steps 2 through 6.** This document defines the entire feature for context, but the only work in scope right now is the Step 1 calibration spike (see §5). Steps 2–6 will be re-planned after Step 1 results are in, because the threshold values and possibly the scoring approach will change based on what Step 1 measures. Treat the post-Step-1 sections as design context, not as build instructions.

Step 1 produces a results document, not production code. Its output gates whether Steps 2–6 happen at all.

---

## 0. Why this is worth a milestone

Two things make this feature distinct from anything Surfaces does today:

1. **It generalizes a behavior Chris already exhibits.** "Words (EDX Remix)" and Milky Chance's "Levitating" are signal that there's a class of song — *radical reimaginings of compositions I love* — that is not findable through any existing taste signal. Acoustic features alone don't catch it (the original and the remix sound nothing alike). Artist similarity doesn't catch it (different artists, often different genres). Lyric similarity to the obsession centroid doesn't catch it (the H2 experiment showed lyric similarity doesn't predict taste — but that's about *thematic* similarity across different songs, not *exact* lyric match across versions of the same song).

2. **It expands the candidate pool beyond Chris's listening history.** Lost-favorites, smart queues, and time-machine all operate on songs Chris has already played. This is the first feature that says "here's something you've never heard but that has a structural reason to land." The discovery agent does this too, but its candidate selection is artist-graph-based; this one is composition-based.

The case to *defer* this is real and worth naming: it's not on the CLAUDE.md priority list. If lost-favorites, smart queues, or time-machine still have rough edges, those should ship first.

---

## 1. Validation results — the constraint that shapes the design

Manual validation against the two seed tracks (run via the MusicBrainz API on 2026-05-04) tells us what won't work and forces the architecture:

| Seed track | MB work has alternate recordings? | Specific alt version Chris loves is linked? |
|---|---|---|
| Birdy "Words" (work `3ec51142-…`) | **No — 1 recording total** | EDX remix exists in MB but is **orphaned, not linked to the work** |
| Dua Lipa "Levitating" (work `ae6a2674-…`) | Yes — 23 recordings | **No — Milky Chance cover not linked** |

Two implications:

- **MB works alone are insufficient as the primary signal.** Coverage is uneven. For a less-canonical track ("Words"), there's nothing. For a megahit ("Levitating"), there are 23 candidates but the *specific* cover that matters is missing.
- **MB works are still useful as a high-precision booster.** The 23 candidates for "Levitating" include translations like "Ikiaqqik (Levitating)" by Riit (Inuktitut) and remixes (Don Diablo, KUU, Blessed Madonna) that title-search alone wouldn't reliably surface.

So the design has to be: **lyric-based composition matching as primary, MB works as booster, Spotify title search as recall expander.** The lyrics backfill is the load-bearing dependency — without it, the feature can't ship.

---

## 2. Sources, and what each contributes

| Source | Already in DB? | Role |
|---|---|---|
| `track_lyrics` (LRCLIB) | Yes — ~9,500 ok rows, growing nightly | Composition fingerprint via lyric matching (primary signal) |
| `track_credits` (MusicBrainz works) | Yes — coverage ≥60% target | (a) Songwriter-overlap filter on Spotify candidates; (b) `mb_work_id` → all linked recordings |
| `track_credits_status.mb_work_id` | Yes | Direct link to the work; query MB for `recording-rels` to enumerate alternates |
| ReccoBeats audio features | Yes — backfill in progress | The 9 features (acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence) drive the "feels different" distance score |
| Spotify Search API | Wrapper exists | High-recall candidate generator: title search across catalog |
| Spotify ISRC lookup | Used in Phase A | Reconciles MB recordings → Spotify track URIs |

What **isn't** needed: Essentia/AcousticBrainz, audio fingerprinting (Chromaprint), Genius scraping, Musixmatch. ReccoBeats covers all 9 Spotify-style features (tempo, energy, danceability, acousticness, valence, instrumentalness, liveness, loudness, speechiness). Missing vs. legacy Spotify API: `key`, `mode`, `time_signature`, `duration_ms` — none load-bearing for this feature.

---

## 3. Pipeline shape

For a given seed track URI, the pipeline produces a ranked list of alternate recordings:

```
seed_track_uri
   │
   ├──[candidate generation, parallel]──┐
   │                                    │
   │   Path A: MB work expansion        │   Path B: Spotify title search
   │   ──────────────────────────       │   ────────────────────────────
   │   1. mb_work_id from               │   1. base_title = strip remix/
   │      track_credits_status          │      cover/version markers
   │   2. GET /ws/2/work/{id}           │   2. Spotify search:
   │      ?inc=recording-rels           │      track:"{base_title}"
   │   3. For each linked recording,    │   3. Take top N matches, drop
   │      resolve to Spotify URI via    │      seed itself
   │      ISRC or fuzzy match           │
   │   4. Tag candidates as             │   4. Tag candidates as
   │      method='mb_work'              │      method='spotify_search'
   │                                    │
   └────────[merge candidates]──────────┘
                  │
                  ▼
   ┌─────────[lyric verification gate]───────────┐
   │ For each candidate, fetch its LRCLIB lyrics │
   │ Compute Jaccard similarity vs seed lyrics   │
   │ Drop candidates below threshold (default    │
   │ 0.7 on 5-shingled tokens)                   │
   └─────────────────────────────────────────────┘
                  │
                  ▼
   ┌─────────[songwriter overlap booster]────────┐
   │ For candidates with credits available, lower│
   │ the lyric threshold to 0.5 if writers       │
   │ overlap with seed                           │
   └─────────────────────────────────────────────┘
                  │
                  ▼
   ┌─────────[audio distance scoring]────────────┐
   │ Fetch ReccoBeats features for survivors     │
   │ Weighted euclidean vs seed features         │
   │ Tempo and energy weighted 2x                │
   │ Normalize each feature to 0-1 first         │
   └─────────────────────────────────────────────┘
                  │
                  ▼
        ranked alternates
        (sorted by audio distance desc)
```

### Stage-by-stage notes

**Path A (MB work expansion).** Cheap when `track_credits_status.mb_work_id` is populated (~60%+ of the library). Lookup is one MB API call per seed. The recordings list usually includes an ISRC; resolve to Spotify via the existing ISRC client. For recordings without ISRC, fall back to fuzzy artist+title match on Spotify with manual confidence flagging.

**Path B (Spotify title search).** Title normalization needs care. The transform should strip everything in `()` or `[]`, drop trailing markers like " - Remix", " - Live", " - Acoustic", " - 2021 Remaster", and "feat./ft./featuring" clauses. Then Spotify search with `track:"{normalized}"`. Take the top ~30 by relevance, drop the seed track itself, drop tracks where artist exactly matches the seed artist *unless* the title differs (this excludes the seed but keeps "Words (EDX Remix)" by Birdy). Quota: Spotify search is 1 search per seed; cheap.

**Lyric verification gate.** The most important stage. Without it, Path B drowns in false positives ("Words" has thousands of unrelated tracks named "Words"). Compute lyric similarity as Jaccard on word 5-shingles after normalization (lowercase, drop punctuation, collapse whitespace, drop section markers like `[Chorus]`). Threshold of 0.7 on 5-shingles is conservative — a true cover should clear 0.85+ easily; a remix that adds rapped verses might land at 0.7-0.85; unrelated songs with the same title rarely exceed 0.3. **Empirically tune** against the seed examples before committing to a threshold.

**Songwriter overlap booster.** If both seed and candidate have credits, and their writer sets overlap, lower the lyric threshold. This catches edge cases where a cover changes lyrics slightly (translations, parody, abridged covers) but is verifiably the same composition. Composition credits are more trustworthy than partial lyric matches.

**Audio distance.** Normalize each ReccoBeats feature to `[0, 1]` before computing distance — tempo is in BPM (50-200), loudness is in dB (-60 to 0), the others are already 0-1. Weighted euclidean: `sqrt(sum(w_i * (a_i - b_i)^2))` with `w_tempo = w_energy = 2.0`, others = 1.0. This emphasizes the two features that most reliably separate "same song reimagined" from "same song with slight production differences." Calibrate against seeds: Birdy original vs EDX remix should be in the top decile of pairwise distances.

---

## 4. Schema additions

Two new tables, one new view. All keyed on `spotify_track_uri`.

### `composition_versions`

Cache of discovered alternate versions, per seed.

```sql
CREATE TABLE composition_versions (
  seed_track_uri TEXT NOT NULL,
  candidate_track_uri TEXT NOT NULL,
  candidate_track_name TEXT NOT NULL,
  candidate_artist_name TEXT NOT NULL,
  candidate_album_name TEXT,
  in_library INTEGER NOT NULL DEFAULT 0,  -- 1 if Chris has played it
  match_method TEXT NOT NULL,             -- 'mb_work' | 'spotify_search' | 'both'
  mb_work_id TEXT,                        -- if matched via MB
  lyric_similarity REAL,                  -- 0-1, Jaccard on 5-shingles
  writer_overlap_count INTEGER,           -- number of writers in common (when known)
  audio_distance REAL,                    -- weighted euclidean, lower = more similar
  audio_feature_deltas_json TEXT,         -- per-feature signed deltas, for "tempo +44, energy +0.3" UI
  match_confidence REAL,                  -- 0-1, derived: combines lyric sim + writer overlap + ISRC-vs-fuzzy
  found_at INTEGER NOT NULL,
  PRIMARY KEY (seed_track_uri, candidate_track_uri)
);

CREATE INDEX idx_composition_versions_seed ON composition_versions (seed_track_uri, audio_distance DESC);
CREATE INDEX idx_composition_versions_candidate ON composition_versions (candidate_track_uri);
```

### `composition_seeds`

Cursor table for what's been searched and when.

```sql
CREATE TABLE composition_seeds (
  seed_track_uri TEXT PRIMARY KEY,
  last_searched_at INTEGER NOT NULL,
  search_method TEXT NOT NULL,    -- 'mb_only' | 'spotify_only' | 'both'
  candidates_found INTEGER NOT NULL,
  candidates_kept INTEGER NOT NULL,  -- after lyric gate
  source TEXT NOT NULL              -- 'on_demand' | 'top_played_batch' | 'manual'
);
```

### View: `composition_versions_enriched`

Joins `composition_versions` with `track_lyrics`, `track_credits_status`, and play counts to power the UI without complex queries every render.

```sql
CREATE VIEW composition_versions_enriched AS
SELECT
  cv.*,
  (SELECT COUNT(*) FROM plays p WHERE p.spotify_track_uri = cv.candidate_track_uri) AS candidate_play_count,
  tl.status AS candidate_lyrics_status,
  tcs.status AS candidate_credits_status
FROM composition_versions cv
LEFT JOIN track_lyrics tl ON tl.spotify_track_uri = cv.candidate_track_uri
LEFT JOIN track_credits_status tcs ON tcs.spotify_track_uri = cv.candidate_track_uri;
```

Migration: 008 (assuming 007 was the lyrics/credits migration).

---

## 5. Build sequence

Six steps. **Step 1 is the only thing in scope right now.** Steps 2–6 are sketched here for context but should not be started until Step 1's results gate is passed and a follow-up planning conversation revises them based on what was learned.

---

### Step 1: Threshold calibration spike — IN SCOPE NOW

A "spike" is a short, throwaway investigation: code that exists to answer questions, not to ship. The deliverable is a results document, not production code. The point of doing this before Step 2 is that the rest of the plan rests on two scoring functions and threshold values that were proposed from priors, not measured against real data:

- **Lyric similarity threshold:** proposed at 0.7 Jaccard on 5-shingles
- **Audio distance scoring:** proposed as weighted euclidean with tempo and energy weighted 2x, all features normalized to [0,1] first

If either of those is wrong, the entire pipeline produces garbage and we don't find out until much later. Calibration on known-good pairs is the cheapest way to surface that.

#### What to do

This work lives in `docs/experiments/cover-detection-2026-05/` (matching the existing pattern from `docs/experiments/lyric-analysis-2026-05/`). All scripts written for Step 1 are throwaway — they live in the experiment directory, not in `scripts/` or `stack/`.

**Part A: assemble ground-truth pairs**

The four anchor tracks (Chris already loves all four):
- Birdy — "Words" (original)
- Birdy — "Words (EDX Remix)"
- Dua Lipa — "Levitating"
- Milky Chance — "Levitating" (cover)

This gives two **known-positive** cover pairs:
- (Birdy "Words" original, Birdy "Words EDX Remix")
- (Dua Lipa "Levitating", Milky Chance "Levitating")

For **known-negative** pairs, search Spotify for other songs sharing one of those titles by unrelated artists. Goal: 8–12 unrelated tracks named "Words" and 8–12 unrelated tracks named "Levitating" by entirely different artists. These are title collisions, not covers — they should score low on lyric similarity.

For **soft-negative sanity checks** on audio distance, pick 4–6 tracks that are *not* covers but should be sonically close to the seed (e.g., other Birdy tracks from *Beautiful Lies*; other Dua Lipa tracks from *Future Nostalgia*). These help confirm that "high audio distance" isn't just noise — actually close songs should score close.

Save the candidate list as `docs/experiments/cover-detection-2026-05/pairs.json` with each entry tagged `known_positive` | `known_negative_title_collision` | `sanity_check_close`.

**Part B: lyric similarity calibration**

For each track in the pair set, fetch lyrics from LRCLIB. Some won't be available — note which ones and exclude them from the analysis (don't fabricate scores).

Try two similarity metrics:

1. **Jaccard on word 5-shingles**, after normalization (lowercase, strip punctuation, collapse whitespace, drop section markers like `[Chorus]`, `[Verse 1]`).
2. **Cosine similarity on Voyage-3.5 embeddings** of the full normalized lyric text. (Voyage-3.5 is already used in lyric analysis per `PLAN_LYRICS_ANALYSIS_1.md`, so the client wrapper exists.)

Compute every pairwise score within and across categories. The output should be a table or matrix where you can visually inspect:

- Are known-positive pairs scored meaningfully higher than known-negative pairs?
- Is there a clean gap between the two distributions, or do they overlap?
- Does Jaccard or cosine separate them better?
- For the cheaper of the two metrics, what threshold value cleanly separates positives from negatives?

**Decision criteria:**
- If there's a clean gap (≥0.2 between the lowest known-positive and the highest known-negative) on either metric: pick a threshold in the gap. Prefer Jaccard if it works (cheaper, no inference cost).
- If neither metric shows a clean gap: try varied shingle sizes (3, 7, 10) for Jaccard before concluding the lyric-match approach is broken. If even that fails, **stop and re-plan** — the feature design is wrong and Step 2 cannot proceed.

**Part C: audio distance calibration**

For each track, fetch ReccoBeats audio features (9 dimensions: acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence).

Normalize each feature to [0,1]:
- Most are already 0–1
- `tempo`: divide by 250 (a generous BPM cap)
- `loudness`: shift from dB scale to 0–1 by `(loudness + 60) / 60`, clamped

Compute weighted euclidean distance for every pair. Try at least three weighting schemes:

1. **All features weighted 1.0** (uniform baseline)
2. **Tempo and energy weighted 2.0**, others 1.0 (the proposed scheme)
3. **Tempo, energy, danceability, acousticness weighted 2.0**, others 1.0 (broader emphasis on the "what genre is this" features)

For each scheme, compute distances for:
- Known-positive cover pairs (should be HIGH — that's the whole point)
- Sanity-check close pairs (should be LOW — these are not covers, they're similar songs by the same artist)
- A few cross pairs (Birdy original vs Dua Lipa, etc.) as an unrelated-songs baseline

**Decision criteria:**
- Pick the weighting scheme where known-positive cover pairs land *above* the sanity-check close pairs by the largest margin. That's the scheme that best separates "different sonic universe" from "different song, similar vibe."
- Note the actual distance values for the two known cover pairs. These become the *minimum interesting distance* for ranking later — anything well below that isn't worth surfacing as a "different worlds" alternate.

**Part D: write up results**

Output: `docs/experiments/cover-detection-2026-05/results.md` containing:

1. **Pair set** — the 30ish tracks used, with categories
2. **Lyric similarity table** — every pair, both metrics, side by side
3. **Audio distance table** — every pair, all three weighting schemes
4. **Chosen lyric metric and threshold** — with the actual data range that justified it
5. **Chosen audio weighting scheme** — with the actual distance values for the known covers
6. **Anything surprising** — pairs that scored unexpectedly, lyrics that LRCLIB returned wrong, ReccoBeats features that looked off
7. **Go/no-go recommendation** for Step 2, with reasoning

Plus the supporting code as throwaway scripts in the same directory: `fetch-pairs.ts`, `compute-lyric-sim.ts`, `compute-audio-distance.ts`, `pairs.json`, raw output JSONs.

#### Step 1 gate

Before any of Step 2 begins, both must be true:

1. The two known-positive pairs cleanly clear the chosen lyric threshold (both pairs score above it; ideally with margin)
2. The two known-positive pairs land at higher audio distance than every sanity-check close pair under the chosen weighting scheme

If either fails: stop, share the results file, and re-plan. Do not proceed to Step 2 with broken scoring functions.

If both pass: the threshold values from Part D are the values used in the production pipeline. The values currently written in §3 of this document are placeholders to be replaced after Step 1 runs.

---

### Step 2 (deferred — do not start until Step 1 gate is passed): Schema + offline batch script

- Migration 008: the two tables + view from §4
- New script `scripts/find-covers.ts` that takes a seed URI, runs the pipeline, and writes to `composition_versions`
- Run manually against the two seed tracks; verify results are sensible
- Run against the top 20 most-played tracks; spot-check 3-5 results for false positives
- Gate: false-positive rate on spot check <10%

### Step 3 (deferred): Batch backfill

Run `find-covers.ts` against the top 200 most-played tracks. Populate `composition_versions` enough for a UI to be worth building.

### Step 4 (deferred): API + MCP tool

- `GET /api/covers/:track_uri` on the Worker
- `find_covers` MCP tool

### Step 5 (deferred): UI surface

"Different Worlds" view per §6.

### Step 6 (deferred, optional): Ongoing capture

Cron-driven catch-up for newly-popular tracks.

---

## 6. UI angle — "Different Worlds"

Two surfaces:

**On any track page:** an "Alternate Universes" section showing ranked covers/remixes/versions. Each card has the candidate's album art, artist, a sparkline of which audio features deviated most (`tempo +44 BPM, energy +0.3, acousticness -0.6`), and a play button.

**Standalone discovery feed:** "We found a synthwave version of [song you played 73 times] you've never heard." Filterable by:
- "Versions of songs I've played 50+ times"
- "Versions I haven't played"
- "Versions where tempo changed by 30+ BPM"
- "Versions on Spotify only" vs "in my library"

The discovery feed is the killer feature. It turns a one-off curiosity into ongoing value, and it expands the candidate pool beyond listening history — the only Surfaces feature so far that does.

---

## 7. Out of scope for v1

- **Live/acoustic vs club-remix taxonomy.** Chris explicitly wants live and acoustic versions in the results, not filtered out. Distance is distance. Don't build version-type classifiers.
- **AcousticBrainz / Essentia features.** ReccoBeats is sufficient.
- **Mashups and interpolations.** Songs that share a chorus or sample but are otherwise different compositions. The lyric-match gate at 0.7 will mostly exclude these; building explicit mashup detection is a separate project.
- **Cover detection within compositions Chris hasn't played.** Always seed from the library. Generalizing to arbitrary catalog songs is a different feature and probably not useful.
- **Recommendation by "you'd like this cover."** This is just discovery — surface the alternate versions, let Chris decide. Don't try to predict which alternates will land. The H2/H3 experiments showed lyric similarity ≠ taste, and we don't have evidence that "audio-distant covers of songs you love" predicts liking either. Build the discovery surface; gather feedback; revisit if patterns emerge.
- **Artist-disambiguation for compilations and tribute albums.** A "tribute to Coldplay" album will surface a lot of candidates with shared lyrics — surface them honestly, let Chris filter by artist if he wants.

---

## 8. Coverage targets and what counts as success

After Step 3 batch backfill:

- **At least one alternate version found** for ≥40% of the top 200 most-played tracks. Many songs simply don't have notable alternate versions; this is fine. The feature is meaningful even if half the seeds come up empty.
- **Spot-check: top 5 audio-distance results** for 10 random seeds with results. ≥80% should be actually-the-same-composition (not false positives). False misses are acceptable; false matches poison the UI.
- **Both seed examples (Birdy/EDX, Dua Lipa/Milky Chance) appear in the top 5 results** for their respective seed tracks. This is the canonical sanity check.

If the seed examples don't surface, the pipeline is broken and Step 4 doesn't proceed.

---

## 9. Dependencies and known risks

**Dependencies (all met):**
- `track_lyrics` populated (Phase B of `PLAN_LYRICS_CREDITS_1.md` — done)
- `track_credits` + `track_credits_status` populated (Phase C — done)
- `track_isrc_cache` populated (Phase A — done)
- ReccoBeats audio features populated for library tracks (in progress — feature ships when coverage is sufficient for top 200 tracks)

**Risks:**

1. **LRCLIB coverage gaps for candidates outside Chris's library.** The current 75%+ coverage is for tracks Chris has played. For candidates surfaced by Spotify search (especially obscure covers), LRCLIB may not have lyrics. Expect to drop ~20-30% of Spotify-search candidates at the lyric verification gate purely due to missing lyrics, not failed matches. Mitigate by explicitly tracking "lyric_unavailable" as a separate disposition from "lyric_mismatch" so we don't count the gaps as feature failures.

2. **Spotify search surfaces a lot of garbage for short titles.** "Words" is a near-worst-case (3,000+ Spotify tracks named "Words"). The lyric gate handles this, but pulling lyrics for 30 candidates per seed isn't free. Cap at top 30 results from Spotify search; if a seed has more than 30 plausible candidates, MB work expansion has to carry the load.

3. **ReccoBeats may not have features for very obscure candidates.** Drop those silently rather than ranking them with placeholder values.

4. **MusicBrainz rate limit (1 req/sec) means batch backfill of 200 seeds takes ~15-30 min just for MB calls.** Acceptable for offline batch; not acceptable for synchronous on-demand. The API endpoint in Step 4 must read from cache by default and only run live search when explicitly requested with a flag.

5. **The two seed examples are both popular Western pop songs.** Validation against them might give false confidence. Spot-check Step 2 against at least 5 less-canonical seeds (electronic, indie, non-English, older catalog) before trusting the false-positive rate.

---

## 10. Open questions

These were open at planning time. Step 1 answers some directly.

**Answered by Step 1 itself (no decision needed before starting):**
- Where the calibration spike lives in the repo: `docs/experiments/cover-detection-2026-05/`, matching the `lyric-analysis-2026-05` pattern.
- Whether Jaccard 5-shingles or Voyage-3.5 embeddings is the right lyric similarity metric: Step 1 Part B compares both empirically.
- Whether the proposed audio weighting scheme works: Step 1 Part C compares three schemes empirically.

**Still open, to revisit after Step 1:**
- For Path A (Step 2+), when an MB recording lacks an ISRC, what's the fuzzy-match threshold for resolving it to a Spotify track? Likely normalized-title match plus duration delta plus artist overlap, but the tolerance values are guesses until tested against real data.
- Should the discovery feed (§6) be a separate Pages route or live inside an existing surface? Defer until UI step.
- Is the top-200-most-played seed pool the right batch size for Step 3, or should it scale with library size? Defer until coverage of Step 2 results is visible.

---

*Authored: 2026-05-04. Status: planning. Sequencing: pending decision on whether to slot before or after current top priorities.*
