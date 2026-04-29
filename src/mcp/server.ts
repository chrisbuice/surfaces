/**
 * server.ts — MCP (Model Context Protocol) JSON-RPC 2.0 dispatcher.
 *
 * Handles: initialize, notifications/initialized, tools/list, tools/call.
 * Auth: Bearer token accepted if provided, but not required.
 * Single-user system — URL is the secret.
 */

import type { Env } from "../index";
import { getToolDefinitions, callTool } from "./tools";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "spotify-curation-agent", version: "1.0.0" };

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

function jsonRpcResult(id: string | number | null, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result }, {
    headers: { "Content-Type": "application/json" },
  });
}

function jsonRpcError(id: string | number | null, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  // Auth: accept Bearer token if provided, but don't require it.
  // Claude.ai connectors don't support Bearer auth natively.
  const authHeader = request.headers.get("Authorization");
  if (authHeader) {
    const token = authHeader.replace("Bearer ", "");
    if (token !== env.SHORTCUT_TOKEN) {
      return jsonRpcError(null, -32000, "Unauthorized");
    }
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  let body: JsonRpcRequest;
  try {
    body = await request.json() as JsonRpcRequest;
  } catch {
    return jsonRpcError(null, -32700, "Parse error");
  }

  if (body.jsonrpc !== "2.0") {
    return jsonRpcError(body.id ?? null, -32600, "Invalid Request: jsonrpc must be '2.0'");
  }

  const id = body.id ?? null;

  switch (body.method) {
    case "initialize":
      return jsonRpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case "notifications/initialized":
      // Notification — no response required
      return new Response(null, { status: 204 });

    case "tools/list":
      return jsonRpcResult(id, { tools: getToolDefinitions() });

    case "tools/call": {
      const toolName = body.params?.name as string;
      const toolArgs = (body.params?.arguments as Record<string, unknown>) ?? {};

      if (!toolName) {
        return jsonRpcError(id, -32602, "Invalid params: 'name' is required");
      }

      try {
        const result = await callTool(toolName, toolArgs, env);
        return jsonRpcResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return jsonRpcResult(id, {
          isError: true,
          content: [{ type: "text", text: message }],
        });
      }
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${body.method}`);
  }
}
