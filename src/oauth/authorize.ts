/**
 * authorize.ts — OAuth consent screen for the /oauth/authorize endpoint.
 *
 * GET: renders an HTML form asking the user to enter their admin token.
 * POST: validates the token (constant-time comparison), then completes
 *       the OAuth authorization, redirecting back to the client with
 *       an authorization code.
 */

import type { Env } from "../index";

/**
 * Constant-time string comparison using crypto.subtle.timingSafeEqual.
 * Always compares the full length to avoid timing leaks on length.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const aBuf = encoder.encode(a);
  const bBuf = encoder.encode(b);
  if (aBuf.byteLength !== bBuf.byteLength) {
    // Burn the same time as a real comparison, then return false
    crypto.subtle.timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return crypto.subtle.timingSafeEqual(aBuf, bBuf);
}

export async function handleAuthorize(request: Request, env: Env): Promise<Response> {
  const oauthHelpers = env.OAUTH_PROVIDER;

  if (request.method === "GET") {
    const oauthReq = await oauthHelpers.parseAuthRequest(request);
    const client = await oauthHelpers.lookupClient(oauthReq.clientId);
    const clientName = client?.clientName ?? oauthReq.clientId;
    const scopes = oauthReq.scope.join(", ") || "mcp";
    const qs = new URL(request.url).search;

    return new Response(renderConsentPage(clientName, scopes, qs), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  if (request.method === "POST") {
    const oauthReq = await oauthHelpers.parseAuthRequest(request);
    const formData = await request.formData();
    const token = formData.get("token") as string | null;

    if (!token || !(await timingSafeEqual(token, env.SHORTCUT_TOKEN))) {
      const client = await oauthHelpers.lookupClient(oauthReq.clientId);
      const clientName = client?.clientName ?? oauthReq.clientId;
      const scopes = oauthReq.scope.join(", ") || "mcp";
      const qs = new URL(request.url).search;

      return new Response(
        renderConsentPage(clientName, scopes, qs, "Invalid token. Try again."),
        { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } },
      );
    }

    const { redirectTo } = await oauthHelpers.completeAuthorization({
      request: oauthReq,
      userId: "owner",
      metadata: { label: "claude.ai" },
      scope: oauthReq.scope.length > 0 ? oauthReq.scope : ["mcp"],
      props: { role: "owner" },
    });

    return Response.redirect(redirectTo, 302);
  }

  return new Response("Method not allowed", { status: 405 });
}

function renderConsentPage(clientName: string, scopes: string, queryString: string, error?: string): string {
  const errorHtml = error
    ? `<p style="color:#e74c3c;margin-bottom:16px">${esc(error)}</p>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — Surfaces</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 420px; margin: 80px auto; padding: 0 20px; color: #1a1a1a; }
    h1 { font-size: 1.3em; margin-bottom: 8px; }
    .client { color: #555; margin-bottom: 24px; }
    label { display: block; font-size: 0.9em; margin-bottom: 6px; font-weight: 500; }
    input[type="password"] { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 1em; box-sizing: border-box; }
    button { margin-top: 16px; padding: 10px 24px; background: #1a1a1a; color: #fff; border: none; border-radius: 6px; font-size: 1em; cursor: pointer; }
    button:hover { background: #333; }
    .scope { background: #f0f0f0; border-radius: 4px; padding: 2px 8px; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>Authorize Connection</h1>
  <p class="client"><strong>${esc(clientName)}</strong> is requesting access.</p>
  <p>Scopes: <span class="scope">${esc(scopes)}</span></p>
  ${errorHtml}
  <form method="POST" action="/oauth/authorize${esc(queryString)}">
    <label for="token">Admin Token</label>
    <input type="password" id="token" name="token" required autocomplete="off">
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
