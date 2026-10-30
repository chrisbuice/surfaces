# [SUPERSEDED — merged into PLAN_COVERS_2.md on 2026-05-05]

# PLAN_COVERS_2.md — v2.1 Amendment: Path C (same-artist title search)

> This amends §3 (Pipeline shape) and §10 (Decisions locked in) of PLAN_COVERS_2.md. It does not replace the full document.

## Problem

Path A (MB work expansion) does not find same-artist remixes that are orphaned from the MB work. This is a structural limitation of MusicBrainz's data model, not a coverage gap (see `docs/decisions_2026-05-05_path_a_limitations.md`).

The canonical example: Birdy "Words" has MB work `3ec51142`, which links 1 recording (the original). The EDX Remix exists in MB but is orphaned — no `performance` relation connects it to the work. Path A finds 1 recording, Path B searches Spotify for `track:"Words"` and gets 15 unrelated songs. Neither path reaches the remix.

## Validated hypothesis

Spotify search with `track:"{base_title}" artist:"{seed_artist}"` surfaces the EDX Remix at position 5 of 9 results. It also surfaces:
- Birdy "Words - Blonde Remix" (another remix not found by Path A or B)
- Birdy "Words as Weapons" (different song — lyric gate rejects)
- Multiple re-releases of the original (already found by other paths)

Tested on two other seeds:
- `track:"Levitating" artist:"Dua Lipa"` — returns 8 results, all DaBaby variants already found. No new unique candidates, no harm.
- `track:"Hallelujah" artist:"Jeff Buckley"` — returns 9 results including live recordings. Overlaps with Path A discoveries. Additive for Sin-é live and Radio Edit.

## §3 delta: Path C (same-artist title search)

Insert after Path B in the pipeline diagram:

```
   │   Path C: Same-artist title search
   │   ──────────────────────────────────
   │   1. base_title = same normalization
   │      as Path B
   │   2. Spotify search:
   │      track:"{base_title}"
   │      artist:"{seed_artist}"
   │   3. Take top 10 results
   │   4. Drop the seed URI itself
   │   5. Drop tracks where normalized
   │      title AND artist both exactly
   │      match the seed (these are
   │      re-releases of the seed, not
   │      alternate versions)
   │   6. Tag method='spotify_artist_search'
```

### Stage notes for Path C

**Why a separate path, not a modification of Path B.** Path B searches `track:"{base_title}"` without an artist constraint, casting a wide net for cross-artist covers. Path C constrains to the seed artist, targeting same-artist remixes, live recordings, and alternate arrangements. The two searches return different result sets — Path B optimizes for recall across artists, Path C for same-artist variant recall.

**Same-artist filter logic differs from Path B.** In Path B, the filter drops tracks where artist exactly matches seed *unless* title differs (to keep remixes). In Path C, all results are by the seed artist, so the filter must be title-based only: drop tracks where the normalized title exactly equals the seed's normalized title. This keeps "Words - EDX Remix" (normalizes to "Words - EDX Remix", differs from "Words") while dropping "Words" re-releases from other albums (normalizes to "Words", matches seed).

**Deduplication.** Candidates found by Path C that were already found by Path A or B get their `match_method` updated to `'both'` (or a new compound value). The candidate itself is not duplicated.

**Cost.** 1 additional Spotify search per seed (same rate as a single Path B page). Minimal incremental cost.

### What Path C does NOT find

- Cross-artist covers (Path A and B handle these)
- Same-artist recordings not on Spotify (Path A handles these via MB)
- Remixes where the remix artist is credited as the primary artist and the original artist is absent from credits (e.g., "EDX feat. Birdy" instead of "Birdy" — this doesn't appear to be the case for any known examples but is theoretically possible)

## §10 delta: Decisions list update

Add:
- **Path C:** same-artist title search on Spotify, `track:"{base_title}" artist:"{seed_artist}"`, top 10 results, drop seed URI and same-title re-releases. Tagged `spotify_artist_search`.
- **match_method values:** `'mb_work'` | `'spotify_search'` | `'spotify_artist_search'` | `'both'` (found by multiple paths).

## Implementation scope

Path C is a small addition to `scripts/find-covers.ts`:
- ~15 lines of search + filter logic, inserted between Path B and the lyric gate
- No schema changes (uses existing `match_method` column, new value `'spotify_artist_search'`)
- No threshold changes
- No new API dependencies

Step 3 batch backfill should run with Path C active so the production dataset reflects all three paths.

---

*Proposed: 2026-05-05. Status: pending Chris's review before implementation.*
