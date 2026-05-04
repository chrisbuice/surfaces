import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { callTool } from "../../src/mcp/tools";
import type { Env } from "../../src/index";

// ── Helpers ────────────────────────────────────────────────────────────────

/** Encode a Float32Array as a hex string for D1 x'' BLOB literals. */
function float32ToHex(arr: Float32Array): string {
  return [...new Uint8Array(arr.buffer)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Build a deterministic 1024-D vector from a seed number. */
function makeVec(seed: number): Float32Array {
  const v = new Float32Array(1024);
  for (let i = 0; i < 1024; i++) v[i] = Math.sin(seed * 1000 + i);
  return v;
}

// ── DDL (single-line for D1 exec) ──────────────────────────────────────────

const DDL = [
  "CREATE TABLE IF NOT EXISTS track_lyric_analysis_status (spotify_track_uri TEXT PRIMARY KEY, status TEXT NOT NULL, last_attempted_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1, last_error TEXT)",
  "CREATE TABLE IF NOT EXISTS track_lyric_analysis (spotify_track_uri TEXT PRIMARY KEY, subject_paragraph TEXT NOT NULL, subject_tags TEXT NOT NULL, listener_feel_generic TEXT NOT NULL, listener_feel_chris TEXT, tones TEXT NOT NULL, language TEXT NOT NULL, narrative_pov TEXT, addressed_to TEXT, time_frame TEXT, story_arc TEXT, narrator_reliability TEXT, vocal_delivery_inferred TEXT, tempo_feel TEXT, energy_curve TEXT, dynamic_range TEXT, vocab_level TEXT, slang_era TEXT, references_json TEXT, explicitness REAL, content_flags TEXT, quotability INTEGER, rhyme_scheme TEXT, repetition_density REAL, chorus_verse_balance REAL, line_length_variance REAL, has_bridge INTEGER, structure_signature TEXT, activity_fit TEXT, lyric_intrusion REAL, analyzed_at INTEGER NOT NULL, analysis_version TEXT NOT NULL, model_id TEXT NOT NULL, lyrics_hash TEXT NOT NULL, audio_analyzed_at INTEGER, audio_features_inferred TEXT, audio_source TEXT)",
  "CREATE TABLE IF NOT EXISTS track_lyric_embedding (spotify_track_uri TEXT NOT NULL, kind TEXT NOT NULL, vector BLOB NOT NULL, model TEXT NOT NULL, embedded_at INTEGER NOT NULL, PRIMARY KEY (spotify_track_uri, kind))",
  "CREATE TABLE IF NOT EXISTS track_lyrics (spotify_track_uri TEXT PRIMARY KEY, track_name TEXT NOT NULL, artist_name TEXT NOT NULL, album_name TEXT, duration_ms INTEGER, isrc TEXT, lyrics_plain TEXT, lyrics_synced TEXT, instrumental INTEGER NOT NULL DEFAULT 0, lyrics_length INTEGER, status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'lrclib', match_method TEXT, fetched_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1)",
];

const URIS = {
  analyzed: "spotify:track:analyzed1",
  unanalyzed: "spotify:track:unanalyzed1",
  twin1: "spotify:track:twin1",
  twin2: "spotify:track:twin2",
  twinFar: "spotify:track:twinfar",
};

// Build vectors with known similarity ordering.
// seed=1 is the seed; seed=1.001 is closest, seed=1.01 next, seed=50 is far.
const VEC_SEED = makeVec(1);
const VEC_CLOSE1 = makeVec(1.001);
const VEC_CLOSE2 = makeVec(1.01);
const VEC_FAR = makeVec(50);

// ── Seed data ──────────────────────────────────────────────────────────────

async function seedTestData(db: D1Database) {
  for (const ddl of DDL) await db.exec(ddl);

  const now = Math.floor(Date.now() / 1000);

  // Status rows
  await db.prepare(
    "INSERT INTO track_lyric_analysis_status (spotify_track_uri, status, last_attempted_at, attempts) VALUES (?, 'ok', ?, 1)",
  ).bind(URIS.analyzed, now).run();

  // Analysis row for the analyzed track
  await db.prepare(
    `INSERT INTO track_lyric_analysis
     (spotify_track_uri, subject_paragraph, subject_tags, listener_feel_generic, tones, language,
      narrative_pov, lyric_intrusion, vocab_level, explicitness,
      analyzed_at, analysis_version, model_id, lyrics_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    URIS.analyzed,
    "A song about leaving home and finding yourself.",
    '["departure","self-discovery"]',
    '{"primary_emotion":"bittersweet nostalgia","intensity":0.7}',
    '["wistful","hopeful"]',
    "en",
    "first-person",
    0.4,
    "conversational",
    0.1,
    now, "v1", "claude-sonnet-4-20250514", "abc123",
  ).run();

  // track_lyrics metadata for all tracks used in similarity tests
  const lyricsRows = [
    [URIS.analyzed, "Leaving Home", "The Wanderers", "ok"],
    [URIS.twin1, "Road Trip", "Highway Band", "ok"],
    [URIS.twin2, "Horizon Bound", "Sunset Crew", "ok"],
    [URIS.twinFar, "Completely Different", "Other Artist", "ok"],
  ];
  for (const [uri, name, artist, status] of lyricsRows) {
    await db.prepare(
      "INSERT INTO track_lyrics (spotify_track_uri, track_name, artist_name, status, fetched_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(uri, name, artist, status, now).run();
  }

  // Analysis rows for twin tracks (needed for subject_paragraph in results)
  await db.prepare(
    `INSERT INTO track_lyric_analysis
     (spotify_track_uri, subject_paragraph, subject_tags, listener_feel_generic, tones, language,
      analyzed_at, analysis_version, model_id, lyrics_hash)
     VALUES (?, 'A road trip song.', '["travel"]', '{"primary_emotion":"excitement","intensity":0.8}', '["energetic"]', 'en', ?, 'v1', 'claude-sonnet-4-20250514', 'def456')`,
  ).bind(URIS.twin1, now).run();

  await db.prepare(
    `INSERT INTO track_lyric_analysis
     (spotify_track_uri, subject_paragraph, subject_tags, listener_feel_generic, tones, language,
      analyzed_at, analysis_version, model_id, lyrics_hash)
     VALUES (?, 'Chasing the horizon.', '["travel"]', '{"primary_emotion":"wonder","intensity":0.6}', '["dreamy"]', 'en', ?, 'v1', 'claude-sonnet-4-20250514', 'ghi789')`,
  ).bind(URIS.twin2, now).run();

  // Embeddings — use hex literals for BLOBs
  const embeddings: [string, string, Float32Array][] = [
    [URIS.analyzed, "analysis", VEC_SEED],
    [URIS.twin1, "analysis", VEC_CLOSE1],
    [URIS.twin2, "analysis", VEC_CLOSE2],
    [URIS.twinFar, "analysis", VEC_FAR],
    // lyrics-kind embeddings for lyric_search tests
    [URIS.analyzed, "lyrics", VEC_SEED],
    [URIS.twin1, "lyrics", VEC_CLOSE1],
    [URIS.twinFar, "lyrics", VEC_FAR],
  ];

  for (const [uri, kind, vec] of embeddings) {
    const hex = float32ToHex(vec);
    await db.exec(
      `INSERT INTO track_lyric_embedding (spotify_track_uri, kind, vector, model, embedded_at) VALUES ('${uri}', '${kind}', x'${hex}', 'voyage-3.5-lite', ${now})`,
    );
  }

  // Status rows for twin tracks (so ensureAnalysisPending doesn't try to insert)
  for (const uri of [URIS.twin1, URIS.twin2, URIS.twinFar]) {
    await db.prepare(
      "INSERT OR IGNORE INTO track_lyric_analysis_status (spotify_track_uri, status, last_attempted_at, attempts) VALUES (?, 'ok', ?, 1)",
    ).bind(uri, now).run();
  }
}

// ── Fake env that only exposes DB ──────────────────────────────────────────

function testEnv(): Env {
  return {
    DB: env.DB,
    KV: env.KV,
    // MCP lyrics tools don't need Spotify creds — stub the rest
    SPOTIFY_CLIENT_ID: "",
    SPOTIFY_CLIENT_SECRET: "",
    SHORTCUT_TOKEN: "",
    RESEND_API_KEY: "",
    NOTIFICATION_EMAIL: "",
    SPOTIFY_USER_ID: "",
    ACCESS_ALLOWED_EMAIL: "",
    ACCESS_TEAM_NAME: "",
    ACCESS_AUD: "",
    VOYAGE_API_KEY: "test-key-unused",
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("lyrics MCP tools", () => {
  beforeAll(async () => {
    await seedTestData(env.DB);
  });

  // ── explain_song ──

  describe("explain_song", () => {
    it("returns analysis for an analyzed track", async () => {
      const result = (await callTool("explain_song", { uri: URIS.analyzed }, testEnv())) as Record<string, unknown>;
      expect(result.source).toBe("local-history-derived");
      expect(result.subject_paragraph).toBe("A song about leaving home and finding yourself.");
      expect(result.tones).toEqual(["wistful", "hopeful"]);
      expect(result.language).toBe("en");
      expect(result.narrative).toEqual(expect.objectContaining({ pov: "first-person" }));
      expect(result.lyric_intrusion).toBe(0.4);
    });

    it("returns pending and creates status row for unknown track", async () => {
      const result = (await callTool("explain_song", { uri: URIS.unanalyzed }, testEnv())) as Record<string, unknown>;
      expect(result.source).toBe("local-history-derived");
      expect(result.status).toBe("pending");
      expect(result.message).toContain("10 minutes");

      // Verify status row was created
      const row = await env.DB.prepare(
        "SELECT status, attempts FROM track_lyric_analysis_status WHERE spotify_track_uri = ?",
      ).bind(URIS.unanalyzed).first<{ status: string; attempts: number }>();
      expect(row?.status).toBe("pending");
      expect(row?.attempts).toBe(0);
    });

    it("returns pending for a track with non-ok status", async () => {
      // Insert a 'parse_error' status
      await env.DB.prepare(
        "INSERT OR IGNORE INTO track_lyric_analysis_status (spotify_track_uri, status, last_attempted_at, attempts) VALUES (?, 'parse_error', 1000, 2)",
      ).bind("spotify:track:errored").run();

      const result = (await callTool("explain_song", { uri: "spotify:track:errored" }, testEnv())) as Record<string, unknown>;
      expect(result.status).toBe("pending");
      // Should NOT overwrite the existing parse_error row (INSERT OR IGNORE)
      const row = await env.DB.prepare(
        "SELECT status FROM track_lyric_analysis_status WHERE spotify_track_uri = ?",
      ).bind("spotify:track:errored").first<{ status: string }>();
      expect(row?.status).toBe("parse_error");
    });
  });

  // ── find_similar_lyrics ──

  describe("find_similar_lyrics", () => {
    it("returns twins ranked by similarity", async () => {
      const result = (await callTool("find_similar_lyrics", { seed_uri: URIS.analyzed, count: 3 }, testEnv())) as Record<string, unknown>;
      expect(result.source).toBe("local-history-derived");
      expect(result.seed_uri).toBe(URIS.analyzed);

      const twins = result.twins as Array<{ uri: string; similarity: number; track_name: string; artist_name: string }>;
      expect(twins).toHaveLength(3);

      // Close vectors should rank above the far vector
      expect(twins[0].uri).toBe(URIS.twin1);
      expect(twins[1].uri).toBe(URIS.twin2);
      expect(twins[2].uri).toBe(URIS.twinFar);

      // Closest twin should have higher similarity than the far one
      expect(twins[0].similarity).toBeGreaterThan(twins[2].similarity);

      // Metadata comes from track_lyrics
      expect(twins[0].track_name).toBe("Road Trip");
      expect(twins[0].artist_name).toBe("Highway Band");
    });

    it("includes subject_paragraph from analysis when available", async () => {
      const result = (await callTool("find_similar_lyrics", { seed_uri: URIS.analyzed, count: 1 }, testEnv())) as Record<string, unknown>;
      const twins = result.twins as Array<{ subject_paragraph: string | null }>;
      expect(twins[0].subject_paragraph).toBe("A road trip song.");
    });

    it("returns pending for a track with no embedding", async () => {
      const result = (await callTool("find_similar_lyrics", { seed_uri: "spotify:track:noembedding" }, testEnv())) as Record<string, unknown>;
      expect(result.status).toBe("pending");
    });

    it("respects count parameter", async () => {
      const result = (await callTool("find_similar_lyrics", { seed_uri: URIS.analyzed, count: 1 }, testEnv())) as Record<string, unknown>;
      const twins = result.twins as Array<unknown>;
      expect(twins).toHaveLength(1);
    });
  });

  // ── lyric_search ──

  describe("lyric_search", () => {
    it("returns error when VOYAGE_API_KEY is missing", async () => {
      const noKeyEnv = { ...testEnv(), VOYAGE_API_KEY: undefined };
      const result = (await callTool("lyric_search", { query: "test" }, noKeyEnv)) as Record<string, unknown>;
      expect(result.error).toContain("VOYAGE_API_KEY");
    });
  });
});
