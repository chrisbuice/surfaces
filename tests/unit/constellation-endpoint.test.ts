import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import { KV_KEY } from "../../src/constellation/cron";

describe("/api/constellation endpoint", () => {
  beforeEach(async () => {
    await env.KV.delete(KV_KEY);
  });

  it("returns 404 with a friendly body when no constellation has been generated", async () => {
    const req = new Request("https://surfaces.test/api/constellation");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(resp.status).toBe(404);
    expect(resp.headers.get("Content-Type")).toContain("application/json");
    expect(resp.headers.get("Cache-Control")).toBe("no-store");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await resp.json() as { error: string };
    expect(body.error).toMatch(/not yet/i);
  });

  it("returns the cached JSON with public,max-age=3600 cache headers", async () => {
    const fakePayload = {
      generated_at: "2026-05-02T08:00:00Z",
      stats: { total_plays: 42, total_artists: 3, total_seasons: 0, data_starts: "2011-12-10" },
      era_buckets: [
        { label: "2011–2014", color: "#c8956d" },
      ],
      viewbox: { width: 1000, height: 1000 },
      nodes: [],
      edges: [],
    };
    await env.KV.put(KV_KEY, JSON.stringify(fakePayload));

    const req = new Request("https://surfaces.test/api/constellation");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toContain("application/json");
    expect(resp.headers.get("Cache-Control")).toBe("public, max-age=3600");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    const body = await resp.json() as typeof fakePayload;
    expect(body.stats.total_plays).toBe(42);
    expect(body.viewbox).toEqual({ width: 1000, height: 1000 });
  });

  it("rejects non-GET methods", async () => {
    await env.KV.put(KV_KEY, JSON.stringify({ stats: {} }));
    const req = new Request("https://surfaces.test/api/constellation", { method: "POST" });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(405);
  });

  it("answers OPTIONS preflight with permissive CORS", async () => {
    const req = new Request("https://surfaces.test/api/constellation", { method: "OPTIONS" });
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});
