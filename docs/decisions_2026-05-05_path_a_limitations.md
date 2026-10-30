# Decision: Path A structural limitation — orphaned remixes (2026-05-05)

## Finding

The Step 2 grimmauldplace run validated that Path A (MB work expansion) works correctly for its intended scope: it resolves recordings officially linked to a MusicBrainz work. But the canonical test case — Birdy "Words" → EDX Remix — revealed a structural limitation in MB's data model that no Path A improvement can fix.

## Evidence

**Birdy "Words" work (`3ec51142-5b15-4faf-9c6e-afdf19b2dd33`):**
- MB links exactly 1 recording to this work: the original Birdy "Words" studio recording
- The EDX Remix exists in MusicBrainz as a separate recording but is **orphaned from the work** — there is no `performance` relation connecting it
- Path A correctly found and resolved the 1 linked recording (to a different Spotify release of the same original)
- Path B searched Spotify for `track:"Words"` and correctly found 15 unrelated songs named "Words", all rejected by the lyric gate
- Result: 0 useful covers found. The one candidate Chris actually wants (EDX Remix) is unreachable through either path.

**This was documented as a known risk in PLAN_COVERS_1.md §1** — the spike's MusicBrainz validation on 2026-05-04 explicitly noted that the EDX Remix is "orphaned, not linked to the work." Step 2 confirmed the risk is real in production.

## Why this is structural, not a data quality issue

MusicBrainz models remixes as independent recordings that *may* link to the same work as their source, but often don't — especially for same-artist remixes where the remix is treated as a derivative work rather than a performance of the original composition. This is a defensible modeling choice on MB's part: the EDX Remix adds production elements that go beyond "performing" the composition. But it means Path A will systematically miss same-artist remixes released as separate singles.

The class of covers affected:
- Same-artist remixes (Birdy "Words EDX Remix", Dua Lipa "Levitating Don Diablo Remix" if not linked)
- Same-artist acoustic/live versions released as separate singles (vs. album tracks which tend to get linked)
- Producer remixes where the remix producer is credited as the primary artist

## What Path A does find well

The grimmauldplace run validated Path A's strengths. It surfaced candidates that Path B (title search) never reached:

| Seed | Path B only | With Path A | Path-A-exclusive discoveries |
|---|---|---|---|
| Levitating | 11 | 20 | Rain Paris, Shania Yan, First to Eleven, Megan Nicole, Shelly Sony, Dua Lipa RAH Live |
| IWALY | 13 | 21 | Wallace Roney (jazz), Dolly Parton Live, Whitney Live, Les Enfoirés, Parcels, Glee Cast |
| Hallelujah | 4 | 11 | John Cale, Leonard Cohen Live in Austin, 3 Jeff Buckley live recordings |

Path A is high-value for cross-artist covers, live recordings, translations, and canonical originals. It is low-value for same-artist remixes.

## Proposed mitigation: Path C

A third candidate generation path — same-artist title search on Spotify — would close this gap. See PLAN_COVERS_2.md v2.1 amendment for design details. Decision pending Chris's review.

---

*Documented: 2026-05-05. Based on Step 2 grimmauldplace run.*
