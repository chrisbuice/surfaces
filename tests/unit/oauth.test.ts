import { describe, it, expect } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";

const BASE = "https://spotify-agent.chrisbuice.workers.dev";
const TEST_TOKEN = "test-shortcut-token-abc123";
const REDIRECT_URI = "http://localhost:3000/callback";

function testEnv() {
  return { ...env, SHORTCUT_TOKEN: TEST_TOKEN };
}

async function call(req: Request, envOverride = testEnv()) {
  const ctx = createExecutionContext();
  const resp = await worker.fetch(req, envOverride, ctx);
  await waitOnExecutionContext(ctx);
  return resp;
}

// ── PKCE helpers ──

async function generatePKCE() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  const verifier = base64url(array);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = base64url(new Uint8Array(digest));
  return { verifier, challenge };
}

function base64url(buf: Uint8Array): string {
  const str = btoa(String.fromCharCode(...buf));
  return str.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Register a dynamic client ──

async function registerClient(): Promise<{ clientId: string; clientSecret?: string }> {
  const resp = await call(
    new Request(`${BASE}/oauth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      }),
    }),
  );
  expect(resp.status).toBe(201);
  const body = await resp.json<{ client_id: string; client_secret?: string }>();
  expect(body.client_id).toBeTruthy();
  return { clientId: body.client_id, clientSecret: body.client_secret };
}

// ── Full auth code flow: register → authorize → token ──

async function getTokens() {
  const { clientId, clientSecret } = await registerClient();
  const { verifier, challenge } = await generatePKCE();
  const state = "test-state-xyz";

  // GET consent screen
  const authUrl = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
    `&code_challenge_method=S256&state=${state}&scope=mcp`;

  const getResp = await call(new Request(authUrl));
  expect(getResp.status).toBe(200);
  const html = await getResp.text();
  expect(html).toContain("Authorize Connection");

  // POST consent with valid token
  const postResp = await call(
    new Request(authUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `token=${encodeURIComponent(TEST_TOKEN)}`,
      redirect: "manual",
    }),
  );
  // Should redirect with auth code
  expect(postResp.status).toBe(302);
  const location = postResp.headers.get("Location")!;
  expect(location).toBeTruthy();
  const redirectUrl = new URL(location);
  const code = redirectUrl.searchParams.get("code");
  expect(code).toBeTruthy();
  expect(redirectUrl.searchParams.get("state")).toBe(state);

  // Exchange code for tokens
  const tokenBody: Record<string, string> = {
    grant_type: "authorization_code",
    code: code!,
    redirect_uri: REDIRECT_URI,
    client_id: clientId,
    code_verifier: verifier,
  };
  if (clientSecret) {
    tokenBody.client_secret = clientSecret;
  }

  const tokenResp = await call(
    new Request(`${BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(tokenBody).toString(),
    }),
  );
  expect(tokenResp.status).toBe(200);
  const tokens = await tokenResp.json<{
    access_token: string;
    refresh_token?: string;
    token_type: string;
    expires_in: number;
  }>();
  expect(tokens.access_token).toBeTruthy();
  expect(tokens.token_type).toBe("bearer");
  expect(tokens.expires_in).toBe(3600);

  return { ...tokens, clientId, clientSecret };
}

// ═══════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════

describe("OAuth metadata endpoints", () => {
  it("GET /.well-known/oauth-protected-resource returns valid metadata", async () => {
    const resp = await call(new Request(`${BASE}/.well-known/oauth-protected-resource`));
    expect(resp.status).toBe(200);
    const body = await resp.json<{ resource: string; authorization_servers: string[] }>();
    expect(body.resource).toBe(`${BASE}/mcp`);
    expect(body.authorization_servers).toContain(BASE);
  });

  it("GET /.well-known/oauth-authorization-server returns valid metadata", async () => {
    const resp = await call(new Request(`${BASE}/.well-known/oauth-authorization-server`));
    expect(resp.status).toBe(200);
    const body = await resp.json<{
      issuer: string;
      authorization_endpoint: string;
      token_endpoint: string;
      registration_endpoint: string;
      code_challenge_methods_supported: string[];
    }>();
    expect(body.authorization_endpoint).toContain("/oauth/authorize");
    expect(body.token_endpoint).toContain("/oauth/token");
    expect(body.registration_endpoint).toContain("/oauth/register");
    expect(body.code_challenge_methods_supported).toContain("S256");
  });
});

describe("OAuth dynamic client registration", () => {
  it("POST /oauth/register creates a client", async () => {
    const { clientId } = await registerClient();
    expect(clientId).toBeTruthy();
  });
});

describe("OAuth consent screen", () => {
  it("GET /oauth/authorize renders the consent form", async () => {
    const { clientId } = await registerClient();
    const { challenge } = await generatePKCE();
    const url = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=s1&scope=mcp`;
    const resp = await call(new Request(url));
    expect(resp.status).toBe(200);
    const html = await resp.text();
    expect(html).toContain("Authorize Connection");
    expect(html).toContain("Admin Token");
  });

  it("POST /oauth/authorize with wrong token returns 403", async () => {
    const { clientId } = await registerClient();
    const { challenge } = await generatePKCE();
    const url = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=s1&scope=mcp`;
    const resp = await call(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "token=wrong-token",
        redirect: "manual",
      }),
    );
    expect(resp.status).toBe(403);
    const html = await resp.text();
    expect(html).toContain("Invalid token");
  });

  it("POST /oauth/authorize with correct token redirects with code", async () => {
    const { clientId } = await registerClient();
    const { challenge } = await generatePKCE();
    const url = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=mystate&scope=mcp`;
    const resp = await call(
      new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(TEST_TOKEN)}`,
        redirect: "manual",
      }),
    );
    expect(resp.status).toBe(302);
    const location = new URL(resp.headers.get("Location")!);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("mystate");
  });
});

describe("OAuth token exchange", () => {
  it("exchanges auth code + PKCE verifier for tokens", async () => {
    const tokens = await getTokens();
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.expires_in).toBe(3600);
  });

  it("rejects bad PKCE verifier", async () => {
    const { clientId, clientSecret } = await registerClient();
    const { challenge } = await generatePKCE();
    const state = "pkce-fail-test";

    const authUrl = `${BASE}/oauth/authorize?response_type=code&client_id=${clientId}` +
      `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&code_challenge=${challenge}` +
      `&code_challenge_method=S256&state=${state}&scope=mcp`;

    const postResp = await call(
      new Request(authUrl, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(TEST_TOKEN)}`,
        redirect: "manual",
      }),
    );
    const code = new URL(postResp.headers.get("Location")!).searchParams.get("code")!;

    const tokenBody: Record<string, string> = {
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: "totally-wrong-verifier-that-does-not-match",
    };
    if (clientSecret) tokenBody.client_secret = clientSecret;

    const tokenResp = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(tokenBody).toString(),
      }),
    );
    expect(tokenResp.status).toBe(400);
  });
});

describe("OAuth refresh token exchange", () => {
  it("exchanges refresh token for a new access token", async () => {
    const tokens = await getTokens();
    expect(tokens.refresh_token).toBeTruthy();

    const refreshBody: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: tokens.clientId,
    };
    if (tokens.clientSecret) refreshBody.client_secret = tokens.clientSecret;

    const resp = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(refreshBody).toString(),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ access_token: string; token_type: string; expires_in: number }>();
    expect(body.access_token).toBeTruthy();
    expect(body.access_token).not.toBe(tokens.access_token);
    expect(body.token_type).toBe("bearer");
  });

  it("MCP works with a refreshed token", async () => {
    const tokens = await getTokens();

    const refreshBody: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token!,
      client_id: tokens.clientId,
    };
    if (tokens.clientSecret) refreshBody.client_secret = tokens.clientSecret;

    const refreshResp = await call(
      new Request(`${BASE}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(refreshBody).toString(),
      }),
    );
    const { access_token } = await refreshResp.json<{ access_token: string }>();

    const mcpResp = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(mcpResp.status).toBe(200);
    const body = await mcpResp.json<{ result?: { protocolVersion: string } }>();
    expect(body.result?.protocolVersion).toBeTruthy();
  });
});

describe("MCP with OAuth token", () => {
  it("POST /mcp with valid OAuth token returns tools/list", async () => {
    const tokens = await getTokens();
    const resp = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${tokens.access_token}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ result?: { tools: unknown[] } }>();
    expect(body.result?.tools).toBeDefined();
    expect(Array.isArray(body.result?.tools)).toBe(true);
  });

  it("POST /mcp with invalid token returns 401", async () => {
    const resp = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer totally-bogus-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(resp.status).toBe(401);
  });

  it("POST /mcp without Authorization returns 401", async () => {
    const resp = await call(
      new Request(`${BASE}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(resp.status).toBe(401);
  });
});

describe("/shortcut/mcp legacy path", () => {
  it("POST /shortcut/mcp with SHORTCUT_TOKEN returns tools/list", async () => {
    const resp = await call(
      new Request(`${BASE}/shortcut/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${TEST_TOKEN}`,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(resp.status).toBe(200);
    const body = await resp.json<{ result?: { tools: unknown[] } }>();
    expect(body.result?.tools).toBeDefined();
  });

  it("POST /shortcut/mcp with wrong token returns unauthorized", async () => {
    const resp = await call(
      new Request(`${BASE}/shortcut/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer wrong-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(resp.status).toBe(200); // JSON-RPC error is in body, HTTP is 200
    const body = await resp.json<{ error?: { code: number } }>();
    expect(body.error?.code).toBe(-32001);
  });
});

describe("CORS headers", () => {
  it("OPTIONS returns CORS preflight headers", async () => {
    const resp = await call(
      new Request(`${BASE}/mcp`, { method: "OPTIONS" }),
    );
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("OAuth metadata response includes CORS headers", async () => {
    const resp = await call(
      new Request(`${BASE}/.well-known/oauth-protected-resource`),
    );
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});
