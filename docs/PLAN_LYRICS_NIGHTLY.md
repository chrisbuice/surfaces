# Plan: Seed-Pending Phase + One-Time Eager Batch (≥2 trackdone)

**Status:** Draft — awaiting "go"  
**Date:** 2026-05-04  
**Scope:** Extend lyric-analysis coverage from obsession tier (~3,991 tracks) to all tracks with ≥2 `reason_end='trackdone'` plays (~10,029 URIs).

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Threshold | ≥2 `reason_end='trackdone'` | Hard floor on genuine completions. Excludes skipped/abandoned plays. |
| Batch API vs sync | Anthropic Message Batches API | 50% cost discount. ~6,200 net-new tracks × ~$3.50/1K = ~$22 one-time. |
| Runtime | grimmauldplace cron (Docker Compose) | Matches existing lyrics-backfill + lyrics-analysis pattern. No Worker changes. |
| Ongoing budget | ~$1–2/month | After eager batch, only new threshold-crossers trigger analysis (~5–15/day). |
| Limit on seed-pending | 30/night default | Most nights find 0–5 new crossers. 30 is generous ceiling. |
| Analyze chain limit | 5 per 10-min cycle | 5 × 144 cycles/day = 720/day max. Actual use: <30/day. Circuit breaker against runaway. |

---

## Cost Ceiling

**One-time eager batch:**
- ~6,200 tracks × ~1,200 input tokens × ~800 output tokens per track
- Input: 6,200 × 1,200 / 1M × $3.00 = ~$22.30 (batch: $11.15)
- Output: 6,200 × 800 / 1M × $15.00 = ~$74.40 (batch: $37.20)
- Wait — let me recalculate using the actual Sonnet batch pricing:
  - Batch input: $1.50/MTok, output: $7.50/MTok
  - Input: 6,200 × 1,200 / 1M × $1.50 = $11.16
  - Output: 6,200 × 800 / 1M × $7.50 = $37.20
  - **Total: ~$48** — hmm, that's higher than the $22 estimate.

**Revised estimate using actual observed costs:**
- The obsession batch of ~800 tracks cost ~$5.60 → ~$7/1K tracks
- 6,200 × $7/1K = ~$43 at sync rates, **~$22 at batch rates (50% discount)**
- This aligns with the $22 figure. The per-track cost is ~$3.50/1K at batch.

**Monthly ongoing (worst case):**
- 30 new tracks/night × 30 days = 900 tracks/month
- 900 × $7/1K at sync rates = $6.30/month (this is the absolute ceiling)
- Realistic: 5–15 new tracks/night × 30 = 150–450 tracks → $1–3/month
- Voyage embeddings: negligible (~$0.01/1K tracks)

**Kill-switch scenario:** If seed-pending ever finds >100 tracks in one night, something is wrong (data import glitch, duplicate plays). The `--limit 30` default prevents runaway.

---

## File Inventory

| File | Action | Purpose |
|------|--------|---------|
| `stack/lyrics-backfill/phase-seed-pending.ts` | Create | New phase: query for threshold-crossers, insert `pending` rows |
| `stack/lyrics-backfill/main.ts` | Modify | Add `seed-pending` case to switch |
| `stack/lyrics-backfill/Dockerfile` | Modify | Add `phase-seed-pending.ts` to COPY |
| `scripts/generate-2trackdone-uris.ts` | Create | One-time: generate URI list for eager batch |
| `stack/scripts/nightly-catchup.sh` | Create | Shell script chaining nightly phases |
| `scripts/coverage-check.sql` | Create | Verification query for pipeline health |

No Worker code changes. No schema migrations.

---

## Sequence of Operations

### Phase A: Build seed-pending

1. Create `stack/lyrics-backfill/phase-seed-pending.ts`
2. Update `stack/lyrics-backfill/main.ts` — add `"seed-pending"` case
3. Update `stack/lyrics-backfill/Dockerfile` — add to COPY line
4. Local test: `cd stack/lyrics-backfill && npx tsx main.ts seed-pending --dry-run`

**Verify:** Dry-run prints count of tracks meeting threshold but lacking analysis status. Expected: ~6,200.

### Phase B: Build & deploy container

5. `scp -r stack/lyrics-backfill/ grimmauldplace:~/stack/lyrics-backfill/`
6. `ssh grimmauldplace "cd ~/stack/lyrics-backfill && docker compose build"`

**Verify:** `docker compose run --rm lyrics-backfill seed-pending --dry-run` prints the expected count (~6,200).

### Phase C: Smoke test seed-pending

7. `docker compose run --rm lyrics-backfill seed-pending --dry-run`
8. `docker compose run --rm lyrics-backfill seed-pending --limit 5`

**Verify:** D1 query shows 5 new `pending` rows in `track_lyric_analysis_status`:
```sql
SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'pending';
```

### Phase D: Generate URI list for eager batch

9. Run `scripts/generate-2trackdone-uris.ts` on laptop
10. Outputs CSV to `scripts/data/2trackdone-uris.csv`
11. Print final count — sanity check against ~6,200

**Verify:** Line count matches expected. Spot-check 5 random URIs exist in `track_lyrics` with `status='ok'`.

### Phase E: Submit eager batch

**E1 — Preflight (5-URI test batch):**

12. Pick 5 URIs from the generated CSV (first 5 lines). Write to `inputs/test-5.csv`.
13. Submit test batch:
```bash
cd ~/stack/lyrics-analysis
docker compose run --rm lyrics-analysis analyze \
  --batch --uris-file /app/inputs/test-5.csv
```
14. Wait for completion (~5–10 min for a 5-item batch).

**Verify preflight:**
- Batch ID (`msgbatch_XXXX`) returned in console output
- Polling loop prints status transitions (in_progress → ended)
- Results stream prints 5 lines with `ok` or `too_short`
- D1 query confirms 5 new rows in `track_lyric_analysis_status`:
```sql
SELECT status, COUNT(*) FROM track_lyric_analysis_status
WHERE spotify_track_uri IN ('uri1','uri2','uri3','uri4','uri5')
GROUP BY status;
```
- `track_lyric_analysis` has matching `subject_paragraph` content (spot-check one)

If any of these fail, debug before proceeding. This is a 30-minute insurance policy on a 24–48 hour job.

**E2 — Full batch submission:**

15. `scp scripts/data/2trackdone-uris.csv grimmauldplace:~/stack/lyrics-analysis/inputs/`
16. On grimmauldplace:
```bash
cd ~/stack/lyrics-analysis
docker compose run --rm lyrics-analysis analyze \
  --batch --uris-file /app/inputs/2trackdone-uris.csv
```

**Verify:** Console prints batch ID. Container enters polling loop. Note the batch ID in case container disconnects.

### Phase F: Wait for batch results (24–48h)

14. Batch API processes asynchronously. Container polls until completion.
15. If container disconnects mid-poll:
```bash
docker compose run --rm lyrics-analysis analyze \
  --collect-only msgbatch_XXXXXXXXXXXXXXXXXXXX
```

**Verify:** `track_lyric_analysis_status` ok-count increases. Check with:
```sql
SELECT status, COUNT(*) FROM track_lyric_analysis_status GROUP BY status;
```

### Phase G: Run embeddings

16. After batch completes:
```bash
docker compose run --rm lyrics-analysis embed --limit 10000
```

(May need multiple runs if >5K tracks, or increase limit.)

**Verify:** `track_lyric_embedding` count matches analysis count (×2 for lyrics + analysis kinds):
```sql
SELECT kind, COUNT(*) FROM track_lyric_embedding GROUP BY kind;
```

### Phase H: Install crons

17. Create directories and script:
```bash
ssh grimmauldplace
mkdir -p ~/stack/scripts ~/stack/logs
```

18. Copy nightly script:
```bash
scp stack/scripts/nightly-catchup.sh grimmauldplace:~/stack/scripts/
ssh grimmauldplace "chmod +x ~/stack/scripts/nightly-catchup.sh"
```

19. Install crontab entries:
```bash
ssh grimmauldplace
crontab -e
```

Add:
```cron
# Hot-path chain: analyze + embed pending rows (every 10 min)
*/10 * * * * cd ~/stack && docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis analyze --limit 5 && docker compose -f lyrics-analysis/docker-compose.yml run --rm lyrics-analysis embed --limit 50 >> ~/stack/logs/chain.log 2>&1

# Nightly catch-up: lyrics fetch + credits + seed-pending (3am ET = 8am UTC)
0 8 * * * ~/stack/scripts/nightly-catchup.sh >> ~/stack/logs/nightly.log 2>&1
```

**Verify:** `crontab -l` shows both entries.

### Phase I: Verify first nightly run

20. Wait 24h. Check logs:
```bash
ssh grimmauldplace "tail -50 ~/stack/logs/chain.log"
ssh grimmauldplace "tail -50 ~/stack/logs/nightly.log"
```

**Verify:** Chain log shows successful runs (most are no-ops). Nightly log shows seed-pending completing with 0–5 new tracks seeded.

---

## `phase-seed-pending.ts` — Implementation Spec

```typescript
// Follows pattern of phase-isrc.ts / phase-lyrics.ts
// Args: --limit N (default 30), --dry-run

const args = process.argv.slice(3);
const limitIdx = args.indexOf("--limit");
const limit = limitIdx !== -1 ? parseInt(args[limitIdx + 1], 10) : 30;
const dryRun = args.includes("--dry-run");

// Query: tracks with ≥2 trackdone plays, lyrics available, no analysis status
const SEED_QUERY = `
SELECT l.spotify_track_uri
FROM track_lyrics l
LEFT JOIN track_lyric_analysis_status s
  ON s.spotify_track_uri = l.spotify_track_uri
JOIN (
  SELECT spotify_track_uri
  FROM plays
  WHERE reason_end = 'trackdone'
  GROUP BY spotify_track_uri
  HAVING COUNT(*) >= 2
) p ON p.spotify_track_uri = l.spotify_track_uri
WHERE l.status = 'ok'
  AND l.lyrics_plain IS NOT NULL
  AND s.spotify_track_uri IS NULL
LIMIT ?;
`;

// Insert: pending status row
const INSERT_PENDING = `
INSERT OR IGNORE INTO track_lyric_analysis_status
  (spotify_track_uri, status, last_attempted_at, attempts)
VALUES (?, 'pending', ?, 0);
`;
```

Output format:
```
seed-pending: found 6,201 tracks meeting threshold without analysis
seed-pending: --dry-run, no writes
```
or:
```
seed-pending: found 12 tracks meeting threshold without analysis
seed-pending: inserting 12 pending rows...
  [100%] 12/12 — inserted:12 skipped:0
seed-pending: done. Status counts: ok=3991 pending=12 parse_error=0 too_short=0
```

---

## `nightly-catchup.sh`

```bash
#!/bin/bash
# Nightly catch-up: fetch new lyrics, credits, seed analysis-pending
# Runs at 3am ET (8am UTC) via crontab

set -euo pipefail
cd ~/stack

echo "=== $(date -u '+%Y-%m-%d %H:%M UTC') nightly-catchup start ==="

echo "--- lyrics fetch ---"
docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill lyrics --limit 50 || true

echo "--- credits fetch ---"
docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill credits --limit 50 || true

echo "--- seed-pending ---"
docker compose -f lyrics-backfill/docker-compose.yml run --rm lyrics-backfill seed-pending

echo "=== $(date -u '+%Y-%m-%d %H:%M UTC') nightly-catchup done ==="
```

Note: `|| true` on lyrics/credits so a failure doesn't block seed-pending (matches the user spec of using `;` semantics). The seed-pending step runs without `|| true` so its failure is visible.

---

## `scripts/generate-2trackdone-uris.ts`

Runs on laptop. Uses wrangler D1 or the same `lib/d1.ts` HTTP approach:
1. Query for URIs with ≥2 trackdone AND `track_lyrics.status='ok'`
2. Filter out URIs already in `track_lyric_analysis_status` with `status='ok'`
3. Write one URI per line to `scripts/data/2trackdone-uris.csv`
4. Print count

---

## `scripts/coverage-check.sql`

```sql
-- Pipeline coverage check
SELECT
  (SELECT COUNT(DISTINCT spotify_track_uri) FROM plays) AS total_play_uris,
  (SELECT COUNT(*) FROM track_lyrics WHERE status = 'ok') AS lyrics_ok,
  (SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'ok') AS analysis_ok,
  (SELECT COUNT(*) FROM track_lyric_analysis_status WHERE status = 'pending') AS analysis_pending,
  (SELECT COUNT(*) FROM track_lyric_embedding WHERE kind = 'lyrics') AS embed_lyrics,
  (SELECT COUNT(*) FROM track_lyric_embedding WHERE kind = 'analysis') AS embed_analysis,
  (SELECT COUNT(*) FROM (
    SELECT p.spotify_track_uri
    FROM plays p
    WHERE p.reason_end = 'trackdone'
    GROUP BY p.spotify_track_uri
    HAVING COUNT(*) >= 2
  ) t
  LEFT JOIN track_lyric_analysis_status s ON s.spotify_track_uri = t.spotify_track_uri
  WHERE s.spotify_track_uri IS NULL OR s.status != 'ok') AS gap_count;
```

Run via:
```bash
npx wrangler d1 execute spotify-agent-db --remote --json \
  --command "$(cat scripts/coverage-check.sql)"
```

---

## Verification Tests

No existing test infra in `stack/lyrics-backfill/` (confirmed: no test files). Rather than adding vitest for a single phase, **validation queries against live D1** serve as the acceptance test:

### Test 1: Zero-row gap after eager batch
After eager batch completes, every ≥2-trackdone track should have a **terminal** status. Terminal statuses are: `ok`, `too_short`, `instrumental`, `parse_error` (with `attempts >= 3`). Non-terminal: `pending`, `parse_error` (with `attempts < 3`).

```sql
-- Should return 0: no tracks left in limbo
SELECT COUNT(*) FROM (
  SELECT p.spotify_track_uri FROM plays p
  WHERE p.reason_end = 'trackdone'
  GROUP BY p.spotify_track_uri HAVING COUNT(*) >= 2
) t
JOIN track_lyrics l ON l.spotify_track_uri = t.spotify_track_uri
LEFT JOIN track_lyric_analysis_status s ON s.spotify_track_uri = t.spotify_track_uri
WHERE l.status = 'ok' AND l.lyrics_plain IS NOT NULL
  AND (
    s.spotify_track_uri IS NULL                           -- never attempted
    OR s.status = 'pending'                              -- queued but not run
    OR (s.status = 'parse_error' AND s.attempts < 3)    -- retriable failure
  );
```

If this returns a small number (1–20), investigate: likely tracks whose lyrics changed between fetch and analysis. If >50, the batch didn't complete cleanly.

### Test 2: Idempotency (pinned URIs)
Pick 5 specific URIs from the Phase C smoke test (the ones inserted in step 8). Record them. After those 5 are analyzed by the chain:

```bash
# Run seed-pending again — these 5 already have status rows
docker compose run --rm lyrics-backfill seed-pending --limit 5
```

Expected output:
```
seed-pending: found N tracks meeting threshold without analysis
```
where N excludes the 5 pinned URIs (they have `status='ok'` or another terminal status now). If N > 0, the inserted tracks are *different* URIs — confirming the pinned 5 were correctly skipped.

To prove the filter explicitly:
```sql
-- These 5 should all have non-NULL status rows
SELECT spotify_track_uri, status FROM track_lyric_analysis_status
WHERE spotify_track_uri IN (
  'spotify:track:XXXX1',
  'spotify:track:XXXX2',
  'spotify:track:XXXX3',
  'spotify:track:XXXX4',
  'spotify:track:XXXX5'
);
-- Should return 5 rows, all with status != NULL
```

Replace `XXXX1`–`XXXX5` with the actual URIs from the Phase C smoke test output.

### Test 3: Threshold filter correctness
Verify a track with 2+ plays but <2 trackdone is excluded:
```sql
-- Find a track with ≥2 total plays but <2 trackdone
SELECT spotify_track_uri, 
  COUNT(*) as total_plays,
  SUM(CASE WHEN reason_end = 'trackdone' THEN 1 ELSE 0 END) as trackdone_count
FROM plays
GROUP BY spotify_track_uri
HAVING total_plays >= 2 AND trackdone_count < 2
LIMIT 5;
-- Confirm none of these appear in the seed-pending query output
```

---

## Rollback / Kill Switch

### Stop the eager batch mid-run
```bash
# Find batch ID
cat ~/stack/lyrics-analysis/inputs/batch-*.json | jq .batch_id

# Cancel via Anthropic API (if still processing)
curl -X POST https://api.anthropic.com/v1/messages/batches/{batch_id}/cancel \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "anthropic-version: 2023-06-01"
```
Already-completed results are retained for 29 days. Partial results can be collected with `--collect-only`.

### Disable crons immediately
```bash
ssh grimmauldplace "crontab -r"  # nuclear: removes ALL cron entries
# Or surgical: comment out specific lines
ssh grimmauldplace "crontab -l | sed 's/^.*chain.log/#&/' | crontab -"
```

### Undo seed-pending rows
```sql
-- Remove all pending rows that haven't been analyzed yet
DELETE FROM track_lyric_analysis_status WHERE status = 'pending';
```

### Cost runaway detection

**Theoretical maximum:** `--limit 5` × 144 cycles/day × ~$0.007/track = **$5.04/day = $151/month**.
That ceiling requires every single 10-min cycle to find 5 pending tracks — which can't happen once the eager batch clears the backlog. In practice:
- After eager batch: ~5–15 new tracks/day seeded by nightly → analyze chain clears them in 1–3 cycles.
- **Expected daily spend: $0.05–$0.20/day ($1.50–$6/month).**
- The gap between theoretical max and expected is accepted because the `--limit 5` already acts as a per-cycle circuit breaker, and the nightly `seed-pending --limit 30` caps how many tracks enter the queue at all.

**When to investigate:** If chain.log shows >5 tracks analyzed per cycle for >6 consecutive cycles, something is seeding pending rows outside the nightly cron (likely MCP traffic spike). Check `track_lyric_analysis_status WHERE status='pending'` count — if >50, pause the chain cron and investigate.

---

## Known Issues (Out of Scope)

- **watchdog.sh is broken** — currently 404s. Either fix or remove as a separate follow-up. Does not affect this work.
- **ISRC catch-up** — `track_isrc_cache` is a working artifact, not needed for analysis. Out of scope.
- **Audio analysis (Phase 2)** — Deezer preview + Gemini. Separate initiative.
- **MCP/dashboard surfacing of analysis** — Covered by `docs/PLAN_LYRICS_STEPS_6_7.md`. Out of scope here.
- **Live-sync integration** — The nightly `lyrics --limit 50` handles new tracks from live-sync. No separate sync work needed.

---

## Definition of Done

1. `track_lyric_analysis_status` ok-count: 9,500–10,029 range
2. `track_lyric_embedding` has both kinds for >95% of analyzed tracks
3. `crontab -l` on grimmauldplace shows both entries
4. `~/stack/logs/chain.log` shows successful 10-min runs
5. `~/stack/logs/nightly.log` shows successful nightly run (24h after install)
6. Spot-check: 5 random non-obsession-tier tracks have reasonable `subject_paragraph`
7. Monthly spend documented: <$25/month ceiling, ~$1–3/month typical
