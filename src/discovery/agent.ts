/**
 * agent.ts — the discovery agent cron job.
 *
 * Runs daily. Pulls candidates from all sources, scores them against
 * the taste model, inserts top scorers into fresh_pool, and expires
 * stale entries.
 *
 * The "Discovery Queue" Spotify playlist is deferred until the
 * playlist-write 403 in Dev Mode is resolved.
 */

import { SpotifyClient } from "../spotify/client";
import { pullAllCandidates, type DiscoveryCandidate } from "./sources";
import { addToFreshPool, expireStaleEntries } from "./pool";

const FRESH_POOL_TARGET = 50;

interface DiscoveryResult {
  candidatesFound: number;
  candidatesScored: number;
  addedToPool: number;
  expired: number;
}

export async function runDiscoveryAgent(
  db: D1Database,
  spotify: SpotifyClient
): Promise<DiscoveryResult & { debug?: string[] }> {
  const debug: string[] = [];

  // ── Pull candidates from all sources ──
  const candidates = await pullAllCandidates(spotify, debug);
  debug.push(`pullAllCandidates returned ${candidates.length} candidates`);

  // ── Filter out tracks the user already knows ──
  const knownTracks = new Set<string>();

  // Tracks already in track_taste
  const tasteRows = await db.prepare(
    "SELECT track_id FROM track_taste"
  ).all<{ track_id: string }>();
  for (const r of tasteRows.results) knownTracks.add(r.track_id);

  // Tracks already in play_events
  const playedRows = await db.prepare(
    "SELECT DISTINCT track_id FROM play_events"
  ).all<{ track_id: string }>();
  for (const r of playedRows.results) knownTracks.add(r.track_id);

  // Also load existing fresh pool track names to avoid name-level duplicates
  const poolNames = new Set<string>();
  const poolRows = await db.prepare(
    "SELECT track_name, primary_artist_id FROM fresh_pool WHERE status = 'fresh'"
  ).all<{ track_name: string; primary_artist_id: string }>();
  for (const r of poolRows.results) {
    poolNames.add(`${r.track_name.toLowerCase()}::${r.primary_artist_id}`);
  }

  debug.push(`knownTracks: ${knownTracks.size}`);
  const freshCandidates = candidates.filter(c => !knownTracks.has(c.trackId));

  // Deduplicate by name + primary artist (catches album vs single vs deluxe variants)
  const seenNames = new Set<string>();
  const dedupedCandidates = freshCandidates.filter(c => {
    const key = `${c.trackName.toLowerCase()}::${c.primaryArtistId}`;
    if (seenNames.has(key) || poolNames.has(key)) return false;
    seenNames.add(key);
    return true;
  });
  debug.push(`after filtering known: ${freshCandidates.length}, after name-dedup: ${dedupedCandidates.length}`);

  // ── Score each candidate against the taste model ──
  // Load artist taste scores for scoring
  const artistScores = new Map<string, number>();
  const artistRows = await db.prepare(
    "SELECT artist_id, taste_score FROM artist_taste"
  ).all<{ artist_id: string; taste_score: number }>();
  for (const r of artistRows.results) {
    artistScores.set(r.artist_id, r.taste_score);
  }

  // Load seasonal playlist artist presence
  const seasonalArtists = new Set<string>();
  const seasonalRows = await db.prepare(
    "SELECT DISTINCT primary_artist_id FROM track_taste WHERE seasonal_playlist_count > 0"
  ).all<{ primary_artist_id: string }>();
  for (const r of seasonalRows.results) seasonalArtists.add(r.primary_artist_id);

  const scored = dedupedCandidates.map(c => ({
    ...c,
    score: scoreCandidate(c, artistScores, seasonalArtists),
  }));

  // Sort by score descending, take top N
  scored.sort((a, b) => b.score - a.score);
  const topCandidates = scored.slice(0, FRESH_POOL_TARGET);

  // ── Insert into fresh pool ──
  let added = 0;
  for (const c of topCandidates) {
    if (c.score > 0) {
      const ok = await addToFreshPool(db, {
        trackId: c.trackId,
        trackName: c.trackName,
        artistIds: c.artistIds,
        primaryArtistId: c.primaryArtistId,
        source: c.source,
        sourceDetail: c.sourceDetail,
        tasteScore: c.score,
      });
      if (ok) added++;
    }
  }

  // ── Expire stale entries ──
  const expired = await expireStaleEntries(db);

  return {
    debug,
    candidatesFound: candidates.length,
    candidatesScored: dedupedCandidates.length,
    addedToPool: added,
    expired,
  };
}

/** Score a discovery candidate against the taste model */
function scoreCandidate(
  candidate: DiscoveryCandidate,
  artistScores: Map<string, number>,
  seasonalArtists: Set<string>
): number {
  let score = 0;

  // Primary artist taste score (strongest signal)
  const primaryScore = artistScores.get(candidate.primaryArtistId);
  if (primaryScore !== undefined) {
    score += primaryScore * 0.6;
  }

  // Collaborator artist scores
  for (const artistId of candidate.artistIds) {
    if (artistId === candidate.primaryArtistId) continue;
    const collabScore = artistScores.get(artistId);
    if (collabScore !== undefined) {
      score += collabScore * 0.2;
    }
  }

  // Bonus if artist appears in seasonal playlists
  if (seasonalArtists.has(candidate.primaryArtistId)) {
    score += 2;
  }

  // Source bonus: followed artist releases get a boost
  if (candidate.source === "followed_artist_release") {
    score += 1.5;
  }

  return Math.round(score * 100) / 100;
}
