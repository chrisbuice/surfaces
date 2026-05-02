import { describe, it, expect, beforeEach } from "vitest";
import { env } from "cloudflare:test";
import type { SpotifyClient } from "../../src/spotify/client";
import { syncSubmissionsToFreshPool } from "../../src/submissions/fresh_pool_sync";
import { insertSubmission, markNotified } from "../../src/submissions/queries";

const SUBMISSIONS_DDL =
  "CREATE TABLE IF NOT EXISTS submissions (" +
  "id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, " +
  "submitter_name TEXT, note TEXT, submitted_at INTEGER NOT NULL, " +
  "status TEXT NOT NULL DEFAULT 'new');";

const FRESH_POOL_DDL =
  "CREATE TABLE IF NOT EXISTS fresh_pool (" +
  "id INTEGER PRIMARY KEY, track_id TEXT NOT NULL, " +
  "track_name TEXT NOT NULL, artist_ids TEXT NOT NULL, " +
  "primary_artist_id TEXT NOT NULL, source TEXT NOT NULL, " +
  "source_detail TEXT, found_at INTEGER NOT NULL, " +
  "taste_score REAL NOT NULL, status TEXT NOT NULL DEFAULT 'fresh', " +
  "status_changed_at INTEGER, expires_at INTEGER, UNIQUE(track_id));";

async function reset(db: D1Database) {
  await db.exec("DROP TABLE IF EXISTS submissions;");
  await db.exec("DROP TABLE IF EXISTS fresh_pool;");
  await db.exec(SUBMISSIONS_DDL);
  await db.exec(FRESH_POOL_DDL);
}

/** Build a stub Spotify client that returns a canned response for /v1/tracks/<id>. */
function fakeSpotify(byTrackId: Record<string, unknown>): SpotifyClient {
  return {
    async get<T>(path: string): Promise<T> {
      // Path is like "/v1/tracks/<id>"
      const id = path.replace("/v1/tracks/", "");
      if (!(id in byTrackId)) throw new Error("404 Not Found");
      return byTrackId[id] as T;
    },
  } as unknown as SpotifyClient;
}

describe("syncSubmissionsToFreshPool", () => {
  beforeEach(async () => { await reset(env.DB); });

  it("does nothing when no submissions are notified", async () => {
    const result = await syncSubmissionsToFreshPool(env.DB, fakeSpotify({}));
    expect(result.candidates).toBe(0);
    expect(result.added).toBe(0);
  });

  it("adds a notified submission to fresh_pool and flips status to added_to_pool", async () => {
    const id = await insertSubmission(env.DB, {
      track_id: "spotify:track:" + "a".repeat(22),
      submitter_name: "Maya",
      note: "Great track",
    });
    await markNotified(env.DB, [id]);

    const spot = fakeSpotify({
      ["a".repeat(22)]: {
        id: "a".repeat(22),
        name: "Test Track",
        artists: [{ id: "art_1", name: "Test Artist" }, { id: "art_2", name: "Featured" }],
      },
    });

    const result = await syncSubmissionsToFreshPool(env.DB, spot);
    expect(result.candidates).toBe(1);
    expect(result.added).toBe(1);
    expect(result.rejected).toBe(0);

    // Submission status flipped
    const subRow = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?")
      .bind(id).first<{ status: string }>();
    expect(subRow?.status).toBe("added_to_pool");

    // Fresh pool row exists with the right metadata
    const poolRow = await env.DB.prepare(
      "SELECT track_id, track_name, primary_artist_id, source, source_detail, taste_score, artist_ids FROM fresh_pool WHERE track_id = ?"
    ).bind("a".repeat(22)).first<{
      track_id: string; track_name: string; primary_artist_id: string;
      source: string; source_detail: string; taste_score: number; artist_ids: string;
    }>();
    expect(poolRow).toBeTruthy();
    expect(poolRow!.track_name).toBe("Test Track");
    expect(poolRow!.primary_artist_id).toBe("art_1");
    expect(poolRow!.source).toBe("submission");
    expect(poolRow!.source_detail).toBe("from Maya");
    expect(JSON.parse(poolRow!.artist_ids)).toEqual(["art_1", "art_2"]);
    expect(poolRow!.taste_score).toBeCloseTo(0.7);
  });

  it("uses 'anonymous submission' when no submitter name", async () => {
    const id = await insertSubmission(env.DB, {
      track_id: "spotify:track:" + "b".repeat(22),
      submitter_name: null, note: null,
    });
    await markNotified(env.DB, [id]);

    const spot = fakeSpotify({
      ["b".repeat(22)]: { id: "b".repeat(22), name: "X", artists: [{ id: "z", name: "Y" }] },
    });
    await syncSubmissionsToFreshPool(env.DB, spot);

    const poolRow = await env.DB.prepare(
      "SELECT source_detail FROM fresh_pool WHERE track_id = ?"
    ).bind("b".repeat(22)).first<{ source_detail: string }>();
    expect(poolRow?.source_detail).toBe("anonymous submission");
  });

  it("marks 'rejected' when Spotify can't find the track", async () => {
    const id = await insertSubmission(env.DB, {
      track_id: "spotify:track:" + "c".repeat(22),
      submitter_name: null, note: null,
    });
    await markNotified(env.DB, [id]);

    const result = await syncSubmissionsToFreshPool(env.DB, fakeSpotify({}));
    expect(result.candidates).toBe(1);
    expect(result.rejected).toBe(1);
    expect(result.added).toBe(0);

    const subRow = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?")
      .bind(id).first<{ status: string }>();
    expect(subRow?.status).toBe("rejected");
  });

  it("marks 'rejected' when the track has no artist ids", async () => {
    const id = await insertSubmission(env.DB, {
      track_id: "spotify:track:" + "d".repeat(22),
      submitter_name: null, note: null,
    });
    await markNotified(env.DB, [id]);

    const spot = fakeSpotify({
      ["d".repeat(22)]: { id: "d".repeat(22), name: "X", artists: [] },
    });
    const result = await syncSubmissionsToFreshPool(env.DB, spot);
    expect(result.rejected).toBe(1);

    const subRow = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?")
      .bind(id).first<{ status: string }>();
    expect(subRow?.status).toBe("rejected");
  });

  it("does not consume rows still in 'new' status", async () => {
    const newId = await insertSubmission(env.DB, {
      track_id: "spotify:track:" + "e".repeat(22),
      submitter_name: null, note: null,
    });
    // Deliberately do NOT call markNotified — row stays 'new'.

    const result = await syncSubmissionsToFreshPool(env.DB, fakeSpotify({}));
    expect(result.candidates).toBe(0);

    const subRow = await env.DB.prepare("SELECT status FROM submissions WHERE id = ?")
      .bind(newId).first<{ status: string }>();
    expect(subRow?.status).toBe("new");
  });
});
