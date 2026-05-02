import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import {
  canonicalizeTrackId, insertSubmission, listNewSubmissions, markNotified,
} from "../../src/submissions/queries";

const SUBMISSIONS_DDL =
  "CREATE TABLE IF NOT EXISTS submissions (" +
  "id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, " +
  "submitter_name TEXT, note TEXT, submitted_at INTEGER NOT NULL, " +
  "status TEXT NOT NULL DEFAULT 'new');";

async function reset(db: D1Database) {
  await db.exec("DROP TABLE IF EXISTS submissions;");
  await db.exec(SUBMISSIONS_DDL);
}

describe("canonicalizeTrackId", () => {
  it("accepts the canonical URI form", () => {
    expect(canonicalizeTrackId("spotify:track:4cOdK2wGLETKBW3PvgPWqT"))
      .toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
  });

  it("upgrades a bare 22-char id", () => {
    expect(canonicalizeTrackId("4cOdK2wGLETKBW3PvgPWqT"))
      .toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
  });

  it("extracts an id from a Spotify open.spotify.com URL", () => {
    expect(canonicalizeTrackId("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc"))
      .toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
  });

  it("rejects junk", () => {
    expect(canonicalizeTrackId("not a track")).toBeNull();
    expect(canonicalizeTrackId("")).toBeNull();
    expect(canonicalizeTrackId("spotify:album:abc")).toBeNull();
    // Wrong length:
    expect(canonicalizeTrackId("4cOdK2wGLETKBW3Pvg")).toBeNull();
  });
});

describe("submissions queries — insert / list / mark", () => {
  beforeEach(async () => { await reset(env.DB); });

  it("inserts and reads back via listNewSubmissions", async () => {
    const id = await insertSubmission(env.DB, {
      track_id: "spotify:track:4cOdK2wGLETKBW3PvgPWqT",
      submitter_name: "Maya",
      note: "Reminded me of your seasonal playlists",
    });
    expect(id).toBeGreaterThan(0);

    const rows = await listNewSubmissions(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0].track_id).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    expect(rows[0].submitter_name).toBe("Maya");
    expect(rows[0].status).toBe("new");
  });

  it("markNotified flips only the given ids and only when status=new", async () => {
    const a = await insertSubmission(env.DB, { track_id: "spotify:track:" + "a".repeat(22), submitter_name: null, note: null });
    const b = await insertSubmission(env.DB, { track_id: "spotify:track:" + "b".repeat(22), submitter_name: null, note: null });
    await markNotified(env.DB, [a]);
    const remaining = await listNewSubmissions(env.DB);
    expect(remaining.map(r => r.id)).toEqual([b]);
  });

  it("markNotified is a no-op for empty input", async () => {
    await insertSubmission(env.DB, { track_id: "spotify:track:" + "z".repeat(22), submitter_name: null, note: null });
    await expect(markNotified(env.DB, [])).resolves.toBeUndefined();
    expect(await listNewSubmissions(env.DB)).toHaveLength(1);
  });
});

describe("POST /api/submit-track endpoint", () => {
  beforeEach(async () => { await reset(env.DB); });

  function makeReq(body: unknown, headers: Record<string, string> = {}) {
    return new Request("https://surfaces.test/api/submit-track", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("rejects non-POST methods", async () => {
    const req = new Request("https://surfaces.test/api/submit-track");
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(405);
  });

  it("returns 503 when SURFACES_SECRET is unset", async () => {
    // miniflare should pass through env vars; it's empty by default in tests.
    const req = makeReq({ track_id: "spotify:track:" + "a".repeat(22) });
    const ctx = createExecutionContext();
    // We don't override env here — SURFACES_SECRET is unset in vitest.
    const resp = await worker.fetch(req, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(503);
  });

  it("returns 401 with the wrong secret", async () => {
    const req = makeReq(
      { track_id: "spotify:track:" + "a".repeat(22) },
      { "X-Surfaces-Secret": "nope" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(401);
  });

  it("rejects an invalid track_id with 400", async () => {
    const req = makeReq(
      { track_id: "garbage" },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
  });

  it("happy path: inserts and returns a friendly success body", async () => {
    const req = makeReq(
      {
        track_id: "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc",
        from: "Maya",
        note: "  Reminded me of your seasonal playlists  ",
      },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; id: number; message: string };
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe("number");
    expect(body.message).toMatch(/discovery pool/i);

    const rows = await listNewSubmissions(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0].track_id).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    expect(rows[0].submitter_name).toBe("Maya");
    // Note should be trimmed.
    expect(rows[0].note).toBe("Reminded me of your seasonal playlists");
  });

  it("trims and caps long inputs", async () => {
    const longNote = "x".repeat(500);
    const longFrom = "y".repeat(120);
    const req = makeReq(
      {
        track_id: "spotify:track:" + "a".repeat(22),
        from: longFrom,
        note: longNote,
      },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    const rows = await listNewSubmissions(env.DB);
    expect(rows[0].submitter_name?.length).toBe(80);
    expect(rows[0].note?.length).toBe(300);
  });

  it("collapses empty strings to null on the optional fields", async () => {
    const req = makeReq(
      { track_id: "spotify:track:" + "c".repeat(22), from: "", note: "   " },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    const rows = await listNewSubmissions(env.DB);
    expect(rows[0].submitter_name).toBeNull();
    expect(rows[0].note).toBeNull();
  });

  it("never shows the submitter an error — returns 200 even when the underlying write fails", async () => {
    // Drop the table so the INSERT throws. The endpoint must still return 200
    // with a "queued" message per spec §7.3 failure mode.
    await env.DB.exec("DROP TABLE IF EXISTS submissions;");
    const req = makeReq(
      { track_id: "spotify:track:" + "d".repeat(22) },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(200);
    const body = await resp.json() as { ok: boolean; queued?: boolean };
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(true);
  });
});
