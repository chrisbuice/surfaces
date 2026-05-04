/**
 * shortcut.ts — SHORTCUT_TOKEN-authenticated MCP endpoint for iOS Shortcuts.
 *
 * Mounted at /shortcut/mcp. The main /mcp path is OAuth-protected
 * (via OAuthProvider); this endpoint preserves the original bearer-token
 * auth so existing Shortcuts keep working without changes.
 */

import type { Env } from "../index";
import { handleMcp } from "./server";

export async function handleMcpShortcut(request: Request, env: Env): Promise<Response> {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.slice(7) !== env.SHORTCUT_TOKEN) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
      { headers: { "Content-Type": "application/json" } },
    );
  }
  return handleMcp(request, env);
}
