# Decisions: Ripples Scoring Fix — Split Logic + Familiarity Math

## Bug restatement

**Bug 1: Split misclassification.** The New Arrivals / Returning Waves split uses `lifetime_plays <= 5 AND first_play within 30 days` to identify new arrivals. Chris binge-listens to new discoveries (30 plays in a week is normal), so `lifetime_plays <= 5` is blown past within hours of first hearing a track. Result: 8 of 10 tracks in the first snapshot landed in "Returning Waves" despite being genuine first-week discoveries.

**Bug 2: Familiarity inflation.** The familiarity score computes artist/track percentile rank using total lifetime plays, which includes the current 14-day window's plays. A brand-new artist played 30 times this week ranks high in the percentile distribution — making them *look* familiar precisely because they're rippling hard. jigitz (a never-before-heard artist) scored 88 familiarity.

---

## Proposed fix: Split logic (D3 replacement)

**New rule:**

- **New Arrival:** `first_play_ts >= (window_end - 21 days)`
- **Returning Wave:** everything else

**Drop the `lifetime_plays` threshold entirely.** It serves no purpose when the discriminating signal is "when did this track first appear in the library." A track first heard 4 days ago is a new arrival whether it has 3 plays or 30.

**Why 21 days (not 30, not 14):**
- 14 days = the ripple window itself. A track first heard on day 14 of the window (the oldest edge) would barely qualify. Too tight.
- 30 days = from the original spec, but it allows a track first heard 4 weeks ago to be called a "new arrival" even though it's had 2 full weeks to settle.
- 21 days = 1 week before the window opened. Catches any track discovered in the run-up to or during the current ripple window. A track first heard 22 days ago has had a week of "settling in" before the window even started — that's a returning wave.

**Boundary case:** A track first heard exactly 21 days ago (to the second) is a New Arrival (`>=`, inclusive). At 21 days + 1 second, it's a Returning Wave.

**Note:** The 21-day threshold is tunable and worth revisiting after a few weeks of live data. It may need adjustment once we see how it behaves across different listening patterns.

**Sanity check against smoke-test data:**

| Track | First heard | 21-day rule | Correct? |
|-------|-------------|-------------|----------|
| Madison Beer - bittersweet | ~2 days ago | New Arrival | ✓ |
| jigitz - car crash | 7 days ago | New Arrival | ✓ |
| Waylon Wyatt - Didn't Forget | 4 days ago | New Arrival | ✓ |
| Martin Bandz - Radio | 8 days ago | New Arrival | ✓ |
| Kevin Morby - Javelin | ~5 days ago | New Arrival | ✓ |
| Willow Avalon - The Actor | 4 days ago | New Arrival | ✓ |
| Disco Lines - All I Want Is You | unclear (pre-window plays exist) | Likely Returning Wave | ✓ |
| Zach Bryan - DeAnn's Denim | rediscovered after 108 days | Returning Wave | ✓ |
| T.I. - LET 'EM KNOW | 23/25 plays in window, first_play likely old | Returning Wave | ✓ |
| Dennis Lloyd - Nevermind | rediscovered after 626 days | Returning Wave | ✓ |

---

## Proposed fix: Familiarity math

**Core change:** Familiarity percentile ranks should be computed against **pre-window play counts** (plays where `ts < window_start`).

### What changes in `generate.ts`:

1. **Artist percentile query:** Change from `COUNT(*) FROM plays GROUP BY artist_name` to `COUNT(*) FROM plays WHERE ts < ? GROUP BY artist_name` (binding `windowStart`).

2. **Track percentile query:** Change from `COUNT(*) FROM plays GROUP BY spotify_track_uri` to `COUNT(*) FROM plays WHERE ts < ? GROUP BY spotify_track_uri` (binding `windowStart`).

3. **Per-track familiarity input:** `artist_lifetime_plays` and `track_lifetime_plays` passed to `computeFamiliarityScore` should use the pre-window counts, not total counts.

### What about `computeFamiliarityScore` itself?

No change needed. The function takes data as input and does math — it doesn't know whether the data is pre-window or lifetime. The fix is at the call site (supply correct data).

### What about era familiarity?

The median release year query uses `SELECT year FROM plays WHERE year > 0 ORDER BY year LIMIT 1 OFFSET COUNT/2`. This is the median *play year* (the `year` column in `plays`), not release year — it represents when Chris listened, not when the track was released.

**Wait — this is actually wrong regardless of the window bug.** The `year` column in `plays` is the year the play happened (extracted from `ts`), not the release year. The era familiarity component is supposed to compare the track's *release year* (fetched from Spotify) against Chris's preferred *release year era* (what era of music he likes). Using play-year as proxy for preferred-release-year-era is a rough approximation that happens to work (Chris mostly listens to music from eras he likes). But it's not affected by the window bug in the same way — 14 days of plays barely shift the median of a 15-year listening history.

**Decision: Drop the era component to 0% weight in this kickoff. Reweight to 62.5% artist + 37.5% track.**

The era component is comparing the track's release year (correctly fetched from Spotify) against the median *play year* (the `year` column in `plays`, which is when Chris listened, not when the track was released). These are semantically different:
- Median play year ≈ 2019–2020 (midpoint of 15 years of listening)
- Median preferred release era = unknown (we'd need release years for all ~260K plays, which we don't have cached)

A 20% weight on a broken comparison is unacceptable noise. Dropping to 0% now. Can add era back later if we build a release-year cache across the library.

**Changes:**
- `computeFamiliarityScore` in `scoring.ts`: remove era logic, reweight to 62.5% artist + 37.5% track (or equivalently, `artistPercentile * 0.625 + trackPercentile * 0.375`). The 62.5:37.5 ratio is a deliberate carry-over of the original 50:30 artist:track weighting — same proportion, renormalized to sum to 100% without the era term.
- Remove `release_year` and `median_release_year` from `FamiliarityInput` interface (or make them unused/optional — cleaner to remove)
- Remove the median release year query from `generate.ts` (dead code)
- Keep the Spotify metadata fetch (still needed for `album_art_url`)
- Update `computeFamiliarityScore` tests accordingly

### Impact on scores:

For jigitz (0 plays before window): artist percentile will drop to 0 (or whatever the minimum is). Track percentile will also be 0. Expected familiarity: ~10-20 instead of 88. This correctly reflects "brand new, unfamiliar artist."

For Zach Bryan (massive pre-window history): score stays high. Correct.

---

## Files and functions that will change

| File | Function/Section | Change |
|------|-----------------|--------|
| `src/ripples/scoring.ts` | `splitArrivalsAndWaves` | Remove `lifetime_plays <= 5` check, use only `first_play_ts >= (windowEnd - 21 days)` |
| `src/ripples/scoring.ts` | `computeFamiliarityScore` | Drop era component, reweight to 62.5% artist + 37.5% track |
| `src/ripples/scoring.ts` | `FamiliarityInput` interface | Remove `release_year` and `median_release_year` fields |
| `src/ripples/scoring.test.ts` | `describe("splitArrivalsAndWaves")` | Update tests to reflect new rule |
| `src/ripples/scoring.test.ts` | `describe("computeFamiliarityScore")` | Update tests for new weights, remove era tests |
| `src/ripples/generate.ts` | Step 5 — artist percentile query | Add `WHERE ts < ?` filter |
| `src/ripples/generate.ts` | Step 5 — track percentile query | Add `WHERE ts < ?` filter |
| `src/ripples/generate.ts` | Step 5 — median release year query | Remove (dead code) |
| `src/ripples/generate.ts` | Step 7 — familiarity input | Pass pre-window artist/track plays, remove release_year/median fields |

---

## Tests to update / add

### Update (in `scoring.test.ts`):

1. **"classifies low-lifetime recent-first-play as new arrival"** — Remove the `lifetime_plays: 3` setup, just test that `first_play_ts` within 21 days = new arrival regardless of lifetime plays.
2. **"classifies high-lifetime as returning wave"** — This test currently uses `lifetime_plays: 20` as the signal. Change to use `first_play_ts` older than 21 days.
3. **"classifies low-lifetime but old first-play as returning wave"** — Rename/reframe: a track with old `first_play_ts` is returning wave regardless of play count.
4. **"requires first_play_ts to be non-null for new arrival"** — Keep as-is (still valid).

### Add (in `scoring.test.ts`):

5. **"classifies high-lifetime recent-first-play as new arrival"** — `lifetime_plays: 30, first_play_ts: 5 days ago` → New Arrival. This is the exact bug case.
6. **"boundary: first_play exactly 21 days ago is new arrival"** — inclusive boundary test.
7. **"boundary: first_play 21 days + 1 second ago is returning wave"** — exclusive boundary test.

### No tests deleted — 4 updated, 3 added.

---

## Ambiguities / flags

1. **The `first_play_ts` data is already available.** It's computed in the existing step 3 query as `MIN(ts)`. No additional query needed. The index `idx_plays_uri` on `spotify_track_uri` makes this cheap.

2. **Pre-window percentile queries on 260K rows.** The query `SELECT COUNT(*) FROM plays WHERE ts < ? GROUP BY artist_name ORDER BY cnt ASC` adds a WHERE clause to an existing full-table scan. The `idx_plays_ts` index should help, but this is a grouped aggregate over ~250K rows. Should still be fast on D1 (sub-second), but flagging it.

3. **Zero pre-window plays: percentile rank behavior confirmed.** Artists/tracks with zero pre-window plays won't appear in the `GROUP BY` results from the pre-window query. When we look them up, we pass `0` as their play count to `percentileRank`. The `percentileRank` function iterates the sorted array counting values `<= 0`. Since play counts are always `>= 1` in the grouped results (you need at least 1 play to appear), no values will be `<= 0`, so `count = 0` and the result is `0 / N * 100 = 0`. No NULL handling issue — clean zero.

   The percentile distribution itself is computed from the same pre-window-filtered universe (`WHERE ts < window_start`). Artists/tracks that ONLY have plays in the current window don't appear in the distribution at all, so they don't inflate anyone else's rank either. Everyone's percentile is computed against the same pre-window universe.

4. **The `computeRippleScore` function uses `lifetimePlays` (total, including window).** This is intentional and correct — the ripple score formula `weighted_recent / (lifetime + 3)` should use total lifetime to prevent brand-new tracks from dominating purely by recency. No change needed here.
