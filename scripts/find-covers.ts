#!/usr/bin/env npx tsx
/**
 * find-covers.ts — Cover & Alternate-Version Discovery pipeline.
 *
 * Implements PLAN_COVERS_2.md §3:
 *   Path A (MB work expansion) + Path B (Spotify title search)
 *   → lyric gate (Jaccard 5-shingle ≥ 0.05)
 *   → audio bucket assignment (uniform euclidean, threshold 0.7)
 *   → write to composition_versions + composition_seeds
 *
 * Usage:
 *   npx tsx scripts/find-covers.ts spotify:track:356VrVrkCQomaYAoUVPf5E
 *   npx tsx scripts/find-covers.ts --top 20
 *   npx tsx scripts/find-covers.ts --uri spotify:track:... --uri spotify:track:...
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync, appendFileSync } from "fs";
import { join, resolve } from "path";
import { LrclibClient } from "../src/lyrics/lrclib";
import { MusicBrainzClient } from "../src/credits/musicbrainz";
import { getSpotifyAccessToken } from "./lib/spotify-token";

// Load env from lyrics-backfill .env if available (grimmauldplace), else try scripts/experiment/.env
for (const envPath of [
  resolve(process.env.HOME ?? "", "stack/lyrics-backfill/.env"),
  resolve(__dirname, "..", "scripts", "experiment", ".env"),
]) {
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = val;
    }
    break;
  } catch { /* try next */ }
}

const DB_NAME = "spotify-agent-db";
const LRCLIB_BASE = "https://lrclib.net";
const RECCOBEATS_BASE = "https://api.reccobeats.com";
const MB_BASE = "https://musicbrainz.org/ws/2";
const MB_USER_AGENT = "Surfaces/0.1 ( https://www.github.com/chrisbuice/surfaces )";

const JACCARD_THRESHOLD = 0.05;
const AUDIO_BUCKET_THRESHOLD = 0.7;
const SPOTIFY_SEARCH_LIMIT = 10; // Spotify Dev Mode caps at 10 per page
const SPOTIFY_SEARCH_PAGES = 3;  // Paginate to get ~30 candidates

// Rejection log for threshold-robustness check (Step 3 gate)
let rejectionsFile: string | null = null;

// --- DB helpers ---
// Uses D1 REST API directly (works without wrangler) or wrangler as fallback

const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const USE_D1_REST = !!(CF_API_TOKEN && CF_ACCOUNT_ID && CF_D1_DATABASE_ID);

async function d1Query<T>(sql: string, params?: (string | number | null)[]): Promise<T[]> {
  if (USE_D1_REST) {
    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify(params ? { sql, params } : { sql }),
      }
    );
    const result = await resp.json() as any;
    if (!result.success || !result.result?.[0]) {
      console.error("D1 REST error:", JSON.stringify(result.errors ?? result).slice(0, 200));
      return [];
    }
    return result.result[0].results as T[];
  }

  // Fallback: wrangler
  const raw = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command="${sql.replace(/"/g, '\\"')}" 2>/dev/null`,
    { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
  );
  const parsed = JSON.parse(raw);
  return (parsed[0]?.results ?? []) as T[];
}

async function d1Write(sql: string): Promise<void> {
  if (USE_D1_REST) {
    // Split by semicolons and execute each statement
    const statements = sql.split(";").map(s => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      await d1Query(stmt);
    }
    return;
  }

  // Fallback: wrangler --file
  const tmpFile = join(__dirname, "..", ".tmp-covers.sql");
  writeFileSync(tmpFile, sql);
  try {
    execSync(
      `npx wrangler d1 execute ${DB_NAME} --file=${tmpFile} --remote 2>/dev/null`,
      { encoding: "utf-8", maxBuffer: 50 * 1024 * 1024 },
    );
  } finally {
    if (existsSync(tmpFile)) unlinkSync(tmpFile);
  }
}

function esc(val: string): string {
  return val.replace(/'/g, "''");
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// --- Lyric helpers (from spike) ---

function normalizeLyrics(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/\[.*?\]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function wordShingles(text: string, n: number): Set<string> {
  const words = text.split(" ");
  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(" "));
  }
  return shingles;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// --- Audio helpers ---

interface AudioFeatures {
  acousticness: number;
  danceability: number;
  energy: number;
  instrumentalness: number;
  liveness: number;
  loudness: number;
  speechiness: number;
  tempo: number;
  valence: number;
}

const FEATURE_NAMES: (keyof AudioFeatures)[] = [
  "acousticness", "danceability", "energy", "instrumentalness",
  "liveness", "loudness", "speechiness", "tempo", "valence",
];

function normalizeFeature(name: keyof AudioFeatures, value: number): number {
  if (name === "tempo") return Math.min(1, Math.max(0, value / 250));
  if (name === "loudness") return Math.min(1, Math.max(0, (value + 60) / 60));
  return Math.min(1, Math.max(0, value));
}

function uniformEuclidean(a: AudioFeatures, b: AudioFeatures): number {
  let sum = 0;
  for (const name of FEATURE_NAMES) {
    const diff = normalizeFeature(name, a[name]) - normalizeFeature(name, b[name]);
    sum += diff * diff;
  }
  return Math.sqrt(sum);
}

function featureDeltas(a: AudioFeatures, b: AudioFeatures): Record<string, number> {
  const deltas: Record<string, number> = {};
  for (const name of FEATURE_NAMES) {
    deltas[name] = Math.round((normalizeFeature(name, b[name]) - normalizeFeature(name, a[name])) * 10000) / 10000;
  }
  return deltas;
}

async function fetchReccoBeats(trackIds: string[]): Promise<Map<string, AudioFeatures>> {
  const result = new Map<string, AudioFeatures>();
  for (let i = 0; i < trackIds.length; i += 40) {
    const chunk = trackIds.slice(i, i + 40);
    const resp = await fetch(`${RECCOBEATS_BASE}/v1/audio-features?ids=${chunk.join(",")}`);
    if (!resp.ok) {
      if (resp.status === 429) {
        console.log("    ReccoBeats rate limited, waiting 10s...");
        await sleep(10000);
        i -= 40; // retry
        continue;
      }
      console.warn(`    ReccoBeats error ${resp.status}`);
      continue;
    }
    const data = (await resp.json()) as { content: any[] };
    for (const item of data.content) {
      const tid = item.href.split("/").pop() ?? "";
      result.set(tid, {
        acousticness: item.acousticness, danceability: item.danceability,
        energy: item.energy, instrumentalness: item.instrumentalness,
        liveness: item.liveness, loudness: item.loudness,
        speechiness: item.speechiness, tempo: item.tempo, valence: item.valence,
      });
    }
  }
  return result;
}

// --- Title normalization ---

function normalizeTitle(title: string): string {
  return title
    .replace(/\s*\(.*?\)\s*/g, " ")   // strip parentheticals
    .replace(/\s*\[.*?\]\s*/g, " ")   // strip brackets
    .replace(/\s*-\s*(Remix|Live|Acoustic|Remaster(ed)?|\d{4}\s+Remaster(ed)?|Radio\s+Edit|Deluxe|Version|Edit|Mix|Session|feat\..*|ft\..*|featuring.*)\s*$/i, "")
    .replace(/\s*(feat\.|ft\.|featuring)\s+.*/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Spotify helpers ---

interface SpotifyTrack {
  uri: string;
  id: string;
  name: string;
  artists: Array<{ name: string }>;
  album: { name: string; release_date?: string };
  popularity?: number; // Removed in Spotify Dev Mode (Feb 2026)
  duration_ms: number;
}

// Mutable token wrapper for auto-refresh on 401
let currentToken = "";
const SPOTIFY_CLIENT_ID = "1a78c31c5d7c40f7811ebd6577fc3b6a";

async function refreshSpotifyToken(): Promise<string> {
  const refreshToken = process.env.SPOTIFY_REFRESH_TOKEN;
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

  if (!refreshToken || !clientSecret) {
    // Fall back to wrangler KV method (works on laptop)
    return getSpotifyAccessToken();
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });

  const resp = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${clientSecret}`).toString("base64")}`,
    },
    body,
  });

  if (!resp.ok) {
    throw new Error(`Spotify token refresh failed (${resp.status}): ${await resp.text()}`);
  }

  const data = (await resp.json()) as { access_token: string; refresh_token?: string; expires_in: number };

  // Update the refresh token env var if Spotify rotated it
  if (data.refresh_token) {
    process.env.SPOTIFY_REFRESH_TOKEN = data.refresh_token;
  }

  console.log(`    Token refreshed (expires in ${data.expires_in}s)`);
  return data.access_token;
}

async function spotifyGet<T>(path: string, token: string): Promise<T> {
  const resp = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    if (resp.status === 401) {
      console.log("    Spotify token expired, refreshing...");
      currentToken = await refreshSpotifyToken();
      return spotifyGet(path, currentToken);
    }
    if (resp.status === 429) {
      const retryAfter = parseInt(resp.headers.get("Retry-After") ?? "5", 10);
      if (retryAfter > 60) {
        // Large Retry-After: write cooldown file and exit (see decisions_spotify_rate_limit.md R6)
        const { setSpotifyCooldown } = await import("./lib/spotify-rate-guard");
        setSpotifyCooldown(retryAfter, "find-covers");
        console.error(`Spotify 429 with Retry-After ${retryAfter}s — cooldown set, exiting`);
        process.exit(1);
      }
      console.log(`    Spotify rate limited, waiting ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      return spotifyGet(path, token);
    }
    throw new Error(`Spotify API ${resp.status}: ${await resp.text()}`);
  }
  return resp.json() as Promise<T>;
}

async function spotifySearch(query: string, token: string, limit: number = 10, offset: number = 0): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q: query, type: "track", limit: String(Math.min(limit, 10)), offset: String(offset) });
  const data = await spotifyGet<{ tracks: { items: SpotifyTrack[] } }>(`/search?${params}`, token);
  return data.tracks.items;
}

// --- MusicBrainz work expansion ---

let mbLastRequest = 0;

async function mbThrottle(): Promise<void> {
  const elapsed = Date.now() - mbLastRequest;
  if (elapsed < 1100) await sleep(1100 - elapsed);
  mbLastRequest = Date.now();
}

const MAX_PATH_A_RECORDINGS = 30; // Cap per-recording lookups for large works

interface MBRecording {
  id: string;
  title: string;
  artistCredit?: string;
  isrcs?: string[];
}

async function getWorkRecordings(workId: string): Promise<MBRecording[]> {
  // Step 1: Get recording IDs from work
  await mbThrottle();
  const resp = await fetch(`${MB_BASE}/work/${workId}?inc=recording-rels&fmt=json`, {
    headers: { "User-Agent": MB_USER_AGENT, Accept: "application/json" },
  });
  if (!resp.ok) {
    console.warn(`    MB work lookup failed: ${resp.status}`);
    return [];
  }

  const data = await resp.json() as any;
  const recordingIds: Array<{ id: string; title: string }> = [];

  for (const rel of data.relations ?? []) {
    if (rel.type === "performance" && rel.recording) {
      recordingIds.push({ id: rel.recording.id, title: rel.recording.title });
    }
  }

  if (recordingIds.length === 0) return [];

  // Step 2: Fetch ISRCs and artist credits for each recording (capped)
  const toFetch = recordingIds.slice(0, MAX_PATH_A_RECORDINGS);
  if (recordingIds.length > MAX_PATH_A_RECORDINGS) {
    console.log(`    Capping at ${MAX_PATH_A_RECORDINGS} of ${recordingIds.length} recordings`);
  }

  const recordings: MBRecording[] = [];
  for (const { id, title } of toFetch) {
    await mbThrottle();
    try {
      const recResp = await fetch(`${MB_BASE}/recording/${id}?inc=isrcs+artist-credits&fmt=json`, {
        headers: { "User-Agent": MB_USER_AGENT, Accept: "application/json" },
      });
      if (!recResp.ok) continue;

      const recData = await recResp.json() as any;
      const artistCredit = recData["artist-credit"]
        ?.map((ac: any) => ac.name || ac.artist?.name)
        .filter(Boolean)
        .join(", ") ?? null;
      recordings.push({
        id,
        title: recData.title ?? title,
        artistCredit,
        isrcs: recData.isrcs ?? [],
      });
    } catch { /* skip individual recording failures */ }
  }

  return recordings;
}

async function resolveRecordingToSpotify(
  rec: MBRecording,
  token: string,
): Promise<SpotifyTrack | null> {
  // Try ISRC first
  if (rec.isrcs && rec.isrcs.length > 0) {
    for (const isrc of rec.isrcs) {
      try {
        const results = await spotifySearch(`isrc:${isrc}`, token, 1);
        if (results.length > 0) return results[0];
      } catch { /* continue */ }
      await sleep(100);
    }
  }

  // Fall back to fuzzy search
  const artistName = rec.artistCredit ?? "";
  if (!artistName) return null;

  try {
    const results = await spotifySearch(
      `track:"${rec.title}" artist:"${artistName}"`,
      token,
      3,
    );
    // Take first result that has a reasonable title match
    const normRecTitle = rec.title.toLowerCase().replace(/[^\w\s]/g, "").trim();
    for (const r of results) {
      const normSpTitle = r.name.toLowerCase().replace(/[^\w\s]/g, "").trim();
      if (normSpTitle.includes(normRecTitle) || normRecTitle.includes(normSpTitle)) {
        return r;
      }
    }
  } catch { /* continue */ }

  return null;
}

// --- Shared writers lookup ---

async function getSharedWriters(seedUri: string, candidateUri: string): Promise<string[] | null> {
  try {
    const writers = await d1Query<{ person_name: string }>(
      `SELECT DISTINCT c1.person_name FROM track_credits c1 INNER JOIN track_credits c2 ON c1.person_name = c2.person_name WHERE c1.spotify_track_uri = '${esc(seedUri)}' AND c2.spotify_track_uri = '${esc(candidateUri)}' AND c1.role IN ('composer','lyricist','writer') AND c2.role IN ('composer','lyricist','writer')`
    );
    return writers.length > 0 ? writers.map(w => w.person_name) : null;
  } catch {
    return null;
  }
}

// --- Main pipeline ---

interface Candidate {
  spotifyTrack: SpotifyTrack;
  matchMethod: string; // legacy text field
  mbWorkId?: string;
  foundViaMbWork?: boolean;
  foundViaSpotifySearch?: boolean;
  foundViaArtistSearch?: boolean;
}

interface SeedInfo {
  uri: string;
  trackName: string;
  artistName: string;
  albumName: string | null;
  lyrics: string | null;
  normalizedLyrics: string | null;
  shingles: Set<string> | null;
  audioFeatures: AudioFeatures | null;
  mbWorkId: string | null;
}

async function getSeedInfo(uri: string, token: string): Promise<SeedInfo> {
  const trackId = uri.replace("spotify:track:", "");

  // Get track metadata from plays
  const playRow = await d1Query<{
    track_name: string; artist_name: string; album_name: string | null;
  }>(`SELECT track_name, artist_name, album_name FROM plays WHERE spotify_track_uri = '${esc(uri)}' LIMIT 1`);

  let trackName: string, artistName: string, albumName: string | null;

  if (playRow.length > 0) {
    trackName = playRow[0].track_name;
    artistName = playRow[0].artist_name;
    albumName = playRow[0].album_name;
  } else {
    // Not in library — fetch from Spotify
    const track = await spotifyGet<SpotifyTrack>(`/tracks/${trackId}`, token);
    trackName = track.name;
    artistName = track.artists.map(a => a.name).join(", ");
    albumName = track.album.name;
  }

  // Get lyrics
  const lyricsRow = await d1Query<{ lyrics_plain: string }>(
    `SELECT lyrics_plain FROM track_lyrics WHERE spotify_track_uri = '${esc(uri)}' AND status = 'ok'`
  );
  const lyrics = lyricsRow[0]?.lyrics_plain ?? null;
  const normalizedLyrics = lyrics ? normalizeLyrics(lyrics) : null;
  const shingles = normalizedLyrics ? wordShingles(normalizedLyrics, 5) : null;

  // Get audio features
  const audioRow = await d1Query<AudioFeatures>(
    `SELECT acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence FROM track_audio_features WHERE track_id = '${esc(trackId)}' AND acousticness IS NOT NULL`
  );
  let audioFeatures: AudioFeatures | null = audioRow[0] ?? null;

  // If not in DB, try ReccoBeats directly
  if (!audioFeatures) {
    const rbMap = await fetchReccoBeats([trackId]);
    audioFeatures = rbMap.get(trackId) ?? null;
  }

  // Get MB work ID
  const mbRow = await d1Query<{ mb_work_id: string }>(
    `SELECT mb_work_id FROM track_credits_status WHERE spotify_track_uri = '${esc(uri)}' AND mb_work_id IS NOT NULL`
  );
  const mbWorkId = mbRow[0]?.mb_work_id ?? null;

  return { uri, trackName, artistName, albumName, lyrics, normalizedLyrics, shingles, audioFeatures, mbWorkId };
}

async function findCoversForSeed(seed: SeedInfo, token: string, source: string): Promise<void> {
  console.log(`\n${"=".repeat(70)}`);
  console.log(`Seed: ${seed.artistName} — "${seed.trackName}"`);
  console.log(`URI: ${seed.uri}`);
  console.log(`Lyrics: ${seed.lyrics ? `${seed.lyrics.length} chars` : "MISSING"}`);
  console.log(`Audio: ${seed.audioFeatures ? "yes" : "no"}`);
  console.log(`MB work: ${seed.mbWorkId ?? "none"}`);

  if (!seed.shingles) {
    console.log("⚠️  No lyrics for seed — cannot run lyric gate. Skipping.");
    writeSeedRecord(seed.uri, "both", 0, 0, 0, source);
    return;
  }

  // --- Candidate generation ---
  const candidateMap = new Map<string, Candidate>(); // keyed by spotify URI

  // Path A: MB work expansion
  let pathAMethod = "spotify_only";
  if (seed.mbWorkId) {
    console.log(`\nPath A: MB work expansion (work ${seed.mbWorkId})...`);
    try {
      const recordings = await getWorkRecordings(seed.mbWorkId);
      console.log(`  Found ${recordings.length} linked recordings`);
      pathAMethod = "both";

      let resolved = 0;
      for (const rec of recordings) {
        try {
          const spotifyTrack = await resolveRecordingToSpotify(rec, token);
          if (spotifyTrack && spotifyTrack.uri !== seed.uri) {
            if (candidateMap.has(spotifyTrack.uri)) {
              candidateMap.get(spotifyTrack.uri)!.foundViaMbWork = true;
            } else {
              candidateMap.set(spotifyTrack.uri, {
                spotifyTrack,
                matchMethod: "mb_work",
                mbWorkId: seed.mbWorkId!,
                foundViaMbWork: true,
              });
              resolved++;
            }
          }
        } catch { /* skip individual recording resolution failures */ }
        await sleep(100);
      }
      console.log(`  Resolved ${resolved} to Spotify URIs`);
    } catch (err) {
      console.log(`  ⚠️  MB API unreachable: ${(err as Error).message}. Falling back to Path B only.`);
      pathAMethod = "spotify_only";
    }
  } else {
    console.log("\nPath A: skipped (no MB work ID)");
  }

  // Path B: Spotify title search (paginated — Dev Mode limits to 10 per page)
  const baseTitle = normalizeTitle(seed.trackName);
  console.log(`\nPath B: Spotify search for "${baseTitle}" (${SPOTIFY_SEARCH_PAGES} pages)...`);
  let pathBAdded = 0;

  for (let page = 0; page < SPOTIFY_SEARCH_PAGES; page++) {
    const offset = page * SPOTIFY_SEARCH_LIMIT;
    try {
      const searchResults = await spotifySearch(
        `track:"${baseTitle}"`, token, SPOTIFY_SEARCH_LIMIT, offset
      );
      if (searchResults.length === 0) break; // no more results

      for (const track of searchResults) {
        if (track.uri === seed.uri) continue;

        // Drop same-artist tracks unless title differs
        const seedArtist = seed.artistName.toLowerCase();
        const candArtist = track.artists.map(a => a.name).join(", ").toLowerCase();
        const seedBaseTitle = baseTitle.toLowerCase();
        const candBaseTitle = normalizeTitle(track.name).toLowerCase();
        if (candArtist === seedArtist && candBaseTitle === seedBaseTitle) continue;

        if (candidateMap.has(track.uri)) {
          candidateMap.get(track.uri)!.foundViaSpotifySearch = true;
        } else {
          candidateMap.set(track.uri, {
            spotifyTrack: track,
            matchMethod: "spotify_search",
            foundViaSpotifySearch: true,
          });
          pathBAdded++;
        }
      }
    } catch (err) {
      console.log(`    Page ${page + 1} error: ${(err as Error).message}`);
      break;
    }
    await sleep(100);
  }
  console.log(`  Added ${pathBAdded} candidates from Spotify search (${candidateMap.size} total)`);

  // Path C: Same-artist title search (targets orphaned same-artist remixes/live/acoustic)
  console.log(`\nPath C: Spotify artist search for "${baseTitle}" by "${seed.artistName}"...`);
  let pathCAdded = 0;
  try {
    const artistResults = await spotifySearch(
      `track:"${baseTitle}" artist:"${seed.artistName}"`, currentToken, 10
    );
    for (const track of artistResults) {
      if (track.uri === seed.uri) continue;

      // Drop same-title re-releases (no markers = just another album release of the seed)
      const candNormTitle = normalizeTitle(track.name).toLowerCase();
      const seedNormTitle = baseTitle.toLowerCase();
      if (candNormTitle === seedNormTitle) {
        // Check if original title has markers that suggest it's an alternate version
        const hasMarker = /\b(remix|live|acoustic|demo|version|edit|mix|session|remaster|radio|medley)\b/i.test(track.name);
        if (!hasMarker) continue; // plain re-release, skip
      }

      if (candidateMap.has(track.uri)) {
        // Already found by another path — mark as found by multiple
        const existing = candidateMap.get(track.uri)!;
        if (!existing.foundViaArtistSearch) existing.foundViaArtistSearch = true;
      } else {
        candidateMap.set(track.uri, {
          spotifyTrack: track,
          matchMethod: "spotify_artist_search",
          foundViaArtistSearch: true,
        });
        pathCAdded++;
      }
    }
  } catch (err) {
    console.log(`  ⚠️  Path C error: ${(err as Error).message}`);
  }
  console.log(`  Added ${pathCAdded} candidates from artist search (${candidateMap.size} total)`);

  // --- Lyric gate ---
  console.log(`\nLyric gate (Jaccard 5-shingle ≥ ${JACCARD_THRESHOLD})...`);
  const lrclibClient = new LrclibClient();
  const survivors: Array<{
    candidate: Candidate;
    jaccardScore: number;
    candidateLyrics: string;
  }> = [];

  let gatePass = 0, gateFail = 0, gateNoLyrics = 0;

  for (const [, candidate] of candidateMap) {
    const track = candidate.spotifyTrack;

    // Try DB first
    const lyricsRow = await d1Query<{ lyrics_plain: string }>(
      `SELECT lyrics_plain FROM track_lyrics WHERE spotify_track_uri = '${esc(track.uri)}' AND status = 'ok'`
    );
    let candidateLyrics = lyricsRow[0]?.lyrics_plain ?? null;

    // Fall back to LRCLIB
    if (!candidateLyrics) {
      try {
        const result = await lrclibClient.fetchLyrics({
          trackName: track.name,
          artistName: track.artists[0]?.name ?? "",
          durationMs: track.duration_ms,
        });
        candidateLyrics = result?.plainLyrics ?? null;
      } catch {
        // LRCLIB fetch error — treat as no lyrics
        gateNoLyrics++;
        continue;
      }
    }

    if (!candidateLyrics) {
      gateNoLyrics++;
      continue;
    }

    const normalized = normalizeLyrics(candidateLyrics);
    const candShingles = wordShingles(normalized, 5);
    const score = jaccard(seed.shingles!, candShingles);

    if (score >= JACCARD_THRESHOLD) {
      survivors.push({ candidate, jaccardScore: score, candidateLyrics });
      gatePass++;
    } else {
      gateFail++;
      // Log rejection for threshold-robustness check
      if (rejectionsFile) {
        const rejection = JSON.stringify({
          seed_uri: seed.uri, seed_name: `${seed.artistName} — ${seed.trackName}`,
          candidate_uri: track.uri, candidate_name: `${track.artists[0]?.name} — ${track.name}`,
          jaccard: Math.round(score * 10000) / 10000,
        });
        appendFileSync(rejectionsFile, rejection + "\n");
      }
    }
  }

  console.log(`  Pass: ${gatePass}, Fail: ${gateFail}, No lyrics: ${gateNoLyrics}`);

  if (survivors.length === 0) {
    console.log("  No candidates survived the lyric gate.");
    writeSeedRecord(seed.uri, pathAMethod, candidateMap.size, 0, 0, source);
    return;
  }

  // --- Audio bucket assignment ---
  console.log(`\nAudio bucket assignment (threshold ${AUDIO_BUCKET_THRESHOLD})...`);

  // Fetch audio features for all survivors
  const candidateIds = survivors.map(s => s.candidate.spotifyTrack.id);
  const audioMap = await fetchReccoBeats(candidateIds);

  // Also check DB for any we already have
  for (const s of survivors) {
    const tid = s.candidate.spotifyTrack.id;
    if (!audioMap.has(tid)) {
      const audioRow = await d1Query<AudioFeatures>(
        `SELECT acousticness, danceability, energy, instrumentalness, liveness, loudness, speechiness, tempo, valence FROM track_audio_features WHERE track_id = '${esc(tid)}' AND acousticness IS NOT NULL`
      );
      if (audioRow[0]) audioMap.set(tid, audioRow[0]);
    }
  }

  // Check in_library
  const inLibrarySet = new Set<string>();
  if (survivors.length > 0) {
    // Batch check: does this candidate URI appear in plays?
    for (let i = 0; i < survivors.length; i += 15) {
      const batch = survivors.slice(i, i + 15).map(s => `'${esc(s.candidate.spotifyTrack.uri)}'`);
      const rows = await d1Query<{ spotify_track_uri: string }>(
        `SELECT DISTINCT spotify_track_uri FROM plays WHERE spotify_track_uri IN (${batch.join(",")})`
      );
      for (const r of rows) inLibrarySet.add(r.spotify_track_uri);
    }
  }

  // Write results
  console.log("\nResults:");
  let noAudioCount = 0;
  const sqlStatements: string[] = [];
  const now = Math.floor(Date.now() / 1000);

  for (const s of survivors) {
    const track = s.candidate.spotifyTrack;
    const tid = track.id;
    const candidateAudio = audioMap.get(tid) ?? null;
    const inLibrary = inLibrarySet.has(track.uri) ? 1 : 0;

    let audioDistance: number | null = null;
    let audioBucket: string;
    let noAudioData = 0;
    let deltasJson: string | null = null;

    if (candidateAudio && seed.audioFeatures) {
      audioDistance = Math.round(uniformEuclidean(seed.audioFeatures, candidateAudio) * 10000) / 10000;
      audioBucket = audioDistance >= AUDIO_BUCKET_THRESHOLD ? "different_sonic_world" : "alternate_version";
      deltasJson = JSON.stringify(featureDeltas(seed.audioFeatures, candidateAudio));
    } else {
      audioBucket = "alternate_version";
      noAudioData = 1;
      noAudioCount++;
    }

    // Shared writers
    const sharedWriters = await getSharedWriters(seed.uri, track.uri);
    const sharedWritersJson = sharedWriters ? JSON.stringify(sharedWriters) : null;

    const bucket = audioBucket === "different_sonic_world" ? "🔊 DIFFERENT" : "🎵 ALTERNATE";
    const distStr = audioDistance !== null ? audioDistance.toFixed(3) : "no-audio";
    const libStr = inLibrary ? "📚" : "";
    console.log(`  ${bucket} | ${distStr} | J=${s.jaccardScore.toFixed(3)} | ${track.artists[0]?.name} — "${track.name}" ${libStr}`);

    const popularity = track.popularity ?? null;
    const viaMb = s.candidate.foundViaMbWork ? 1 : 0;
    const viaSearch = s.candidate.foundViaSpotifySearch ? 1 : 0;
    const viaArtist = s.candidate.foundViaArtistSearch ? 1 : 0;
    const sql = `INSERT OR REPLACE INTO composition_versions (seed_track_uri, candidate_track_uri, candidate_track_name, candidate_artist_name, candidate_album_name, candidate_release_date, candidate_spotify_popularity, in_library, match_method, found_via_mb_work, found_via_spotify_search, found_via_spotify_artist_search, mb_work_id, lyric_jaccard, audio_distance, audio_bucket, no_audio_data, audio_feature_deltas_json, shared_writers_json, found_at) VALUES ('${esc(seed.uri)}', '${esc(track.uri)}', '${esc(track.name)}', '${esc(track.artists.map(a => a.name).join(", "))}', ${track.album?.name ? `'${esc(track.album.name)}'` : "NULL"}, ${track.album?.release_date ? `'${esc(track.album.release_date)}'` : "NULL"}, ${popularity !== null ? popularity : "NULL"}, ${inLibrary}, '${s.candidate.matchMethod}', ${viaMb}, ${viaSearch}, ${viaArtist}, ${s.candidate.mbWorkId ? `'${esc(s.candidate.mbWorkId)}'` : "NULL"}, ${Math.round(s.jaccardScore * 10000) / 10000}, ${audioDistance !== null ? audioDistance : "NULL"}, '${audioBucket}', ${noAudioData}, ${deltasJson ? `'${esc(deltasJson)}'` : "NULL"}, ${sharedWritersJson ? `'${esc(sharedWritersJson)}'` : "NULL"}, ${now});`;
    sqlStatements.push(sql);
  }

  // Write all in one batch
  if (sqlStatements.length > 0) {
    await d1Write(sqlStatements.join("\n"));
  }

  // Write seed record
  writeSeedRecord(
    seed.uri,
    pathAMethod,
    candidateMap.size,
    survivors.length,
    noAudioCount,
    source,
  );

  console.log(`\n  Summary: ${survivors.length} kept, ${noAudioCount} without audio data`);
}

async function writeSeedRecord(
  uri: string, method: string, found: number, kept: number, noAudio: number, source: string,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const sql = `INSERT OR REPLACE INTO composition_seeds (seed_track_uri, last_searched_at, search_method, candidates_found, candidates_kept, candidates_no_audio_data, source) VALUES ('${esc(uri)}', ${now}, '${method}', ${found}, ${kept}, ${noAudio}, '${source}');`;
  await d1Write(sql);
}

// --- CLI ---

async function main() {
  const args = process.argv.slice(2);
  const uris: string[] = [];
  let source = "manual";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--uri") {
      uris.push(args[++i]);
    } else if (args[i] === "--top") {
      const n = parseInt(args[++i], 10);
      source = "top_played_batch";
      console.log(`Querying top ${n} most-played tracks...`);
      const rows = await d1Query<{ spotify_track_uri: string; plays: number; track_name: string; artist_name: string }>(
        `SELECT spotify_track_uri, COUNT(*) as plays, track_name, artist_name FROM plays GROUP BY spotify_track_uri ORDER BY plays DESC LIMIT ${n}`
      );
      for (const r of rows) {
        // Skip seeds already processed
        const existing = await d1Query<{ seed_track_uri: string }>(
          `SELECT seed_track_uri FROM composition_seeds WHERE seed_track_uri = '${esc(r.spotify_track_uri)}'`
        );
        if (existing.length === 0) {
          uris.push(r.spotify_track_uri);
        } else {
          console.log(`  Skipping ${r.artist_name} — "${r.track_name}" (already processed)`);
        }
      }
      console.log(`${uris.length} seeds to process\n`);
    } else if (args[i].startsWith("spotify:track:")) {
      uris.push(args[i]);
    }
  }

  if (uris.length === 0) {
    console.log("Usage:");
    console.log("  npx tsx scripts/find-covers.ts spotify:track:...");
    console.log("  npx tsx scripts/find-covers.ts --uri spotify:track:... --uri spotify:track:...");
    console.log("  npx tsx scripts/find-covers.ts --top 20");
    process.exit(1);
  }

  console.log("=== Cover & Alternate-Version Discovery ===\n");
  console.log(`Processing ${uris.length} seed(s)...`);

  // Set up rejection logging for threshold-robustness gate check
  rejectionsFile = resolve(__dirname, "..", "rejections.jsonl");
  if (existsSync(rejectionsFile) && source === "top_played_batch") {
    unlinkSync(rejectionsFile); // fresh log for batch runs
  }

  if (process.env.SPOTIFY_TOKEN) {
    currentToken = process.env.SPOTIFY_TOKEN;
    console.log("Spotify token from env.\n");
  } else {
    currentToken = await getSpotifyAccessToken();
    console.log("Spotify token from KV.\n");
  }

  for (const uri of uris) {
    try {
      const seed = await getSeedInfo(uri, currentToken);
      await findCoversForSeed(seed, currentToken, source);
    } catch (err) {
      console.error(`\n❌ Error processing ${uri}: ${(err as Error).message}`);
    }
  }

  console.log("\n\n=== Done ===");
}

main().catch(err => {
  console.error("Fatal:", err);
  process.exit(1);
});
