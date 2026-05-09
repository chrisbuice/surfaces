# Spotify Rate Limit: Audit, Fix, and Harden

**Status:** Plan-ready, not yet implemented
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
| 19 | `scripts/find-covers.ts:267,292` | Token + API | Single | Ad-hoc script | ✅ Partial (inline retry) | Direct fetch |
| 20 | `scripts/fetch-isrcs.ts:100` | `/v1/tracks/{id}` | Single | Ad-hoc script | ✅ Partial (inline retry) | Direct fetch |
| 21 | `stack/lyrics-backfill/phase-isrc.ts:41` | `/v1/tracks/{id}` | Single | Backfill script | ✅ Yes (retry + Retry-After) | Direct fetch |
| 22 | `stack/lyrics-backfill/lib/spotify.ts:42` | Token broker | Single | Per-run | ✅ Partial (retry) | Direct fetch |

**Summary:** 16 call sites go through `SpotifyClient` with ZERO 429 handling. 6 script call sites have partial handling. None use a centralized cooldown.

### 1.3 Existing breaker analysis

**Location:** `scripts/ingest-apple-music.ts` lines 269–312

**Bug:** On 5 consecutive `SpotifyRateLimitError`s, pauses 5 minutes then resets the counter and resumes. Spotify's `Retry-After` says 41,749 seconds (11.6 hours). The script waits 5 min, tries again, gets another 429, waits 5 min, tries again... ad infinitum. Each retry extends the ban.

**Worker impact:** The Worker cron does NOT use this breaker — it has NO breaker at all. The per-minute poll has been silently hitting Spotify during the entire ban, likely extending it. The poll's catch block (poll.ts:34) swallows the error, so from the Worker's perspective everything is "nothing playing."

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
// spotify:cooldown_until — epoch ms
// spotify:disabled — "true" if kill-switch active
```

Integrated into `SpotifyClient.request()`:
1. Call `assertSpotifyAllowed(kv)` before every fetch
2. On 429 response: call `setSpotifyCooldown()`, throw `SpotifyCooldownError`
3. On 5xx: retry with backoff (1s, 2s, 4s, max 3 retries)
4. On 401: refresh token once, retry once (existing behavior)
5. Minimum 100ms between consecutive calls (in-memory rate limiter)

**grimmauldplace side: `scripts/lib/spotify-rate-guard.ts`**

Same contract, file-based persistence:
- `~/.surfaces/spotify-cooldown` — contains epoch ms
- `~/.surfaces/spotify-disabled` — presence = disabled
- `~/.surfaces/spotify-incidents.log` — append-only log

### 2.2 SpotifyClient changes

`SpotifyClient` constructor gains `KV` access (already available via `env`). The `request()` method becomes:

```typescript
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

    if (resp.status === 204) return undefined as T;
    if (!resp.ok) throw new Error(`Spotify ${method} ${path} (${resp.status})`);
    // ... parse response ...
  }
}
```

### 2.3 Migration map

| # | Call site | Migration |
|---|---|---|
| 1–14 | All `SpotifyClient` callers | No change needed — `SpotifyClient.request()` handles it internally. Callers catch `SpotifyCooldownError` if they want to handle gracefully (cron jobs should log and exit). |
| 15 | `reccobeats.ts` | Out of scope (not Spotify) |
| 16 | `spotify-oauth.ts` token refresh | Add 429 detection, throw typed error. Don't retry token endpoint 429s — it means the app is banned. |
| 17 | `scripts/lib/spotify-matcher.ts` | Migrate to `scripts/lib/spotify-rate-guard.ts`. Replace `SpotifyRateLimitError` with file-based cooldown. Remove the `MAX_RETRY_WAIT_MS` cap — honor full Retry-After. |
| 18 | `scripts/lib/spotify-auth.ts` | Already has 429 detection. Add file-based cooldown write. |
| 19–20 | `find-covers.ts`, `fetch-isrcs.ts` | Low priority. Document as TODO — these are ad-hoc scripts rarely run. |
| 21–22 | `stack/lyrics-backfill/*` | Medium priority. These use the token broker, which goes through the Worker (already protected by #16). The direct `/v1/tracks` calls need migration. |

### 2.4 Test plan

Unit tests for `src/spotify/rate-guard.ts`:

1. 429 with `Retry-After: 78000` sets cooldown to exactly `now + 78000s`. Not capped.
2. 429 with no `Retry-After` sets cooldown to `now + 3600s`.
3. While cooldown active, `assertSpotifyAllowed()` throws `SpotifyCooldownError` without fetch.
4. After cooldown expires, calls proceed.
5. Kill-switch active throws `SpotifyDisabledError` before cooldown check.
6. 5xx triggers backoff: 1s, 2s, 4s, then throws.
7. 401 refreshes token once then succeeds; second 401 does not loop.
8. Two consecutive calls are separated by ≥100ms.
9. `setSpotifyCooldown()` writes to KV mock.
10. `assertSpotifyAllowed()` reads existing cooldown from KV on cold start.

Unit tests for `scripts/lib/spotify-rate-guard.ts`:
- Same contract, file-based: write/read `~/.surfaces/spotify-cooldown`.

### 2.5 Now-playing KV cache (D6)

The per-minute cron writes `spotify:now_playing` to KV with 30s TTL. The `/api/now-playing` endpoint reads from KV first. If miss, falls back to `poll_observations` (existing D1 fallback). Public hits NEVER call Spotify directly — they already don't (the cron is the only caller), but the cron itself needs the cooldown guard.

### 2.6 Apple-ingest caching improvements (D8)

- **Empty-artist skip:** If the text search would be `"Song Name" by ""`, skip the Spotify call entirely. Cache as `match_status = 'unmatched'` with a note. Current logs show many `by ""` queries wasting calls.
- **Negative cache:** `apple_track_matches` rows with `match_status = 'unmatched'` already serve as negative cache (the resumability logic skips them on re-run). Add a minimum age check: don't re-search unmatched tracks until `last_match_attempt_at` is >90 days old.
- **Positive cache:** Already implemented — matched tracks are cached in `apple_track_matches`.

### 2.7 Staged resumption plan

After merge and deploy:

| Step | Action | Gate |
|---|---|---|
| Hour 0 | Merge + deploy Worker. Cron continues but now respects cooldown/kill-switch. | — |
| Hour 24+ from last 429 | Clear cooldown: `wrangler kv:key delete spotify-agent-kv spotify:cooldown_until` | No 429s in Worker logs |
| A | Watch Worker logs for 1 hour. Confirm poll cron succeeds. | No errors |
| B | grimmauldplace: run apple-ingest `--limit=50 --skip-musicbrainz` | Summary shows matches, no 429 |
| C | grimmauldplace: run apple-ingest full (no limit) | Completes without circuit breaker |
| D | Re-enable discovery agent if disabled | No 429 in next daily run |

Abort at any step if a 429 fires.

### 2.8 Kill-switch commands

**Worker (KV):**
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
touch ~/.surfaces/spotify-disabled

# Re-enable
rm ~/.surfaces/spotify-disabled

# Check cooldown
cat ~/.surfaces/spotify-cooldown

# Clear cooldown
rm ~/.surfaces/spotify-cooldown
```

---

## Out of scope — TODOs

1. **`chrisbuice-site` Pages Functions** (`spotify-search.ts`, `submit-track.ts`) — need their own KV-based cooldown. The submit endpoint calls the Worker's `/api/submit-track` which doesn't call Spotify. The search proxy in Pages does call Spotify directly and needs the same treatment.

2. **Worker ↔ grimmauldplace cooldown sync.** Currently independent — a ban triggered by the Worker doesn't prevent grimmauldplace scripts from continuing, and vice versa. Could be solved by having scripts check the Worker's KV via the D1 HTTP API pattern, or by having the Worker expose a `/api/spotify-status` endpoint. Document and defer.

3. **Proper notification channel.** Replace `~/.surfaces/spotify-incidents.log` with email/Pushover/Discord. The nightly summary email (`src/email/summary.ts`) could include a "Spotify status" section.

4. **Token-bucket rate limiter for concurrent processes.** The per-process 100ms minimum interval doesn't coordinate across the Worker and grimmauldplace. If both run simultaneously, they share the same Spotify app quota. The Worker's calls are the dominant consumer (~1,640/day), so grimmauldplace should yield aggressively. A shared semaphore via KV is overkill for now.

5. **`scripts/find-covers.ts` and `scripts/fetch-isrcs.ts` migration.** These are rarely-run ad-hoc scripts. Low priority. Add a comment pointing to the rate-guard module.

6. **Reduce poll frequency.** The per-minute poll is the single largest consumer of Spotify API calls (~1,440/day). Reducing to every 2 minutes halves the load. Trade-off: now-playing latency goes from ≤60s to ≤120s. Worth considering but separate from the rate-limit fix.
