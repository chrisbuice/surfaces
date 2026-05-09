# Spotify Rate Limit: Audit, Fix, and Harden

**Status:** Plan v2 — revised per review, awaiting implementation approval
**Date:** 2026-05-08
**Trigger:** Apple Music ingest tripped a ~24h Spotify ban (Retry-After: 41749s → 78421s). Existing circuit breaker paused 5 min then resumed, extending the ban.

---

## CRITICAL FINDING

**The Worker's `SpotifyClient` (src/spotify/client.ts) has ZERO 429 handling.** It throws a generic error on any non-OK response. The per-minute poll cron (`* * * * *`) catches this error silently and continues — meaning **production has been hammering Spotify every 60 seconds during the entire ban window**, likely extending it.

This is the highest-priority fix. Every Spotify call from the Worker passes through `SpotifyClient.request()` (line 70–120), which has no retry logic, no backoff, and no cooldown awareness.

---

## Step 1: Audit

### 1.1 Mechanical grep results

Every file containing `api.spotify.com` or `accounts.spotify.com`:

| File | Line | Content | Via shared helper? |
|---|---|---|---|
| `src/spotify/client.ts` | 17 | Base URL definition | IS the helper (no 429 handling) |
| `src/auth/spotify-oauth.ts` | 55, 87, 130 | OAuth authorize, token exchange, token refresh | No — direct fetch |
| `scripts/lib/spotify-matcher.ts` | 57 | Base URL for search API | Own `spotifyFetch` with 429 handling |
| `scripts/lib/spotify-auth.ts` | 8 | Token URL for client_credentials | Own fetch with timeout |
| `scripts/lib/spotify-token.ts` | 59 | Token refresh (standalone) | Direct fetch |
| `scripts/find-covers.ts` | 267, 292 | Token refresh + API calls | Direct fetch, inline retry |
| `scripts/fetch-isrcs.ts` | 100 | `/v1/tracks/{id}` | Direct fetch, inline retry |
| `stack/lyrics-backfill/phase-isrc.ts` | 41 | `/v1/tracks/{id}` | Direct fetch, inline retry |
| `stack/lyrics-backfill/lib/spotify.ts` | 42 | Token broker call | Direct fetch with retry |

### 1.2 Call-site table

| # | File | Endpoint | Shape | Frequency | Has 429 handling? | Through chokepoint? |
|---|---|---|---|---|---|---|
| 1 | `src/tracker/poll.ts:33` | `GET /v1/me/player` | Single | Every minute (cron) | ❌ No | SpotifyClient (no 429) |
| 2 | `src/tracker/poll.ts:110` | `GET /v1/me/player/recently-played` | Single | Every minute (backfill) | ❌ No | SpotifyClient |
| 3 | `src/listening/sync.ts:34` | `GET /v1/me/player/recently-played` | Single | Daily + on-demand | ❌ No | SpotifyClient |
| 4 | `src/taste/model.ts:60-68` | `GET /v1/me/tracks`, `/top/tracks`, `/top/artists`, `/following` | Paginated, parallel | Daily 5am UTC | ❌ No | SpotifyClient |
| 5 | `src/spotify/library.ts:48-114` | Various `/v1/me/*` | Paginated | Called by #4 | ❌ No | SpotifyClient |
| 6 | `src/constellation/cron.ts:56-71` | Playlist track fetches | Multiple | Daily 10am UTC | ❌ No | SpotifyClient |
| 7 | `src/discovery/sources.ts:191,226,285` | `GET /v1/search` | Single per artist | Daily 10am UTC | ❌ No | SpotifyClient |
| 8 | `src/discovery/agent.ts` | Various search + metadata | Multiple | Daily 10am UTC | ❌ No | SpotifyClient |
| 9 | `src/spotify/playback.ts:18-113` | Player control endpoints | Single | User-triggered | ❌ No | SpotifyClient |
| 10 | `src/spotify/browse.ts:36,51` | `/v1/browse/new-releases`, search | Single | Daily | ❌ No | SpotifyClient |
| 11 | `src/submissions/fresh_pool_sync.ts:63` | `GET /v1/tracks/{id}` | Single | Daily | ❌ No | SpotifyClient |
| 12 | `src/ripples/generate.ts:195` | `GET /v1/tracks/{id}` | Single | Daily | ❌ No | SpotifyClient |
| 13 | `src/mcp/tools.ts` | Various | Single | User-triggered (MCP) | ❌ No | SpotifyClient |
| 14 | `src/curation/agent.ts:310` | `GET /v1/me` | Single | Per session | ❌ No | SpotifyClient |
| 15 | `src/audio/reccobeats.ts:68` | ReccoBeats (not Spotify, but shares pattern) | Batched | Daily | ❌ Throws on 429 | No |
| 16 | `src/auth/spotify-oauth.ts:87,130` | `POST /api/token` | Single | Login + every 59 min | ❌ No | Direct fetch |
| 17 | `scripts/lib/spotify-matcher.ts` | `/v1/search` | Single | Per-track (ingest) | ✅ Yes | Own `spotifyFetch` |
| 18 | `scripts/lib/spotify-auth.ts` | `POST /api/token` | Single | Per-run | ✅ Partial (timeout, no cooldown) | Own fetch |
| 19 | `scripts/find-covers.ts:267,292` | Token + API | Single | Ad-hoc script | ✅ Honors Retry-After, no cap | Direct fetch |
| 20 | `scripts/fetch-isrcs.ts:100` | `/v1/tracks/{id}` | Single | Ad-hoc script | ✅ Honors Retry-After, no cap | Direct fetch |
| 21 | `stack/lyrics-backfill/phase-isrc.ts:41` | `/v1/tracks/{id}` | Single | Backfill script | ✅ Honors Retry-After, no cap | Direct fetch |
| 22 | `stack/lyrics-backfill/lib/spotify.ts:42` | Token broker | Single | Per-run | ✅ Partial (retry) | Direct fetch |

**Summary:** 16 call sites go through `SpotifyClient` with ZERO 429 handling. 6 script call sites have partial handling (honor Retry-After correctly, no short cap). None use a centralized cooldown.

### 1.3 Existing breaker analysis

**Location:** `scripts/ingest-apple-music.ts` lines 269–312

**Bug:** On 5 consecutive `SpotifyRateLimitError`s, pauses 5 minutes then resets the counter and resumes. Spotify's `Retry-After` says 41,749 seconds (11.6 hours). The script waits 5 min, tries again, gets another 429, waits 5 min, tries again... ad infinitum. Each retry extends the ban.

**Worker impact:** The Worker cron does NOT use this breaker — it has NO breaker at all. The per-minute poll has been silently hitting Spotify during the entire ban, likely extending it. The poll's catch block (poll.ts:34) swallows the error, so from the Worker's perspective everything is "nothing playing."

### 1.4 Inline retry cap audit (R6 / R7)

Verified the retry behavior in all script/stack call sites:

| File | Retry-After handling | Short cap? | Decision |
|---|---|---|---|
| `scripts/find-covers.ts:301-304` | `sleep(retryAfter * 1000)` — honors full value | ❌ No cap | Safe. Add cooldown file write as a one-line guard. |
| `scripts/fetch-isrcs.ts:104-107` | `sleep(retryAfter * 1000)` — honors full value | ❌ No cap | Safe. Add cooldown file write as a one-line guard. |
| `stack/lyrics-backfill/phase-isrc.ts:45-53` | `sleep(retryAfter * 1000)` — honors full value | ❌ No cap | Safe. Add cooldown file write as a one-line guard. |
| `scripts/lib/spotify-matcher.ts:239-244` | `MAX_RETRY_WAIT_MS = 30_000` — **capped at 30s** | ✅ **HAS THE BUG** | Migrate to chokepoint in this session. |

**R6 Decision:** `find-covers.ts`, `fetch-isrcs.ts`, and `phase-isrc.ts` are safe (no short cap). They get a one-line cooldown file write (`if (retryAfter > 60) { writeCooldown(); process.exit(1); }`) as part of this session, not deferred.

**R7 Decision:** `stack/lyrics-backfill/phase-isrc.ts` gets the same one-line guard in this session. Full migration to the chokepoint module is deferred but the cap bug is neutralized now.

---

## Step 2: Design

### 2.1 Chokepoint module API

**Worker side: `src/spotify/rate-guard.ts`**

```typescript
// Exception types
export class SpotifyCooldownError extends Error {
  cooldownUntil: number; // epoch ms
}
export class SpotifyDisabledError extends Error {}
export class SpotifyServerError extends Error {} // thrown after 5xx retries exhaust

// Check if calls are allowed (throws if not)
export async function assertSpotifyAllowed(kv: KVNamespace): Promise<void>;

// Set cooldown from a 429 response
export async function setSpotifyCooldown(
  kv: KVNamespace,
  retryAfterSeconds: number,
  caller: string,
): Promise<void>;

// Clear cooldown (manual recovery)
export async function clearSpotifyCooldown(kv: KVNamespace): Promise<void>;

// KV keys
// spotify:cooldown_until — epoch ms string
// spotify:disabled — "true" if kill-switch active
```

Integrated into `SpotifyClient.request()`:
1. Call `assertSpotifyAllowed(kv)` before every fetch — throws `SpotifyDisabledError` (kill-switch) or `SpotifyCooldownError` (cooldown active) without making any HTTP call
2. Enforce 100ms minimum interval between calls (in-memory `RateLimiter`)
3. On 429 response: call `setSpotifyCooldown()` with the full Retry-After value (never capped, never shortened), fire D11 notification, throw `SpotifyCooldownError`
4. On 5xx: retry with jittered backoff (1s, 2s, 4s, `MAX_RETRIES = 3`). After exhaustion, throw `SpotifyServerError`
5. On 401: refresh token once, retry once (existing behavior). Second 401 throws, does not loop
6. Now-playing cache write happens AFTER successful response parse, never on error

**grimmauldplace side: `scripts/lib/spotify-rate-guard.ts`**

Same contract, file-based persistence:
- `~/.surfaces/spotify-cooldown` — contains epoch ms
- `~/.surfaces/spotify-disabled` — presence = disabled
- `~/.surfaces/spotify-incidents.log` — append-only log with timestamp, retry-after value, caller

### 2.2 SpotifyClient changes

`SpotifyClient` constructor already has `env.KV` access. The `request()` method becomes:

```typescript
const MAX_RETRIES = 3;

private async request<T>(method, path, params?, body?): Promise<T> {
  await assertSpotifyAllowed(this.env.KV);      // throws if cooldown/disabled
  await this.rateLimiter.wait();                  // 100ms min interval

  let token = await this.getValidToken();
  // ... build URL ...

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await doFetch(token);

    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("retry-after") ?? "0", 10) || 3600;
      await setSpotifyCooldown(this.env.KV, retryAfter, `${method} ${path}`);
      throw new SpotifyCooldownError(retryAfter);
    }

    if (resp.status === 401 && attempt === 0) {
      token = await this.refreshToken();
      continue;
    }

    if (resp.status >= 500 && attempt < MAX_RETRIES) {
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }

    if (resp.status >= 500) {
      throw new SpotifyServerError(`Spotify ${method} ${path} (${resp.status}) after ${MAX_RETRIES} retries`);
    }

    if (resp.status === 204) return undefined as T;
    if (!resp.ok) throw new Error(`Spotify ${method} ${path} (${resp.status})`);
    // ... parse response ...
  }
}
```

### 2.3 Token endpoint 429 contract (R3)

On 429 from `accounts.spotify.com/api/token` (in `src/auth/spotify-oauth.ts`):
1. Set cooldown to **24 hours** (conservative worst case for token-level bans)
2. Set the kill-switch (`spotify:disabled = true`) — a token-level ban means nothing will work
3. Fire D11 notification with `caller="token_refresh"`
4. **Do not retry.** The next call will short-circuit on the kill-switch.
5. Manual intervention required to clear: `wrangler kv:key delete --binding=KV spotify:disabled`

Test case: mock 429 on token refresh → verify cooldown set to 24h, kill-switch set, `SpotifyCooldownError` thrown.

### 2.4 Migration map

| # | Call site | Migration |
|---|---|---|
| 1–14 | All `SpotifyClient` callers | No code change needed — `SpotifyClient.request()` handles it internally. |
| 1–2 (R1) | **Cron error handlers** | New row. `poll.ts:34` catch block must differentiate `SpotifyCooldownError` (log "cooldown active, skipping" — expected, not a failure) from generic errors (log as error). When the primary `/v1/me/player` call throws `SpotifyCooldownError`, skip the secondary `recently-played` backfill — no point making a second call that will also short-circuit. Same treatment for catch blocks in: `index.ts` scheduled handler for taste sync (`0 5 * * *`), constellation (`0 10 * * *`), discovery (`0 10 * * *`), ripples (try/catch at line 2533), fresh_pool_sync (try/catch at line 2514). |
| 15 | `reccobeats.ts` | Out of scope (not Spotify) |
| 16 | `spotify-oauth.ts` token refresh | Add 429 detection per R3 contract above. Set cooldown 24h + kill-switch. Do not retry. |
| 17 | `scripts/lib/spotify-matcher.ts` | Migrate to `scripts/lib/spotify-rate-guard.ts`. Replace `SpotifyRateLimitError` with file-based cooldown. Remove `MAX_RETRY_WAIT_MS` cap — honor full Retry-After. Delete the broken circuit breaker from `ingest-apple-music.ts`. |
| 18 | `scripts/lib/spotify-auth.ts` | Add file-based cooldown write on 429 from token endpoint + set kill-switch file. Same contract as R3 but file-based. |
| 19 | `scripts/find-covers.ts` | Add one-line guard: after parsing Retry-After, if value > 60: write cooldown file, exit 1. No full migration. |
| 20 | `scripts/fetch-isrcs.ts` | Same one-line guard as #19. |
| 21 | `stack/lyrics-backfill/phase-isrc.ts` | Same one-line guard as #19. |
| 22 | `stack/lyrics-backfill/lib/spotify.ts` | Token broker calls the Worker's `/admin/spotify-token` which is already protected by #16. No additional migration needed. |

### 2.5 Now-playing KV cache + cron stagger (D6 + R2 + R10)

The per-minute cron writes `spotify:now_playing` to KV with 30s TTL. The `/api/now-playing` endpoint reads from KV first. If miss, falls back to `poll_observations` (existing D1 fallback). Public hits NEVER call Spotify directly — they already don't (the cron is the only caller), but the cron itself needs the cooldown guard.

**Cooldown survival mechanism (R10):** When cooldown is active, the cron's call to Spotify short-circuits via `assertSpotifyAllowed()`, so KV doesn't get updated. The 30s TTL expires, and `/api/now-playing` falls back to `poll_observations` (last-known track from D1). The public endpoint gracefully shows last-known throughout a multi-hour cooldown. This is the design — do not add logic that bypasses the KV-miss fallback.

**Cron stagger (R2):** The 100ms minimum interval is per-Worker-invocation, not global. On 5am UTC and 10am UTC, the daily crons fire inside the same `scheduled()` handler sequentially — they don't run concurrently. However, they burst many calls within one invocation (taste rebuild does ~20+ calls in quick succession). The in-memory rate limiter handles this burst.

To reduce coincidental load from independent cron schedules, stagger in `wrangler.toml`:
- `* * * * *` — poll (unchanged, per-minute is fine with cooldown guard)
- `*/2 * * * *` — feedback loop (unchanged)
- `0 5 * * *` — taste sync + audio backfill + ripples
- `0 10 * * *` — constellation + discovery + page-data

The 5am and 10am crons are already staggered by 5 hours. No further stagger needed between them. Within each cron, calls are sequential (not parallel), so the in-memory rate limiter applies.

**Limitation:** The per-process minimum interval doesn't coordinate across the Worker and grimmauldplace. If both run simultaneously, they share the same Spotify app quota. The Worker's calls are the dominant consumer (~1,640/day).

### 2.6 Apple-ingest caching improvements (D8)

- **Empty-artist skip:** If the text search would be `"Song Name" by ""`, skip the Spotify call entirely. Cache as `match_status = 'unmatched'` with a note. Current logs show many `by ""` queries wasting calls.
- **Negative cache:** `apple_track_matches` rows with `match_status = 'unmatched'` already serve as negative cache (the resumability logic skips them on re-run). The `last_match_attempt_at` column exists in the schema (confirmed: `schema.sql` line 67). Add a minimum age check in the retry script: don't re-search unmatched tracks until `last_match_attempt_at` is >90 days old.
- **Positive cache:** Already implemented — matched tracks are cached in `apple_track_matches`.

### 2.7 Test plan

Unit tests for `src/spotify/rate-guard.ts`:

1. 429 with `Retry-After: 78000` sets cooldown to exactly `now + 78000s`. Not capped, not shortened.
2. 429 with no `Retry-After` header sets cooldown to `now + 3600s`.
3. While cooldown is active, `assertSpotifyAllowed()` throws `SpotifyCooldownError` without making any HTTP request. **Hard assertion: mock `fetch`, verify it was called zero times.**
4. After cooldown expires, calls proceed normally.
5. Kill-switch active throws `SpotifyDisabledError` before cooldown is even checked.
6. 5xx triggers backoff with documented schedule (1s, 2s, 4s). After 3 retries, throws `SpotifyServerError`.
7. 401 refreshes token once, then succeeds; second 401 does not loop.
8. Two consecutive successful calls are separated by ≥100ms.
9. `setSpotifyCooldown()` writes to KV mock with correct epoch ms value.
10. `assertSpotifyAllowed()` reads existing cooldown from KV on cold start.
11. Token endpoint 429 (R3): sets cooldown to 24h, sets kill-switch, throws without retry.

Unit tests for `scripts/lib/spotify-rate-guard.ts`:
- Same contract as 1–5, 9–10, file-based: write/read `~/.surfaces/spotify-cooldown` and `~/.surfaces/spotify-disabled`.

### 2.8 Staged resumption plan

After merge and deploy:

| Step | Action | Gate | On 429 |
|---|---|---|---|
| Hour 0 | Merge + deploy Worker. Cron continues but now respects cooldown/kill-switch. | — | N/A |
| Hour 24+ from last 429 | Clear cooldown: `npx wrangler kv:key delete --binding=KV spotify:cooldown_until` | No 429s in Worker logs | N/A |
| A | Watch Worker logs for 1 hour. Confirm poll cron succeeds. | No errors for 1 hour | Set kill-switch (`npx wrangler kv:key put --binding=KV spotify:disabled true`), alert Chris. Cron continues but short-circuits. |
| B | grimmauldplace: `apple-ingest --limit=50 --skip-musicbrainz` | Summary shows matches, no 429 | Script exits 1, cooldown file written. Don't restart automatically. |
| C | grimmauldplace: `apple-ingest` full (no limit) | Completes without 429 | Script exits 1, cooldown file written. Don't restart automatically. |
| D | Re-enable discovery agent if disabled | No 429 in next daily run | Set kill-switch, alert Chris. |

### 2.9 Kill-switch commands

**Worker (KV) — binding is `KV` per wrangler.toml line 15:**
```bash
# Disable all Spotify calls
npx wrangler kv:key put --binding=KV spotify:disabled true

# Re-enable
npx wrangler kv:key delete --binding=KV spotify:disabled

# Check cooldown
npx wrangler kv:key get --binding=KV spotify:cooldown_until

# Clear cooldown manually
npx wrangler kv:key delete --binding=KV spotify:cooldown_until
```

**grimmauldplace (file):**
```bash
# Disable
mkdir -p ~/.surfaces && touch ~/.surfaces/spotify-disabled

# Re-enable
rm ~/.surfaces/spotify-disabled

# Check cooldown
cat ~/.surfaces/spotify-cooldown 2>/dev/null || echo "no cooldown"

# Clear cooldown
rm -f ~/.surfaces/spotify-cooldown
```

---

## Out of scope — TODOs

1. **`chrisbuice-site` Pages Functions** (`spotify-search.ts`, `submit-track.ts`) — need their own KV-based cooldown. The submit endpoint calls the Worker's `/api/submit-track` which doesn't call Spotify. The search proxy in Pages does call Spotify directly and needs the same treatment.

2. **Worker ↔ grimmauldplace cooldown sync.** Currently independent — a ban triggered by the Worker doesn't prevent grimmauldplace scripts from continuing, and vice versa. Could be solved by having scripts check the Worker's KV via the D1 HTTP API pattern, or by having the Worker expose a `/api/spotify-status` endpoint. Document and defer.

3. **Proper notification channel.** Replace `~/.surfaces/spotify-incidents.log` with email/Pushover/Discord. The nightly summary email (`src/email/summary.ts`) could include a "Spotify status" section.

4. **Token-bucket rate limiter for concurrent processes.** The per-process 100ms minimum interval doesn't coordinate across the Worker and grimmauldplace. If both run simultaneously, they share the same Spotify app quota. A shared semaphore via KV is overkill for now.

5. **Reduce poll frequency.** The per-minute poll is the single largest consumer of Spotify API calls (~1,440/day). Reducing to every 2 minutes halves the load. Trade-off: now-playing latency goes from ≤60s to ≤120s. Worth considering but separate from the rate-limit fix.

6. **403 handling.** Spotify returns 403 for some quota-related cases distinct from 429. Currently falls through to generic error. Known gap; revisit if it bites.

7. **Log rotation for `~/.surfaces/spotify-incidents.log`.** Will grow forever. Low priority.
