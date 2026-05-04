# Plan: Steps 6 & 7 — Worker-side pending trigger + MCP tools

Scope: §10 steps 6–7 from `docs/PLAN_LYRICS_TRANSPARENCY_PIVOT.md`.
Out of scope: dashboard panels, obsession-tier batch, cron setup, migration 009 comment fix.

---

## 1. `ensureAnalysisPending(uri)` — the pending trigger

**File:** `src/lyrics_analysis/pending.ts`

```ts
export async function ensureAnalysisPending(db: D1Database, uri: string): Promise<void>
```

Single `INSERT OR IGNORE INTO track_lyric_analysis_status (spotify_track_uri, status, last_attempted_at, attempts) VALUES (?, 'pending', ?, 0)`. The `last_attempted_at` column is NOT NULL with no default, so we supply `Math.floor(Date.now() / 1000)` as the insertion timestamp. `attempts` starts at 0 because the grimmauldplace cron increments it on actual attempt. Idempotent — if a row already exists (any status), the INSERT is a no-op. No race conditions because D1 is single-writer and `INSERT OR IGNORE` is atomic.

**Import path:** MCP tool handlers in `tools.ts` import from `../lyrics_analysis/pending`. No other callers yet; the dashboard panel will import the same function in a future session.

---

## 2. Cosine similarity helper

**File:** `src/lyrics_analysis/cosine.ts`

```ts
export function cosineSimilarity(a: Float32Array, b: Float32Array): number
```

Standard dot-product / (norm_a * norm_b). Returns 0 for zero-norm vectors. Pure function, no D1 dependency — trivially testable.

---

## 3. BLOB reads from D1

D1 returns BLOB columns as `ArrayBuffer` in the Workers runtime. We wrap each into `new Float32Array(arrayBuffer)` before passing to `cosineSimilarity`.

**Cold-load risk at obsession-tier scale (~800 tracks):** `find_similar_lyrics` and `lyric_search` each load ALL embeddings of their respective kind on every call. At 1024 dims × 4 bytes × 800 rows = ~3.2 MB per kind. Both kinds loaded in the same request would be ~6.4 MB, but no single tool loads both — `find_similar_lyrics` loads 'analysis' only, `lyric_search` loads 'lyrics' only. D1's query response limit is 10 MB, so 3.2 MB fits with margin. Expect ~50–100ms per call at obsession scale.

**Caching decision: no cache for v1.** Adding `caches.default` would save the D1 roundtrip on repeat calls, but introduces invalidation complexity (embeddings grow as grimmauldplace processes pending tracks; a stale cache silently omits new embeddings). The 50–100ms cost is acceptable for MCP tool latency. Revisit if the corpus grows past ~2000 tracks or if latency becomes noticeable in the dashboard panel (future session).

If scale ever demands it, the fix is a pre-computed nearest-neighbors table (offline job on grimmauldplace), not a Worker-side cache.

---

## 4. Voyage embedding from the Worker

`lyric_search(query)` needs to embed the user's query text at request time to compare against stored 'lyrics' embeddings. The Worker calls Voyage directly — it's a standard HTTPS POST to `api.voyageai.com/v1/embeddings`, same as the grimmauldplace pipeline does.

**Env change:** Add `VOYAGE_API_KEY?: string` to the `Env` interface in `src/index.ts` (optional — tool returns a clear error if unconfigured). Set via `wrangler secret put VOYAGE_API_KEY`.

**File:** `src/lyrics_analysis/voyage.ts`

```ts
export async function embedQuery(text: string, apiKey: string): Promise<Float32Array>
```

Single-text call to Voyage-3.5-lite with `input_type: "query"`, returns 1024-D Float32Array. Hardcoded model name (`voyage-3.5-lite`) to match the corpus embeddings in `track_lyric_embedding`.

**`input_type` matters:** Voyage distinguishes `input_type: "document"` (for corpus embeddings) from `input_type: "query"` (for search queries). phase-embed.ts already correctly uses `"document"` (confirmed at line 82). The Worker's `embedQuery` must use `"query"` — this is what makes asymmetric retrieval work. The two input types produce vectors in the same space but with different biases optimized for retrieval.

---

## 5. Three MCP tools

All registered in `src/mcp/tools.ts` — tool definitions added to `getToolDefinitions()`, handlers added to `callTool()`.

### 5a. `explain_song(uri)`

**Input:** `{ uri: string }` — a Spotify track URI (e.g. `spotify:track:abc123`).

**Logic:**
1. Query `track_lyric_analysis` JOIN `track_lyric_analysis_status` WHERE `spotify_track_uri = ?` AND `status = 'ok'`.
2. If row exists: return structured analysis fields (subject_paragraph, tones, listener_feel_generic, narrative_perspective, lyric_intrusion, etc.).
3. If no row or status != 'ok': call `ensureAnalysisPending(db, uri)`, return `{ status: 'pending', message: 'Analysis queued — check back in ~10 minutes.' }`.

**Returns:** `{ source: 'local-history-derived', ...analysis }` or `{ source: 'local-history-derived', status: 'pending', message: '...' }`.

### 5b. `find_similar_lyrics(seed_uri, count?)`

**Input:** `{ seed_uri: string, count?: number }` — default count=5.

**Logic:**
1. Load seed's 'analysis' embedding from `track_lyric_embedding` WHERE `spotify_track_uri = ? AND kind = 'analysis'`.
2. If no embedding: `ensureAnalysisPending(db, seed_uri)`, return pending.
3. Load ALL other 'analysis' embeddings: `SELECT spotify_track_uri, vector FROM track_lyric_embedding WHERE kind = 'analysis' AND spotify_track_uri != ?`.
4. Compute cosine similarity for each, sort descending, take top-K.
5. For each result URI, JOIN `track_lyrics` for `track_name` and `artist_name`, and JOIN `track_lyric_analysis` for `subject_paragraph` and `tones`.

**Metadata source:** `track_lyrics` is canonical — every analyzed URI has a row there with track_name and artist_name from the lyrics-backfill pipeline. This covers tracks that have been embedded but never played (exactly the twins widget use case), unlike `plays` or `track_taste` which only contain played tracks.

**Returns:** `{ source: 'local-history-derived', seed_uri, twins: [{ uri, track_name, artist_name, similarity, subject_paragraph, tones }] }`.

### 5c. `lyric_search(query, count?)`

**Input:** `{ query: string, count?: number }` — default count=10.

**Logic:**
1. Call `embedQuery(query, env.VOYAGE_API_KEY)` with `input_type: "query"` to get 1024-D vector.
2. Load ALL 'lyrics' embeddings: `SELECT spotify_track_uri, vector FROM track_lyric_embedding WHERE kind = 'lyrics'`.
3. Cosine rank, take top-K.
4. JOIN `track_lyrics` for track_name and artist_name; JOIN `track_lyric_analysis` for subject_paragraph.

**Returns:** `{ source: 'local-history-derived', query, results: [{ uri, track_name, artist_name, similarity, subject_paragraph }] }`.

**Error if no VOYAGE_API_KEY:** Return `{ error: 'VOYAGE_API_KEY not configured — lyric_search unavailable.' }` rather than throwing.

---

## 6. File inventory

New files:
- `src/lyrics_analysis/pending.ts` — `ensureAnalysisPending()`
- `src/lyrics_analysis/cosine.ts` — `cosineSimilarity()`
- `src/lyrics_analysis/voyage.ts` — `embedQuery()`
- `tests/unit/cosine.test.ts` — unit tests for cosine math
- `tests/unit/pending.test.ts` — unit tests for pending trigger idempotency
- `tests/unit/lyrics-tools.test.ts` — integration tests for the three MCP tools (vitest-pool-workers)

Modified files:
- `src/index.ts` — add `VOYAGE_API_KEY?: string` to `Env`
- `src/mcp/tools.ts` — import new modules, add 3 tool definitions + handlers

---

## 7. Tests

### 7a. `tests/unit/cosine.test.ts`

Pure-function tests (no D1 needed):
- Identical vectors → 1.0
- Orthogonal vectors → 0.0
- Opposite vectors → -1.0
- Zero vector → 0.0 (not NaN)
- Known angle → expected cosine value (within floating-point tolerance)

### 7b. `tests/unit/pending.test.ts`

Uses `cloudflare:test` env with real D1:
- Create `track_lyric_analysis_status` table
- Call `ensureAnalysisPending(db, uri)` — row inserted with status='pending', last_attempted_at set, attempts=0
- Call again with same URI — no error, still exactly 1 row (idempotent)
- Insert a row with status='ok', call `ensureAnalysisPending` — row unchanged (INSERT OR IGNORE respects existing rows)

### 7c. `tests/unit/lyrics-tools.test.ts`

Uses `cloudflare:test` env with real D1. Seeds tables with test data including 1024-D Float32Array BLOBs:
- `explain_song` with existing analysis → returns fields
- `explain_song` with no analysis → returns pending, creates status row
- `find_similar_lyrics` with seed embedding + corpus → returns ranked twins with metadata from `track_lyrics`
- `find_similar_lyrics` with no seed embedding → returns pending
- `lyric_search` — test the ranking/sorting logic with a pre-computed query vector injected directly (bypasses Voyage API call). Seed the DB with known 'lyrics' embeddings, compute expected rankings offline, verify the tool returns them in the right order.

---

## 8. Implementation order

1. `src/lyrics_analysis/cosine.ts` + `tests/unit/cosine.test.ts` — pure math, test immediately
2. `src/lyrics_analysis/pending.ts` + `tests/unit/pending.test.ts` — D1 only, test immediately
3. `src/lyrics_analysis/voyage.ts` — HTTP client, tested indirectly via lyrics-tools tests
4. `src/index.ts` — add VOYAGE_API_KEY to Env
5. `src/mcp/tools.ts` — wire up all three tools
6. `tests/unit/lyrics-tools.test.ts` — integration tests
7. Run full test suite, verify no regressions
