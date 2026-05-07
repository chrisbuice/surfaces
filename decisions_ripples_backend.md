# Decisions: Ripples Backend

## Scope restatement

This kickoff adds a "Ripples" feature to the spotifygenie worker — a snapshot of the 10 tracks getting disproportionate attention in the last 14 days relative to their lifetime plays. Each track gets a familiarity score and a short explanatory fact. The snapshot includes a composite "X% on-brand" score and splits tracks into New Arrivals vs Returning Waves.

**Deliverables (backend only):**
- D1 migration for `ripples_snapshot` table
- Scoring logic (ripple score, familiarity, split) as pure functions with tests
- Hardcoded fact ladder as a pure function with tests
- LLM fact generation with validation and fallback
- `GET /api/ripples/current` (public)
- `POST /api/ripples/regenerate` (auth-gated)
- Wired into the nightly cron

No frontend. No changes to chrisbuice-site.

---

## Decision confirmations

### D1 — Scope
**Confirmed.** Backend only, this repo only.

### D2 — Adaptive ripple score
**Confirmed.** 14-day window, 3-tier weighting (3.0 / 2.0 / 1.0), smoothing constant +3. Top 10 by score.

One note: the `plays` table stores rows from `syncRecentPlays()`, which pulls from Spotify's recently-played endpoint. I'll query directly against `plays` for the window calculations. The play timestamps are stored as unix epoch seconds in `played_at`.

### D3 — New Arrivals vs Returning Waves
**Confirmed.** New Arrivals: lifetime_plays <= 5 AND first play within last 30 days. Everything else = Returning Waves.

### D4 — Familiarity score
**Confirmed.** 50% artist percentile + 30% track percentile + 20% era proximity.

**Flag:** The era component needs a release year per track. The `plays` table doesn't store release year. Options:
1. Fetch release year from Spotify API at snapshot time (10 API calls, straightforward).
2. Skip the era component for now, make familiarity = 62.5% artist + 37.5% track (re-weighted).
3. Use the `audio_features` table if it has release year data.

**Recommendation:** Option 1 — fetch from Spotify API. The SpotifyClient is already available in the cron context. We can batch the 10 track lookups. **Waiting for your call.**

### D5 — LLM-generated facts
**Confirmed with a flag.** See D10 below — the Anthropic API has never been called from within the worker. We need to add the secret.

### D6 — Hardcoded fact ladder
**Confirmed.** Pure function, 5-tier priority. Also serves as fallback for LLM failures.

### D7 — Schema
**Confirmed with adjustment.** Migration number will be **014** (not 008). Migrations 008–013 already exist. File: `src/db/migrations/014_ripples_snapshot.sql`.

Schema as specified — `ripples_snapshot` table with `id`, `generated_at`, `window_start`, `window_end`, `composite_familiarity`, `total_plays_in_window`, `payload` (JSON blob).

### D8 — Endpoints
**Confirmed.**
- `GET /api/ripples/current` — public, no auth. Cache-Control 5 min.
- `POST /api/ripples/regenerate` — auth-gated.

Auth pattern will follow the `/admin/rebuild-constellation` pattern: verify Access JWT (email or service token) OR Bearer SHORTCUT_TOKEN.

### D9 — Nightly job
**Confirmed.** The `0 5 * * *` cron (5am UTC / 1am ET) is the daily maintenance slot — it already runs sync, derive, taste rebuild, audio backfill, and prune. Ripples generation slots in after taste rebuild (which updates affinities we might reference).

### D10 — LLM call mechanics
**Confirmed with flag.**

**Important: No `ANTHROPIC_API_KEY` currently exists in the worker's Env interface or secrets.** All existing Anthropic usage is in local scripts (`scripts/experiment/`) and Docker containers (`stack/lyrics-analysis/`), never from the worker itself. The model used there is `claude-sonnet-4-6`.

**To make this work, you'll need to:**
1. Run `npx wrangler secret put ANTHROPIC_API_KEY` and paste the key.
2. I'll add `ANTHROPIC_API_KEY: string` to the `Env` interface.
3. The Anthropic SDK (`@anthropic-ai/sdk`) is in `scripts/experiment/package.json` but NOT in the root `package.json`. I'll need to add it as a dependency.

**Alternative:** Skip LLM facts for the initial deployment, use the hardcoded ladder only, and add LLM facts in a fast follow-up once the secret is configured. The hardcoded ladder is solid and the feature works without LLM. **Your call.**

---

## Files to create or modify

### New files
| File | Purpose |
|------|---------|
| `src/db/migrations/014_ripples_snapshot.sql` | Table creation |
| `src/ripples/scoring.ts` | ripple_score, familiarity_score, split logic |
| `src/ripples/facts.ts` | Hardcoded fact ladder + LLM fact generator + validation |
| `src/ripples/generate.ts` | `generateRipplesSnapshot()` orchestrator |
| `src/ripples/scoring.test.ts` | Unit tests for scoring |
| `src/ripples/facts.test.ts` | Unit tests for fact ladder |

### Modified files
| File | Change |
|------|--------|
| `src/index.ts` | Add `Env.ANTHROPIC_API_KEY`, two new route cases, ripples call in `0 5 * * *` cron |
| `package.json` | Add `@anthropic-ai/sdk` dependency (if LLM path is included) |

---

## Order of operations

1. **This doc.** Stop. Wait for sign-off.
2. Create migration `014_ripples_snapshot.sql`. Run locally.
3. Implement scoring functions (`ripple_score`, `familiarity_score`, `splitRipples`) with unit tests.
4. Implement hardcoded fact ladder with unit tests.
5. Implement LLM fact generator with validation and fallback (pending D10 decision).
6. Wire into `generateRipplesSnapshot()` — queries plays, computes scores, generates facts, writes row.
7. Add both endpoints to `src/index.ts`.
8. Add to `0 5 * * *` cron block.
9. Manual trigger + inspect output.

---

## Resolved decisions (2026-05-06)

1. **D4 — Era familiarity:** Fetch release year from Spotify API at snapshot time. Cache on a `release_year` column in the tracks-related table if there's a clean place; otherwise fetch fresh each snapshot (only 10 calls).

2. **D10 — LLM facts:** Adding `ANTHROPIC_API_KEY` as a worker secret and `@anthropic-ai/sdk` to root dependencies. Model: `claude-sonnet-4-20250514`. Hardcoded ladder is the validation fallback as originally specified.

3. **Tests:** Setting up vitest. Covering: `computeRippleScore`, `computeFamiliarityScore`, `splitArrivalsAndWaves`, `pickHardcodedFact`, `validateLLMFact`.

4. **Migration number:** 014 confirmed.

5. **Cron hold:** Will NOT wire into the nightly cron yet. Chris wants to manually trigger `/api/ripples/regenerate` and review LLM facts on real data first.

---

## Post-deploy fix: nodejs_compat

**Current state of `compatibility_flags` in wrangler.toml:** Does not exist. No `compatibility_flags` line is present.

**`compatibility_date`:** `2025-04-28` — well past the `2024-09-23` threshold. The v2 `nodejs_compat` implementation is fully available at this date.

**Planned change:** Add `compatibility_flags = ["nodejs_compat"]` to the top of `wrangler.toml` (after `compatibility_date`). This provides the Node.js module shims (`node:fs`, `node:path`, etc.) that the Anthropic SDK imports unconditionally in its credential-chain helpers. We pass `apiKey` directly so these code paths are never exercised at runtime, but the bundler still resolves the imports and the runtime will throw if the modules aren't available.

**Risk:** None meaningful. `nodejs_compat` at this compatibility date enables the mature v2 polyfills. No behavioral changes to existing code — existing modules don't import `node:*` APIs.
