# Plan: OAuth 2.1 for MCP endpoint

**Status:** Approved — implementing.

## Goal

Let claude.ai connect to `/mcp` as a remote MCP server via its OAuth-based custom connector. The worker becomes both the **authorization server** and the **resource server** (they're co-located on the same Cloudflare Worker).

## Approach: Use `workers-oauth-provider`

Cloudflare's [`workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) implements the exact spec surface we need: OAuth 2.1 with PKCE, dynamic client registration (RFC 7591), authorization server metadata (RFC 8414), protected resource metadata (RFC 9728), and token lifecycle management backed by KV. It handles token generation, PKCE validation, client registration, metadata endpoints, and KV storage schema — we just implement the authorization UI and wire up our MCP handler.

Building this from scratch would mean ~800 lines of spec-compliant crypto, storage, and endpoint code that the library already provides and tests. Recommendation: **use the library directly.**

---

## 1. New endpoints

| Path | Method | Purpose | Who implements |
|------|--------|---------|----------------|
| `/.well-known/oauth-protected-resource` | GET | RFC 9728 — tells clients where our auth server is | Library (via `resourceMetadata` config) |
| `/.well-known/oauth-authorization-server` | GET | RFC 8414 — auth server metadata (endpoints, PKCE support, scopes) | Library (auto-generated) |
| `/oauth/authorize` | GET | Consent screen — browser-rendered | **Us** (defaultHandler) |
| `/oauth/token` | POST | Token exchange (auth code → access + refresh token) | Library |
| `/oauth/register` | POST | RFC 7591 dynamic client registration | Library |

No new routes to add to the existing `switch(url.pathname)` router — `OAuthProvider` wraps the entire worker and intercepts these paths before they reach our router.

## 2. Architecture change

Currently `src/index.ts` exports a plain `{ fetch, scheduled }` handler. With the library:

```
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpHandler,        // WorkerEntrypoint — handles authenticated /mcp requests
  defaultHandler: DefaultHandler, // Serves /oauth/authorize consent screen + passes through all other routes
  authorizeEndpoint: "/oauth/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["mcp"],
  accessTokenTTL: 3600,          // 1 hour
  refreshTokenTTL: 2592000,      // 30 days
  resourceMetadata: {
    resource: "https://spotify-agent.chrisbuice.workers.dev/mcp",
    authorization_servers: ["https://spotify-agent.chrisbuice.workers.dev"],
    scopes_supported: ["mcp"],
  },
}) satisfies ...;
```

**Key structural change:** The `OAuthProvider` becomes the top-level export. It routes:
- Requests to `/mcp` → validates the bearer token in KV → forwards to `McpHandler` with `props` attached
- Requests to `/.well-known/*`, `/oauth/token`, `/oauth/register` → handled internally by the library
- Everything else → `DefaultHandler`, which either renders `/oauth/authorize` or falls through to the existing router

The existing `scheduled` handler moves to a named export or gets attached separately (the library supports this pattern).

## 3. Authentication strategy for `/oauth/authorize`

Two options considered:

### Option A: SHORTCUT_TOKEN as the password (recommended)

The consent screen is a simple HTML form: "Enter your admin token to authorize this connection." The user submits `SHORTCUT_TOKEN`, we verify it matches `env.SHORTCUT_TOKEN`, then call `completeAuthorization()`.

**Pros:**
- No additional infrastructure (no Cloudflare Access dependency for this route)
- Works immediately — same secret you already know
- The consent screen is hit once per client registration, not on every request

**Cons:**
- You type the token into a browser form (HTTPS, so wire-safe; the form POSTs, so no URL logging)
- If someone discovers your worker URL *and* your SHORTCUT_TOKEN, they can authorize themselves. This does slightly expand risk compared to direct SHORTCUT_TOKEN use: a briefly-leaked token can be parlayed into a 30-day refresh token stored in KV, whereas direct SHORTCUT_TOKEN use is point-in-time. Rotating SHORTCUT_TOKEN alone won't invalidate already-issued OAuth tokens — you'd also need to wipe `OAUTH_KV` in a real incident.

### Option B: Cloudflare Access gate

Put `/oauth/authorize` behind Cloudflare Access. The browser redirect hits Access first, which validates your identity via email/SSO, then renders the consent screen.

**Pros:**
- No secret typing — Access handles identity
- Stronger factor (email/SSO vs. shared secret)

**Cons:**
- Adds a dependency: Access must be configured for this route, and you'd need to verify the Access JWT in the consent handler before calling `completeAuthorization()`
- Access is a browser-redirect flow inside an OAuth browser-redirect flow — two sequential redirects could confuse the OAuth client if not handled carefully
- More setup work for a single-user system

**Decision: Option A.** It's simpler, the risk expansion is modest (see con above), and the consent screen is only visited during initial connection setup. We can always layer on Access later.

## 4. Token storage

The library manages all KV storage. It requires a KV namespace bound as `OAUTH_KV`.

### What it stores (library-managed, we don't touch these directly):

| Key pattern | Content | TTL |
|-------------|---------|-----|
| `client:<hash>` | Registered client metadata (client_id, redirect_uris, etc.) | 90 days (configurable) |
| `grant:<hash>` | Authorization grant (userId, scope, encrypted props) | Lifetime of refresh token |
| `token:<hash>` | Access token → grant mapping | 1 hour (accessTokenTTL) |
| `refresh:<hash>` | Refresh token → grant mapping | 30 days (refreshTokenTTL) |
| `code:<hash>` | Authorization code (pending exchange) | ~60 seconds |

Tokens are stored by SHA-256 hash only — the plaintext token is never persisted. The `props` field (arbitrary data we attach at authorization time) is encrypted using the token as key material.

### New KV namespace needed

We need a second KV namespace bound as `OAUTH_KV` (the library requires this exact binding name). The existing `KV` binding stays untouched for all current uses.

```toml
# wrangler.toml — add:
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<create via wrangler kv:namespace create OAUTH_KV>"
```

### Env interface update

```typescript
export interface Env {
  // ... existing fields ...
  OAUTH_KV: KVNamespace;  // New: OAuth token storage
}
```

## 5. Updating `/mcp` to validate OAuth tokens

The library handles this automatically for routes matching `apiRoute`. When a request hits `/mcp`:

1. Library extracts `Authorization: Bearer <token>`
2. Looks up `token:<sha256(token)>` in `OAUTH_KV`
3. Checks expiration
4. If valid → forwards to `McpHandler` with `props` available via `this.ctx.props`
5. If invalid/missing → returns 401 with `WWW-Authenticate: Bearer` header per spec

### Keeping SHORTCUT_TOKEN working

The library only protects routes matching `apiRoute`. For the iOS Shortcuts path, two options:

**Option A (recommended): Dual-path routing.**
- `/mcp` → protected by OAuth (library handles it) — claude.ai uses this
- `/shortcut/mcp` → protected by SHORTCUT_TOKEN (existing logic) — iOS Shortcuts use this

We add a new `/shortcut/mcp` route that's a copy of the current `/mcp` auth check, and update the 6 iOS Shortcuts to hit `/shortcut/mcp` instead of `/mcp`. This is clean separation.

**Option B: Custom token validation in McpHandler.**
Inside `McpHandler.fetch()`, if the library rejects the token (shouldn't reach us), or if we intercept before the library, check if it's the SHORTCUT_TOKEN. This is messy — the library expects to own token validation for `apiRoute` paths.

**Option C: Pre-check middleware.**
In `defaultHandler`, intercept `/mcp` requests that carry the SHORTCUT_TOKEN *before* the library sees them, and handle them directly. Requests without SHORTCUT_TOKEN fall through to the library's OAuth validation.

**Decision: Option A.** Clean separation, no hacks. The Shortcuts just need a URL update — they already have a "Surfaces Base URL" variable that makes this a one-line change per Shortcut.

## 6. PKCE flow

Handled entirely by the library. Configuration:

```typescript
allowPlainPKCE: false,  // Require S256 — claude.ai supports it
```

The library:
- Stores `code_challenge` with the authorization code in KV
- On token exchange, hashes the `code_verifier` with SHA-256 and compares
- Never stores the verifier in plaintext (only the challenge is stored)

We don't need to write any PKCE code.

## 7. CORS

### Current state
- Global OPTIONS preflight returns `Access-Control-Allow-Origin: *` with `GET, POST, OPTIONS` methods and `Content-Type, Authorization` headers
- `addCors()` wraps all responses with `Access-Control-Allow-Origin: *`
- The `/mcp` response goes through `addCors()` (line 1957)

### What changes
With `OAuthProvider` as the top-level handler, it intercepts OAuth endpoints (`/.well-known/*`, `/oauth/*`) before our router. These responses won't go through our `addCors()` wrapper.

**Fix:** The library's responses need CORS headers for claude.ai to reach `/oauth/register` and `/.well-known/*` from the browser. Two approaches:

1. **Wrap OAuthProvider's fetch in a CORS layer** — intercept the final response and add headers. This is the cleanest approach since we already do this pattern.
2. **Add CORS inside defaultHandler** — only covers routes we handle, not library-handled routes.

**Decision: Option 1.** We wrap the `OAuthProvider` fetch output with our existing CORS logic:

```typescript
const provider = new OAuthProvider({ ... });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }
    const response = await provider.fetch(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, { status: response.status, headers });
  },
  async scheduled(...) { /* existing cron logic, unchanged */ },
};
```

## 8. Consent screen UI

A minimal HTML page served at `GET /oauth/authorize`. Flow:

1. Library redirects the browser here with query params (`client_id`, `redirect_uri`, `state`, `code_challenge`, `scope`, `response_type`)
2. We call `env.OAUTH_PROVIDER.parseAuthRequest(request)` to validate and extract params
3. We call `env.OAUTH_PROVIDER.lookupClient(clientId)` to get client metadata
4. Render an HTML form showing: client name, requested scopes, a password field for the admin token
5. On POST: verify the submitted token matches `env.SHORTCUT_TOKEN` using `crypto.subtle.timingSafeEqual` (constant-time comparison)
6. If valid: call `env.OAUTH_PROVIDER.completeAuthorization({ request: oauthReqInfo, userId: "owner", scope: ["mcp"], props: { role: "owner" } })`
7. Redirect to the returned `redirectTo` URL (back to claude.ai with the auth code)

The HTML is inline in the handler — no build step, no framework. ~50 lines of HTML.

## 9. Implementation file plan

| File | Change |
|------|--------|
| `package.json` | Add `workers-oauth-provider` dependency |
| `wrangler.toml` | Add `OAUTH_KV` namespace binding |
| `src/index.ts` | Restructure: `OAuthProvider` wraps the worker; existing router moves to `defaultHandler`; `scheduled` export preserved |
| `src/mcp/server.ts` | Remove auth check (library handles it). Accept `props` from context. Keep JSON-RPC dispatch. |
| `src/mcp/shortcut.ts` | New file: copy of current `handleMcp` with SHORTCUT_TOKEN auth, mounted at `/shortcut/mcp` |
| `src/oauth/authorize.ts` | New file: consent screen handler (GET renders form, POST validates token + completes auth) |
| `src/types.ts` or `src/index.ts` | Update `Env` interface with `OAUTH_KV` |
| `tests/unit/oauth.test.ts` | New: tests for the full OAuth flow |

## 10. Tests

Using `vitest-pool-workers` with Miniflare (existing pattern). The test config already binds `KV`; we add `OAUTH_KV`.

### Unit tests

| Test | What it verifies |
|------|-----------------|
| `POST /oauth/register` → 201 with client_id | Dynamic client registration works |
| `GET /oauth/authorize` with valid client → 200 HTML | Consent screen renders |
| `POST /oauth/authorize` with wrong token → 403 | Bad admin token rejected |
| `POST /oauth/authorize` with correct token → 302 redirect with code | Auth code issued |
| `POST /oauth/token` with valid code + verifier → 200 with access_token | Token exchange works |
| `POST /oauth/token` with bad verifier → 400 | PKCE validation works |
| `POST /mcp` with valid OAuth token → JSON-RPC response | MCP works with OAuth token |
| `POST /mcp` with expired/invalid token → 401 | Rejects bad OAuth tokens |
| `POST /oauth/token` with grant_type=refresh_token → new access_token | Refresh token exchange works |
| `POST /mcp` with refreshed token → JSON-RPC response | Refreshed token accepted |
| `POST /shortcut/mcp` with SHORTCUT_TOKEN → JSON-RPC response | Legacy path still works |
| `GET /.well-known/oauth-authorization-server` → valid metadata JSON | Metadata endpoint works |
| `GET /.well-known/oauth-protected-resource` → valid metadata JSON | Resource metadata works |

### Integration test: full flow

```
1. POST /oauth/register → get client_id, client_secret
2. GET /oauth/authorize?client_id=...&code_challenge=...&redirect_uri=... → 200 (consent form)
3. POST /oauth/authorize (with SHORTCUT_TOKEN in body) → 302 with ?code=...
4. POST /oauth/token (code + code_verifier) → { access_token, refresh_token }
5. POST /mcp with Bearer <access_token>, body: { method: "tools/list" } → 200 with tools
6. POST /oauth/token (grant_type=refresh_token) → new access_token
7. POST /mcp with new token → still works
```

## 11. Manual smoke test with claude.ai

After deploying:

1. Go to claude.ai → Settings → Integrations (or MCP servers section)
2. Add custom MCP server:
   - **Server URL:** `https://spotify-agent.chrisbuice.workers.dev/mcp`
   - **Auth type:** OAuth (claude.ai should auto-discover via `/.well-known/oauth-protected-resource`)
3. claude.ai initiates the OAuth flow:
   - It registers as a client via `/oauth/register`
   - It redirects your browser to `/oauth/authorize`
   - You see the consent screen, enter your SHORTCUT_TOKEN, submit
   - Browser redirects back to claude.ai with the auth code
   - claude.ai exchanges the code for tokens
4. Verify: claude.ai shows the available tools (from `tools/list`)
5. Test: ask Claude to call one of the tools — confirm it returns real data
6. Wait 1+ hours, try again — verify token refresh works silently

## 12. Rollback plan

If something breaks:
- The `/shortcut/mcp` endpoint with SHORTCUT_TOKEN auth is completely independent — iOS Shortcuts keep working regardless
- To disable OAuth entirely: revert `src/index.ts` to the non-wrapped export and remove the OAuth routes
- KV data from `OAUTH_KV` can be wiped without affecting anything in the main `KV` namespace

## 13. Out of scope (per instructions)

- Multi-user support
- Token revocation UI (delete from KV manually)
- Refresh token rotation tracking (issue new tokens on refresh, don't track families)
- Replacing SHORTCUT_TOKEN for iOS Shortcuts
- Scopes beyond "mcp" (single scope is sufficient for single-user)

## 14. Open questions — resolved

1. **`/shortcut/mcp`:** Confirmed — separate endpoint. ✓
2. **Worker URL:** `spotify-agent.chrisbuice.workers.dev` — used consistently in resourceMetadata. ✓
3. **`OAUTH_KV` namespace:** Separate namespace confirmed. ✓
4. **Expired token cleanup:** Not needed as a separate step. The library stores all KV keys (`token:`, `refresh:`, `grant:`, `code:`) with TTLs — grants get `expiration: expiresAt` set from `refreshTokenTTL` (30d). Cloudflare KV auto-expires them. No orphan problem. ✓
