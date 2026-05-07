# Decisions: Ripples LLM Fix — Artist Context + Variety

## Issue restatement

**Issue 1: Missing artist context in LLM input.** The `buildFactPrompt` function sends `artist_lifetime_plays` and `artist_percentile_rank` to the LLM, but NOT `artist_plays_before_window`. The LLM sees a track with `days_since_first_play: 14` and an artist with high lifetime plays, but can't distinguish "new track from a long-loved artist" from "brand new artist discovered this week." Result: the model said "discovered T.I. three weeks ago" for an artist Chris has listened to for years. The data for this distinction (`artist_plays_before_window`) already exists in `FactInput` — it's just not passed to the prompt.

**Issue 2: Repetitive "discovered..." framing.** 4 of 9 LLM facts in the first snapshot opened with "discovered..." This is a variety problem. Since calls are independent (parallel `Promise.all`), the LLM gravitates toward its default framing for "new thing" = "discovered." The system prompt needs stronger guidance to pick the most specific angle rather than defaulting to the most obvious one.

---

## Current LLM input bundle structure

### `FactInput` interface (from `facts.ts`):

```typescript
export interface FactInput {
  track_name: string;
  artist_name: string;
  lifetime_plays: number;
  plays_in_window: number;
  weighted_recent_plays: number;
  first_play_ts: number | null;
  last_play_before_window_ts: number | null;
  artist_lifetime_plays: number;
  artist_percentile: number;
  is_new_arrival: boolean;
  window_end: number;
  artist_plays_before_window: number;  // ← EXISTS but not sent to LLM
  track_plays_before_window: number;
  avg_weekly_rate: number;
}
```

### Current system prompt:

```
You describe a friend's listening habits in one short phrase. Be specific to the data provided. Never be generic or complimentary. No emoji, no quotation marks. Output exactly one phrase, 6-10 words (hard cap 12 words). End with a period or no punctuation. Examples of good output:
- first Big Thief track to actually stick.
- back after a two-year gap.
- 9 plays since Tuesday, was background before.
- discovered via the algorithm last week.
```

### Current user prompt data bundle (JSON sent to LLM):

```json
{
  "track": "...",
  "artist": "...",
  "lifetime_plays": 25,
  "plays_last_14_days": 23,
  "weighted_breakdown": { "days_1_to_3_weight": 3.0, "days_4_to_7_weight": 2.0, "days_8_to_14_weight": 1.0, "weighted_total": 42 },
  "days_since_first_play": 14,
  "days_since_last_play_before_window": null,
  "artist_lifetime_plays": 800,
  "artist_percentile_rank": 95,
  "classification": "returning_wave"
}
```

**Missing:** No `artist_plays_before_window` or `track_plays_before_window`. No explicit "is the artist new to this listener" signal.

---

## Proposed new input bundle

Add three fields to the JSON sent to the LLM:

```json
{
  "track": "...",
  "artist": "...",
  "lifetime_plays": 25,
  "plays_last_14_days": 23,
  "weighted_breakdown": { ... },
  "days_since_first_play": 14,
  "days_since_last_play_before_window": null,
  "artist_lifetime_plays": 800,
  "artist_percentile_rank": 95,
  "artist_plays_before_window": 775,      // ← NEW
  "track_plays_before_window": 2,          // ← NEW
  "classification": "returning_wave",
  "artist_relationship": "long-time favorite"  // ← NEW (derived label, see below)
}
```

The `artist_relationship` field is a derived human-readable label to make the tiered guidance unambiguous for the LLM. Three tiers:

| `artist_plays_before_window` | `artist_relationship` label | LLM guidance |
|-----|------|------|
| 0 | `"brand new"` | "discovered" framing OK |
| 1–49 | `"trace history"` | Soft framing — neither "discovered" nor "long-loved" |
| 50+ | `"established"` | Frame around the track, never the artist |

**Why these thresholds (validated against actual distribution):**
- 0 plays: genuinely never heard before.
- 1–49: captures ~11,566 artists — long-tail noise, one-off playlist appearances, peripheral familiarity. Not "discovered" but not meaningfully known either.
- 50+: captures ~964 artists (~top 8%) — real, multi-year engagement. Chris has genuine history with these artists.

Four tiers was over-engineered for what's fundamentally a binary decision the LLM is making ("can I say 'discovered' or not"), with a soft middle ground for edge cases.

Thresholds are on pre-window plays, so current-window binges don't inflate the relationship label.

**Data source:** `artist_plays_before_window` is already computed in `generate.ts` (line 264: `const artistPlaysBefore = artistBeforeRow?.cnt || 0`). No new queries needed.

---

## Proposed new system prompt

```
You write one short phrase describing why a friend is playing a specific track right now. You know this friend's full listening history. Be specific to the data. Never generic, never complimentary.

CRITICAL — artist relationship context:
- If artist_relationship is "brand new": you may say "discovered" or "first time hearing" the artist.
- If artist_relationship is "trace history": soft framing — do NOT say "discovered" and do NOT say "long-loved." The listener has barely encountered this artist before.
- If artist_relationship is "established": NEVER frame as discovering the artist. The story is about the TRACK, not the artist. What's notable is why THIS track is getting heavy play right now — is it new? returning? spiking?

VARIETY — pick the most specific angle available:
- If there's a gap (days_since_last_play_before_window), lead with the return.
- If the play count is dramatic (e.g., 20+ in a week), lead with the number.
- If the track is brand new but the artist is known, frame as "new [artist] track" territory.
- If nothing else stands out, describe the listening pattern (e.g., "morning-only obsession" or "3 days straight").
- Do NOT default to "discovered X days ago" unless the artist is genuinely brand new.

Format: exactly one phrase, 6–10 words (hard cap 12). No emoji, no quotation marks. End with a period or no punctuation.

Examples of good output:
- first Big Thief track to actually stick.
- back after a two-year gap.
- 9 plays since Tuesday, was background before.
- new T.I. track, immediately on heavy rotation.
- 24 plays in eight days, came from nowhere.
- quiet Kevin Morby deep cut finally clicked.
```

---

## Variety approach

**Within independent per-call generation (no batching):**

The repetition problem ("discovered...") stems from the LLM defaulting to the most obvious framing when instructions are vague. The fix is prescriptive: the "VARIETY" section of the system prompt provides a priority ladder of angles to pick from. By asking the LLM to pick "the most specific angle available" and giving concrete alternatives, each call will gravitate toward the strongest signal in its data — which will naturally differ track to track.

This won't guarantee zero repetition (two tracks with very similar data profiles may still produce similar framing), but it should dramatically reduce the 4/9 repetition rate we saw.

**Not proposing batched generation.** The parallel per-call approach is simpler, has clean partial-failure handling, and the variety problem is addressable within per-call prompting. If repetition persists after this fix, we can revisit.

---

## Hardcoded fact ladder fix

The current ladder already checks `artist_plays_before_window === 0` for rung 1 ("first time hearing"). This is correct — it won't fire for T.I. (who has 775 pre-window plays). 

However, rung 2 ("new from {artist}") fires when `track_plays_before_window <= 2` regardless of artist familiarity. This is fine — "new from T.I." is a correct fallback for the T.I. case. No change needed to the ladder logic.

The issue was purely in the LLM prompt, not the fallback.

---

## Files and functions that will change

| File | Function | Change |
|------|----------|--------|
| `src/ripples/facts.ts` | `buildFactPrompt` | Add `artist_plays_before_window`, `track_plays_before_window`, and `artist_relationship` to user JSON. Rewrite system prompt. |
| `src/ripples/facts.ts` | (new helper) | Add `getArtistRelationship(preWindowPlays: number): string` pure function for the tier labels |
| `src/ripples/facts.test.ts` | (new tests) | Test `getArtistRelationship` thresholds. Test that `buildFactPrompt` includes artist context in output. |

**No changes to:**
- `generate.ts` — `artist_plays_before_window` and `track_plays_before_window` are already in `FactInput` and passed correctly.
- `scoring.ts` — no scoring changes.
- `pickHardcodedFact` — already uses `artist_plays_before_window` correctly.
- `validateLLMFact` — no changes to validation rules.

---

## Tests to update / add

### In `facts.test.ts`:

**New tests:**

1. `getArtistRelationship` returns correct tier labels:
   - 0 → "brand new"
   - 25 → "trace history"
   - 49 → "trace history"
   - 50 → "established"
   - 500 → "established"

2. `buildFactPrompt` includes `artist_relationship` and `artist_plays_before_window` in the user message JSON.

3. `buildFactPrompt` includes `track_plays_before_window` in the user message JSON.

**No existing tests need updating** — `pickHardcodedFact` tests already pass with correct behavior, and `validateLLMFact` tests are unchanged.

---

## Ambiguities / flags

None. The data is already available, the change is scoped to prompt construction, and the parallel call structure is unchanged.
