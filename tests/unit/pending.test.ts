import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import { ensureAnalysisPending } from "../../src/lyrics_analysis/pending";

const CREATE_TABLE =
  "CREATE TABLE IF NOT EXISTS track_lyric_analysis_status (spotify_track_uri TEXT PRIMARY KEY, status TEXT NOT NULL, last_attempted_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT)";

async function rowCount(db: D1Database): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) as cnt FROM track_lyric_analysis_status")
    .first<{ cnt: number }>();
  return r?.cnt ?? 0;
}

async function getRow(db: D1Database, uri: string) {
  return db
    .prepare("SELECT * FROM track_lyric_analysis_status WHERE spotify_track_uri = ?")
    .bind(uri)
    .first<{ spotify_track_uri: string; status: string; last_attempted_at: number; attempts: number; last_error: string | null }>();
}

describe("ensureAnalysisPending", () => {
  beforeEach(async () => {
    await env.DB.exec("DROP TABLE IF EXISTS track_lyric_analysis_status");
    await env.DB.exec(CREATE_TABLE);
  });

  it("inserts a pending row for a new URI", async () => {
    await ensureAnalysisPending(env.DB, "spotify:track:abc123");
    expect(await rowCount(env.DB)).toBe(1);

    const row = await getRow(env.DB, "spotify:track:abc123");
    expect(row?.status).toBe("pending");
    expect(row?.attempts).toBe(0);
    expect(row?.last_attempted_at).toBeGreaterThan(0);
  });

  it("is idempotent — second call does not duplicate or error", async () => {
    await ensureAnalysisPending(env.DB, "spotify:track:abc123");
    await ensureAnalysisPending(env.DB, "spotify:track:abc123");
    expect(await rowCount(env.DB)).toBe(1);
  });

  it("does not overwrite an existing 'ok' row", async () => {
    await env.DB
      .prepare(
        `INSERT INTO track_lyric_analysis_status
         (spotify_track_uri, status, last_attempted_at, attempts)
         VALUES (?, 'ok', 1000, 1)`,
      )
      .bind("spotify:track:done")
      .run();

    await ensureAnalysisPending(env.DB, "spotify:track:done");

    const row = await getRow(env.DB, "spotify:track:done");
    expect(row?.status).toBe("ok");
    expect(row?.attempts).toBe(1);
    expect(row?.last_attempted_at).toBe(1000);
  });

  it("handles multiple distinct URIs", async () => {
    await ensureAnalysisPending(env.DB, "spotify:track:a");
    await ensureAnalysisPending(env.DB, "spotify:track:b");
    expect(await rowCount(env.DB)).toBe(2);
  });
});
