# Cover & Alternate-Version Discovery — v2

> Find recordings of compositions Chris loves that share lyrics — covers, remixes, reworks, translations, acoustic versions, club versions. Surface them whether they're already in the library or not. Display them in two sections when both apply: production-shift covers ("Different sonic worlds") and register-shift covers ("Alternate versions"). The seed examples are Birdy "Words (EDX Remix)", Milky Chance's "Levitating", Whitney Houston's "I Will Always Love You", and Buckley's "Hallelujah" — same songs, different versions.

This is a discovery feature. The output, per seed track, is a set of alternate recordings of that song, organized into two display sections that reflect what the audio analysis can actually distinguish.

This builds on the lyrics + credits backfill (`PLAN_LYRICS_CREDITS_1.md`, complete) and the ReccoBeats audio-features backfill. Nothing in those pipelines changes; this is purely additive.

**This document supersedes `PLAN_COVERS_1.md`.** v1 was a planning document written before the Step 1 calibration spike (`docs/experiments/cover-detection-2026-05/results.md`). v2 incorporates what the spike measured. The spike fundamentally changed the design of the audio-distance signal — what was framed as a universal ranking became a binary segmentation — and removed several mechanisms (songwriter-overlap booster, multi-metric lyric scoring) that the data showed were unnecessary. v1 should not be used for implementation; refer to v2.

---

## 1. What Step 1 measured and what it changes

The calibration spike validated some assumptions, rejected others, and surfaced one fundamental limitation that reshaped the feature:

**Validated:**
- Lyric matching cleanly identifies same-composition pairs. Jaccard 5-shingle on normalized text produces a clean gap between known-positive cover pairs (range 0.19–0.90) and unrelated tracks (range 0.000–0.006). A threshold of 0.05 has 0.045 margin above the worst negative and 0.141 margin below the worst positive across 17 cover pairs and 17 negatives.
- Bon Jovi's "It's My Life" and Talk Talk's "It's My Life" — same title, different compositions — score 0.0035, comfortably in the negative range. The lyric gate handles high-production-value title collisions cleanly.

**Rejected:**
- Voyage-3.5 embeddings as the lyric metric. Embeddings produce a tighter positive cluster (cosine 0.92–1.00) but a much higher noise floor — unrelated tracks routinely score 0.69–0.77 cosine because embeddings capture thematic/emotional similarity. For binary classification, lower noise floor wins. Jaccard is also cheaper. Don't use embeddings for the gate.
- The "songwriter-overlap booster" mechanism from v1 §3. With Jaccard's clean gap, no borderline zone exists for the booster to operate in. Drop the mechanism entirely.
- Tempo+energy=2x weighting. All three weighting schemes (uniform, T+E 2x, four-genre 2x) produced equivalent relative orderings. Per Occam's razor, use uniform weighting if audio distance is computed.

**Fundamental limitation surfaced:**
- ReccoBeats' 9-feature space captures production-level sonic properties but does not capture cultural register. Whitney Houston ↔ Dolly Parton "I Will Always Love You" scores audio distance 0.33, comparable to two Dua Lipa tracks from the same album (0.38). Both versions are slow-tempo, female-vocal-forward, sparse-instrumentation, low-energy ballads. The cultural distance between 1974 country and 1992 power ballad is large; the *acoustic* distance is small. Same for Sinéad ↔ Prince "Nothing Compares 2 U" (0.23) and Buckley ↔ Cohen "Hallelujah" (0.45).
- This means audio distance is **not a universal ranking signal** for "different sonic universe." It works for production-shift covers (electronic ↔ acoustic, full-band ↔ stripped, distorted ↔ clean) and fails for register-shift covers (same instrumentation, different cultural register).

The original plan rested on audio distance being a universal ranking. v2 replaces that with a two-bucket segmentation, where audio distance is used at the resolution it can actually support.

For the full data and reasoning, see `docs/experiments/cover-detection-2026-05/results.md`.

---

## 2. Sources, and what each contributes

| Source | Already in DB? | Role |
|---|---|---|
| `track_lyrics` (LRCLIB) | Yes — coverage growing | Composition fingerprint via Jaccard 5-shingle (the gate) |
| `track_credits` (MusicBrainz works) | Yes — ≥60% | (a) Display-only "shared writers" tag; (b) `mb_work_id` → all linked recordings as a candidate generator |
| `track_credits_status.mb_work_id` | Yes | Direct work link for Path A candidate enumeration |
| ReccoBeats audio features | Yes — backfill in progress | Bucket assignment (production-shift vs register-shift) plus per-pair feature deltas for display |
| Spotify Search API | Wrapper exists | High-recall candidate generator: title search across catalog |
| Spotify track popularity | Available via API | Within-bucket sort key for not-in-library candidates |

What is **not** needed: Voyage embeddings (rejected), Essentia/AcousticBrainz (not justified for this feature), audio fingerprinting, songwriter-overlap-as-threshold-modifier (mechanism dropped).

---

## 3. Pipeline shape

For a given seed track URI, the pipeline produces a set of alternate recordings organized into display sections:

```
seed_track_uri
   │
   ├──[candidate generation, parallel]──────────────────────┐
   │                                    │                    │
   │   Path A: MB work expansion        │ Path B: Title     │ Path C: Same-artist
   │   ──────────────────────────       │ search            │ title search
   │   1. mb_work_id from               │ ──────────────    │ ──────────────────
   │      track_credits_status          │ 1. base_title =   │ 1. Same base_title
   │   2. GET /ws/2/work/{id}           │    strip markers  │ 2. Spotify search:
   │      ?inc=recording-rels           │ 2. Spotify search:│    track:"{base_title}"
   │   3. For each linked recording,    │    track:"{title}"│    artist:"{seed_artist}"
   │      resolve to Spotify URI via    │ 3. Top N, drop    │ 3. Top 10, drop seed
   │      ISRC or fuzzy match           │    seed itself    │    and same-title
   │   4. Set found_via_mb_work=1       │ 4. Set found_via_ │    re-releases
   │                                    │    spotify_search │ 4. Set found_via_
   │                                    │    =1             │    spotify_artist_
   │                                    │                    │    search=1
   └──────────[merge candidates, dedupe by URI]─────────────┘
                  │
                  ▼
   ┌─────────[lyric gate]────────────────────────┐
   │ For each candidate, fetch its LRCLIB lyrics │
   │ Compute Jaccard similarity vs seed lyrics   │
   │ Drop candidates below threshold 0.05        │
   │ (binary decision; no confidence ranking)    │
   └─────────────────────────────────────────────┘
                  │
                  ▼
   ┌─────────[audio bucket assignment]───────────┐
   │ For each surviving candidate, fetch         │
   │ ReccoBeats features (try alternate URIs     │
   │ if primary fails — see §6)                  │
   │ Compute uniform weighted euclidean distance │
   │ vs seed features (all 9 features, weight 1) │
   │ Assign bucket:                              │
   │   distance >= 0.7 → "different_sonic_world" │
   │   distance < 0.7  → "alternate_version"     │
   │   no audio data   → "alternate_version"     │
   │                     with no_audio_data tag  │
   └─────────────────────────────────────────────┘
                  │
                  ▼
   ┌─────────[within-bucket sort]────────────────┐
   │ different_sonic_world bucket:               │
   │   sort by audio_distance desc               │
   │   (audio ordering IS meaningful here —      │
   │   only the ABSOLUTE level fails)            │
   │                                             │
   │ alternate_version bucket:                   │
   │   primary sort: in-library before not       │
   │   in-library sort: by release date desc     │
   │     (recency of the candidate recording)    │
   │   not-in-library sort: by Spotify           │
   │     popularity score desc                   │
   └─────────────────────────────────────────────┘
                  │
                  ▼
        two-section result
        (display only populated sections)
```

### Stage notes

**Path A (MB work expansion).** Cheap when `track_credits_status.mb_work_id` is populated. Lookup is one MB API call per seed. The recordings list usually includes an ISRC; resolve to Spotify via the existing ISRC client. For recordings without ISRC, fall back to fuzzy artist+title match on Spotify.

**Path B (Spotify title search).** Title normalization: strip everything in `()` or `[]`, drop trailing markers like " - Remix", " - Live", " - Acoustic", " - 2021 Remaster", and "feat./ft./featuring" clauses. Spotify search with `track:"{normalized}"`. Take top ~30 by relevance (paginated at 10/page due to Dev Mode limits), drop the seed track, drop tracks where artist exactly matches seed *unless* title differs.

**Path C (same-artist title search).** Searches Spotify with `track:"{base_title}" artist:"{seed_artist}"`. Takes top 10 results (no pagination needed — artist-scoped searches are targeted). Drops the seed URI. Drops tracks where the normalized title exactly equals the seed's normalized title AND the candidate's original (non-normalized) title contains no remix/live/demo/acoustic/version markers — these are re-releases of the seed from other albums, not alternate versions. Keeps tracks like "Words - EDX Remix" (has a marker) while dropping "Words" from a deluxe edition (no marker, same normalized title).

**Why Path C exists:** MusicBrainz models remixes as orphaned recordings not linked to the parent work. Path A cannot find same-artist remixes that lack a `performance` relation. Path B's generic title search drowns in unrelated songs (especially for short titles like "Words"). Path C is the only reliable way to surface same-artist remixes, live recordings, demos, and acoustic versions that are orphaned in MB. See `docs/decisions_2026-05-05_path_a_limitations.md`.

**Lyric gate.** Threshold 0.05, Jaccard on word 5-shingles, normalization per spike (lowercase, strip punctuation, collapse whitespace, drop section markers like `[Chorus]`). Binary decision only. The Jaccard score is preserved in the database for future analysis but is **not** displayed to the user as a confidence number — the spike showed it reflects lyric-file completeness more than match quality.

**Audio bucket assignment.** Threshold 0.7 on uniform-weighted euclidean distance with all 9 ReccoBeats features normalized to [0,1] (tempo / 250; (loudness + 60) / 60 clamped; others already in range). Threshold chosen from spike data — at 0.7, Levitating (1.31), Smooth Criminal (0.73), and Linger (0.77) sit in the upper bucket, while Whitney/Dolly (0.33), Nothing Compares (0.23), Hallelujah (0.45), and Landslide (0.55) sit in the lower. This boundary will need re-validation against a larger candidate pool in Step 3.

**Bucket label honesty.** The labels in the UI describe what the system actually measures, not user-facing aesthetic categories:
- "Different sonic worlds" = production-level acoustic transformation
- "Alternate versions" = same composition, similar acoustic profile

Avoid labels like "Radical reimaginings" or "Subtle alternates" because the spike showed the system can't reliably tell those apart at the cultural level (Hallelujah is culturally radical but acoustically similar; the system places it in the lower bucket honestly).

**Within-bucket sort: alternate_version.** Per Chris's product decisions:
- In-library candidates first, then not-in-library
- In-library: sort by release date of the candidate recording, descending (most recent first)
- Not-in-library: sort by Spotify popularity score, descending

**Within-bucket sort: different_sonic_world.** Audio distance descending. The relative ordering of high-distance pairs *is* meaningful — the spike's three weighting schemes all preserved the same relative order at the top end. Only the absolute distance value fails to mean what we want it to mean across all pairs, which is what the bucket boundary handles.

**Empty-bucket handling.** If a seed has zero candidates in one bucket, do not display that bucket. No "no alternates found in this category" placeholder. Display only what exists.

**Songwriter display.** Where `track_credits` data is available for both seed and candidate, surface a "Written by [shared writer name(s)]" tag on the candidate card. Display-only — does not affect bucket assignment, gate, or sort. This is the v2 replacement for the dropped songwriter-overlap-booster: same data, used for transparency instead of as a threshold-modifier.

---

## 4. Schema additions

Two new tables, one view. Migration 008.

### `composition_versions`

```sql
CREATE TABLE composition_versions (
  seed_track_uri TEXT NOT NULL,
  candidate_track_uri TEXT NOT NULL,
  candidate_track_name TEXT NOT NULL,
  candidate_artist_name TEXT NOT NULL,
  candidate_album_name TEXT,
  candidate_release_date TEXT,            -- ISO date or YYYY-MM-DD; for sort
  candidate_spotify_popularity INTEGER,   -- 0-100; for sort
  in_library INTEGER NOT NULL DEFAULT 0,
  match_method TEXT NOT NULL,             -- DEPRECATED: legacy text enum, kept for one cycle
  found_via_mb_work INTEGER NOT NULL DEFAULT 0,
  found_via_spotify_search INTEGER NOT NULL DEFAULT 0,
  found_via_spotify_artist_search INTEGER NOT NULL DEFAULT 0,
  mb_work_id TEXT,
  lyric_jaccard REAL NOT NULL,            -- always >= 0.05 since gate passed
  audio_distance REAL,                    -- NULL if no_audio_data
  audio_bucket TEXT NOT NULL,             -- 'different_sonic_world' | 'alternate_version'
  no_audio_data INTEGER NOT NULL DEFAULT 0,  -- 1 if ReccoBeats unavailable
  audio_feature_deltas_json TEXT,         -- per-feature signed deltas; NULL if no_audio_data
  shared_writers_json TEXT,               -- array of shared writer names; NULL if no credits
  found_at INTEGER NOT NULL,
  PRIMARY KEY (seed_track_uri, candidate_track_uri)
);

CREATE INDEX idx_composition_versions_seed ON composition_versions (seed_track_uri, audio_bucket, audio_distance DESC);
CREATE INDEX idx_composition_versions_candidate ON composition_versions (candidate_track_uri);
```

Note the dropped fields from v1: no `match_confidence`, no `writer_overlap_count` as a numeric weight (it's now a display-only string array), no `lyric_similarity` as a separate normalized score (Jaccard *is* the score, named accordingly).

### `composition_seeds`

```sql
CREATE TABLE composition_seeds (
  seed_track_uri TEXT PRIMARY KEY,
  last_searched_at INTEGER NOT NULL,
  search_method TEXT NOT NULL,
  candidates_found INTEGER NOT NULL,
  candidates_kept INTEGER NOT NULL,         -- after lyric gate
  candidates_no_audio_data INTEGER NOT NULL, -- subset of kept; for monitoring
  source TEXT NOT NULL                      -- 'on_demand' | 'top_played_batch' | 'manual'
);
```

### View: `composition_versions_enriched`

Joins with play counts and lyric/credits status for UI rendering.

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

---

## 5. Build sequence (revised post-spike)

Step 1 is complete. The remaining steps are sketched here but the design is now grounded in real measurements.

### Step 2: Schema + offline batch script

- Migration 008: the two tables + view from §4
- A new script `scripts/find-covers.ts` that takes a seed URI, runs the pipeline, and writes results to `composition_versions`
- Run manually against the four canonical seeds: Birdy "Words", Dua Lipa "Levitating", Whitney Houston "I Will Always Love You", Jeff Buckley "Hallelujah". These cover both buckets — the first two should produce upper-bucket Levitating/EDX results, the latter two produce lower-bucket Dolly/Cohen results. Both behaviors must be observable.
- Run against the top 20 most-played tracks; spot-check 3-5 results for false positives at the lyric gate (which should be zero given the spike's measured 0.045 margin) and bucket-assignment sanity (high-distance pairs are upper, low-distance pairs are lower).
- **Step 2 gate:** false-positive rate at lyric gate is zero on spot check (anything else means production data has properties the spike didn't, requiring re-investigation). Bucket assignments match expectations on the four canonical seeds.

### Step 3: Batch backfill + threshold robustness validation

- Run `find-covers.ts` against the top 200 most-played tracks
- After population, run a threshold-robustness check: pick 10 random Spotify-search candidates per seed that *failed* the Jaccard gate. Manually verify they're not actually covers. The spike validated against 17 negatives; this validates against ~2,000.
- If any false negatives surface (real covers being rejected by the gate), revisit the threshold. Don't change it preemptively.
- Also during this step: monitor `candidates_no_audio_data` rates. The spike found ReccoBeats coverage gaps on iconic tracks (Nirvana, Robyn, Manson). Production-scale will surface the true coverage rate.
- **Step 3 gate:** lyric gate false-negative rate <5% on the random-sample check. Bucket distribution (% in upper vs lower) is reasonable across seeds — if 99% of candidates land in one bucket, the threshold needs revisiting.

### Step 4: API + MCP tool

- `GET /api/covers/:track_uri` on the Worker — returns the two-section result from cache, falls through to live search if uncached. Response shape mirrors §3 output: two arrays, each potentially empty, with the absent one omitted.
- MCP tool `find_covers(track_uri, max_results_per_bucket=10)` — same data structure
- Per the v1 plan: live search must be explicit (a `?refresh=true` flag or equivalent). MB rate limit (1 req/sec) makes synchronous on-demand expensive.

### Step 5: UI surface — "Different Worlds" view

Two surfaces:

**On any track page**, an "Alternate Versions" section. If both buckets are populated, render two subsections with their honest labels:
- "Different sonic worlds" (production-shift candidates)
- "Alternate versions" (same composition, similar acoustic profile)

If only one is populated, render only that one with the same label. Do not include a placeholder for the empty bucket.

Each candidate card shows: artist, track title, album, release year, sparkline of feature deltas (where audio data exists), "in library" badge if applicable, "Written by [shared writers]" tag where credits exist on both sides. Click to play.

**Standalone discovery feed.** Same logic, surfaced as a feed for browsing. Filterable by:
- "Versions of songs I've played 50+ times"
- "Versions I haven't played"
- "Different sonic worlds only" (filters to upper bucket across all seeds)
- "In my library" vs "On Spotify only"

### Step 6 (deferred): Ongoing capture

Cron-driven catch-up for newly-popular tracks. Defer until Steps 2-5 prove the feature is worth maintaining.

---

## 6. Production-pipeline insights from Step 1

These are real findings about the data infrastructure, separate from the calibration findings:

**ReccoBeats URI fallback.** Sinéad O'Connor's "Nothing Compares 2 U" most-played URI (43 plays, `3nvuPQTw2zuFAVuLsC9IYQ`) is missing from ReccoBeats, but a less-played duplicate URI (`5GHY1DFWKz3Prg2V0Iodqo`) is present. The production pipeline must try alternate Spotify URIs for the same recording when the primary lacks audio features. Implementation: when Path A or B yields a candidate URI that has no ReccoBeats features, query the Spotify API for other releases of the same recording (same ISRC), check those alternate URIs against ReccoBeats, use the first one that has features.

**ReccoBeats coverage is not popularity-based.** Iconic tracks (Nirvana "Smells Like Teen Spirit", Robyn "Dancing On My Own", Marilyn Manson "Sweet Dreams", Birdy "Words" original) are absent from ReccoBeats despite being canonical. The pipeline must handle "candidate exists, lyrics match, no audio data" as a normal case, not an edge case — surface in the lower bucket with the `no_audio_data` flag.

**Lyric file structural differences are real.** Cohen's "Hallelujah" has 80+ verses; different recordings include different subsets. Whitney Houston's "I Will Always Love You" has more chorus repeats than Dolly Parton's. LRCLIB stores what was performed in each recording, so two same-composition recordings can have meaningfully different lyric texts. This is what produces low Jaccard scores on the bottom of the positive range (0.19–0.30 for several pairs). It does not affect the gate decision (all still pass 0.05) but it does mean Jaccard score above the threshold should not be displayed as a confidence metric.

**Title-collision negatives include high-production-value cases.** Bon Jovi's "It's My Life" (2000) is not the song No Doubt covered (Talk Talk's 1984 song) despite identical title and overlapping cultural era. The lyric gate handles this cleanly (Jaccard 0.0035), but it's a reminder that title-based candidate generation will surface confidently-different songs that share titles. The gate is what catches them.

---

## 7. Out of scope for v2

- Live/acoustic vs club-remix taxonomy. Distance is distance; the bucket already segments at the relevant boundary.
- AcousticBrainz/Essentia. Not justified for this feature given Step 1 results.
- Mashups and interpolations. The lyric gate at 0.05 will mostly exclude these.
- Cover detection for compositions Chris hasn't played. Always seed from the library.
- Per-pair recommendation ("you'd like this cover"). The discovery surface lets Chris decide. We don't have evidence that any audio-distance band predicts liking.
- A confidence score displayed to the user for any cover. The spike showed Jaccard score above the threshold reflects lyric-file structure, not match quality. Don't fake it.

---

## 8. Coverage targets and what counts as success

After Step 3 batch backfill:

- **At least one alternate version found** for ≥40% of the top 200 most-played tracks.
- **Lyric gate false-positive rate** is zero on a 50-random-pair spot check across seeds. The Step 1 measurement was zero across 17 negatives with 0.045 margin; production-scale should preserve that.
- **Lyric gate false-negative rate** <5% on a 50-random-pair spot check of *rejected* candidates. This validates the threshold against the real-world title-collision distribution, which the spike's negative pool was too small to fully characterize.
- **Both seed-test pairs surface in their expected buckets:** Birdy "Words"/EDX and Levitating in the upper bucket; Whitney/Dolly and Buckley/Cohen in the lower. This is the canonical sanity check that the bucket boundary survives production.
- **No-audio-data rate <30%** of kept candidates. If higher, the URI-fallback mechanism (§6) needs improvement before the feature ships.

---

## 9. Risks and known unknowns

**1. Bucket boundary may need adjustment at scale.** The 0.7 threshold was chosen from 7 audio-eligible pairs in the spike. Production data may show a different natural boundary or no clean boundary at all. Step 3's monitoring should report bucket distribution; if it's pathological, recalibrate.

**2. Path B Spotify search remains noisy for short titles.** "Words" returns thousands of unrelated tracks; the lyric gate handles this but it's not free (lyrics fetch per candidate). Cap Path B at top 30 results per seed. If a seed has more than 30 plausible candidates, MB work expansion has to carry the recall.

**3. MB rate limit (1 req/sec) means batch backfill of 200 seeds takes ~10 minutes just for MB calls.** Acceptable for offline; not for synchronous on-demand. The API endpoint must read from cache by default.

**4. Spike validation focused on Western pop.** The full library includes deeper cuts, non-English tracks, electronic music with sparse vocals. The lyric gate may behave differently when LRCLIB coverage is poor or when lyric tokenization breaks on non-English text. Step 3's spot-check should explicitly include some non-English, electronic, and deep-catalog seeds.

**5. The "in-library before not-in-library" sort within the lower bucket may produce suboptimal ordering when the in-library candidate is an obscure cover and a not-in-library candidate is the canonical original.** Monitor user behavior in Step 5; if Chris frequently looks past in-library candidates to find a specific not-in-library one, revisit the sort.

---

## 10. Decisions locked in (Step 1 outputs and Chris's product calls)

For implementer reference, the values that are not up for debate:

- **Lyric metric:** Jaccard on word 5-shingles, after normalization (lowercase, strip punctuation, collapse whitespace, drop section markers).
- **Lyric gate threshold:** 0.05.
- **Lyric metric not used as a confidence score.** Binary decision only.
- **Audio weighting:** uniform (all 9 features at weight 1.0), normalized to [0,1] before distance.
- **Audio bucket boundary:** 0.7 uniform euclidean distance.
- **Empty bucket handling:** show only populated buckets.
- **Lower-bucket sort:** in-library first (sorted by release date desc), then not-in-library (sorted by release date desc — popularity field removed in Spotify Dev Mode, see `docs/decisions_2026-05-05_spotify_api_changes.md`).
- **Upper-bucket sort:** audio distance desc.
- **No-audio-data candidates:** placed in lower bucket with `no_audio_data` tag.
- **Songwriter overlap:** display-only ("Written by [shared writers]") tag, no effect on gate or ordering.
- **Voyage embeddings:** not used.
- **Songwriter-overlap booster:** mechanism dropped from plan.
- **Path C:** same-artist title search on Spotify: `track:"{base_title}" artist:"{seed_artist}"`, top 10 results, drop seed URI and same-title re-releases without markers. Targets orphaned same-artist remixes/live/acoustic versions not findable via Path A or B.
- **Match method tracking:** three boolean flags (`found_via_mb_work`, `found_via_spotify_search`, `found_via_spotify_artist_search`) replacing the legacy TEXT enum. A candidate may be found by 1, 2, or all 3 paths.
- **Path A must run from grimmauldplace** (MusicBrainz unreachable from Costa Rica residential IP — see `docs/decisions_2026-05-05_musicbrainz_block.md`).

---

*Authored: 2026-05-05. Revised: 2026-05-05 (v2.1 amendment merged — Path C added). Supersedes `PLAN_COVERS_1.md`. Status: Step 2 complete, ready for Step 3.*
