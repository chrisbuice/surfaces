import { describe, it, expect, beforeEach } from "vitest";
import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../../src/index";
import {
  canonicalizeTrackId, insertSubmission, listNewSubmissions, markNotified,
  validateSubmitInput, isValidationError, insertTrackSubmission,
} from "../../src/submissions/queries";

const SUBMISSIONS_DDL =
  "CREATE TABLE IF NOT EXISTS submissions (" +
  "id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, " +
  "submitter_name TEXT, note TEXT, submitted_at INTEGER NOT NULL, " +
  "status TEXT NOT NULL DEFAULT 'new');";

const TRACK_SUBMISSIONS_DDL =
  "CREATE TABLE IF NOT EXISTS track_submissions (" +
  "id INTEGER PRIMARY KEY AUTOINCREMENT, track_id TEXT NOT NULL, " +
  "track_name TEXT, artist_name TEXT, from_name TEXT, note TEXT, " +
  "email TEXT, submitter_ip TEXT, user_agent TEXT, " +
  "spotify_add_status TEXT NOT NULL, spotify_error TEXT, " +
  "created_at INTEGER NOT NULL);";

async function reset(db: D1Database) {
  await db.exec("DROP TABLE IF EXISTS submissions;");
  await db.exec("DROP TABLE IF EXISTS track_submissions;");
  await db.exec(SUBMISSIONS_DDL);
  await db.exec(TRACK_SUBMISSIONS_DDL);
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
    const body = await resp.json() as { error: string; field: string };
    expect(body.error).toBe("validation");
    expect(body.field).toBe("track_id");
  });

  it("rejects overlong from field with 400", async () => {
    const req = makeReq(
      { track_id: "a".repeat(22), from: "y".repeat(81) },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string; field: string };
    expect(body.field).toBe("from");
  });

  it("rejects overlong note field with 400", async () => {
    const req = makeReq(
      { track_id: "a".repeat(22), note: "x".repeat(281) },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string; field: string };
    expect(body.field).toBe("note");
  });

  it("rejects invalid email with 400", async () => {
    const req = makeReq(
      { track_id: "a".repeat(22), email: "notanemail" },
      { "X-Surfaces-Secret": "right" },
    );
    const ctx = createExecutionContext();
    const resp = await worker.fetch(req, { ...env, SURFACES_SECRET: "right" }, ctx);
    await waitOnExecutionContext(ctx);
    expect(resp.status).toBe(400);
    const body = await resp.json() as { error: string; field: string };
    expect(body.field).toBe("email");
  });

  it("happy path: dual-writes and returns a friendly success body", async () => {
    const req = makeReq(
      {
        track_id: "4cOdK2wGLETKBW3PvgPWqT",
        from: "Maya",
        note: "  Reminded me of your seasonal playlists  ",
        email: "maya@example.com",
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

    // Legacy submissions table should have a row with canonical URI
    const rows = await listNewSubmissions(env.DB);
    expect(rows).toHaveLength(1);
    expect(rows[0].track_id).toBe("spotify:track:4cOdK2wGLETKBW3PvgPWqT");
    expect(rows[0].submitter_name).toBe("Maya");
    expect(rows[0].note).toBe("Reminded me of your seasonal playlists");

    // track_submissions table should have a row with bare ID and email
    const tsRow = await env.DB.prepare(
      "SELECT * FROM track_submissions WHERE id = ?",
    ).bind(body.id).first();
    expect(tsRow).not.toBeNull();
    expect(tsRow!.track_id).toBe("4cOdK2wGLETKBW3PvgPWqT");
    expect(tsRow!.from_name).toBe("Maya");
    expect(tsRow!.email).toBe("maya@example.com");
    // Spotify metadata fetch fails in test (no tokens) — expect nulls
    expect(tsRow!.spotify_add_status).toBe("skipped");
  });

  it("collapses empty strings to null on the optional fields", async () => {
    const req = makeReq(
      { track_id: "c".repeat(22), from: "", note: "   ", email: "" },
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

  it("never shows the submitter an error — returns 200 even when both tables are gone", async () => {
    await env.DB.exec("DROP TABLE IF EXISTS submissions;");
    await env.DB.exec("DROP TABLE IF EXISTS track_submissions;");
    const req = makeReq(
      { track_id: "d".repeat(22) },
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

describe("validateSubmitInput", () => {
  const validTrackId = "4iV5W9uYEdYUVa79Axb7Rh";

  it("accepts valid input with all fields", () => {
    const result = validateSubmitInput({
      track_id: validTrackId,
      from: "Alice",
      note: "Check this out!",
      email: "alice@example.com",
    });
    expect(isValidationError(result)).toBe(false);
    if (!isValidationError(result)) {
      expect(result.track_id).toBe(validTrackId);
      expect(result.from).toBe("Alice");
      expect(result.note).toBe("Check this out!");
      expect(result.email).toBe("alice@example.com");
    }
  });

  it("accepts valid input with only track_id", () => {
    const result = validateSubmitInput({ track_id: validTrackId });
    expect(isValidationError(result)).toBe(false);
    if (!isValidationError(result)) {
      expect(result.from).toBeNull();
      expect(result.note).toBeNull();
      expect(result.email).toBeNull();
    }
  });

  it("rejects missing track_id", () => {
    const result = validateSubmitInput({ from: "Alice" });
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) expect(result.field).toBe("track_id");
  });

  it("rejects track_id with wrong length", () => {
    expect(isValidationError(validateSubmitInput({ track_id: "short" }))).toBe(true);
    expect(isValidationError(validateSubmitInput({ track_id: "a".repeat(23) }))).toBe(true);
  });

  it("rejects track_id with special characters", () => {
    const result = validateSubmitInput({ track_id: "4iV5W9uYEdYUVa79Ax!@#$" });
    expect(isValidationError(result)).toBe(true);
  });

  it("accepts from at exactly 80 chars", () => {
    const result = validateSubmitInput({ track_id: validTrackId, from: "x".repeat(80) });
    expect(isValidationError(result)).toBe(false);
  });

  it("rejects from at 81 chars", () => {
    const result = validateSubmitInput({ track_id: validTrackId, from: "x".repeat(81) });
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) expect(result.field).toBe("from");
  });

  it("accepts note at exactly 280 chars", () => {
    const result = validateSubmitInput({ track_id: validTrackId, note: "x".repeat(280) });
    expect(isValidationError(result)).toBe(false);
  });

  it("rejects note at 281 chars", () => {
    const result = validateSubmitInput({ track_id: validTrackId, note: "x".repeat(281) });
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) expect(result.field).toBe("note");
  });

  it("rejects email without domain dot", () => {
    const result = validateSubmitInput({ track_id: validTrackId, email: "user@localhost" });
    expect(isValidationError(result)).toBe(true);
    if (isValidationError(result)) expect(result.field).toBe("email");
  });

  it("accepts valid email addresses", () => {
    for (const email of ["a@b.co", "user+tag@example.com", "name@sub.domain.org"]) {
      expect(isValidationError(validateSubmitInput({ track_id: validTrackId, email }))).toBe(false);
    }
  });

  it("trims whitespace from all fields", () => {
    const result = validateSubmitInput({
      track_id: `  ${validTrackId}  `,
      from: "  Alice  ",
      note: "  great track  ",
      email: "  alice@example.com  ",
    });
    expect(isValidationError(result)).toBe(false);
    if (!isValidationError(result)) {
      expect(result.track_id).toBe(validTrackId);
      expect(result.from).toBe("Alice");
      expect(result.note).toBe("great track");
      expect(result.email).toBe("alice@example.com");
    }
  });

  it("collapses empty optional fields to null", () => {
    const result = validateSubmitInput({
      track_id: validTrackId,
      from: "   ",
      note: "",
      email: "",
    });
    expect(isValidationError(result)).toBe(false);
    if (!isValidationError(result)) {
      expect(result.from).toBeNull();
      expect(result.note).toBeNull();
      expect(result.email).toBeNull();
    }
  });
});

describe("insertTrackSubmission", () => {
  beforeEach(async () => { await reset(env.DB); });

  it("inserts a row and returns the id", async () => {
    const id = await insertTrackSubmission(env.DB, {
      track_id: "4iV5W9uYEdYUVa79Axb7Rh",
      track_name: "Test Track",
      artist_name: "Test Artist",
      from_name: "Alice",
      note: "Listen to this",
      email: "alice@example.com",
      submitter_ip: "1.2.3.4",
      user_agent: "Mozilla/5.0",
      spotify_add_status: "ok",
      spotify_error: null,
    });
    expect(id).toBeGreaterThan(0);

    const row = await env.DB.prepare(
      "SELECT * FROM track_submissions WHERE id = ?",
    ).bind(id).first();
    expect(row).not.toBeNull();
    expect(row!.track_id).toBe("4iV5W9uYEdYUVa79Axb7Rh");
    expect(row!.track_name).toBe("Test Track");
    expect(row!.spotify_add_status).toBe("ok");
    expect(row!.spotify_error).toBeNull();
    expect(row!.created_at).toBeGreaterThan(0);
  });

  it("inserts with null optional fields and failed status", async () => {
    const id = await insertTrackSubmission(env.DB, {
      track_id: "6rqhFgbbKwnb9MLmUQDhG6",
      track_name: null,
      artist_name: null,
      from_name: null,
      note: null,
      email: null,
      submitter_ip: null,
      user_agent: null,
      spotify_add_status: "failed",
      spotify_error: "Spotify API 403: Forbidden",
    });

    const row = await env.DB.prepare(
      "SELECT * FROM track_submissions WHERE id = ?",
    ).bind(id).first();
    expect(row!.spotify_add_status).toBe("failed");
    expect(row!.spotify_error).toBe("Spotify API 403: Forbidden");
    expect(row!.from_name).toBeNull();
  });
});
