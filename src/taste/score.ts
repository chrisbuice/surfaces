/**
 * score.ts — compute taste_score for a track.
 *
 * Weighted sum of signals. Higher = the user likes this track more.
 * Weights are tunable — these are starting defaults.
 */

export interface TrackSignals {
  inLikedSongs: boolean;
  inTopTracksShort: boolean;
  inTopTracksMedium: boolean;
  inTopTracksLong: boolean;
  seasonalPlaylistCount: number;
  currentSeasonPresent: boolean;
  playCount: number;
  skipCount: number;
  completeCount: number;
  replayCount: number;
  lastPlayedAt: number | null; // unix seconds
  artistTasteScore: number;    // from artist_taste, 0 if unknown
}

const WEIGHTS = {
  liked: 3,
  topShort: 5,
  topMedium: 3,
  topLong: 2,
  seasonalPerPlaylist: 1.5,
  currentSeason: 3,
  playCountBase: 0.5,     // per play, diminishing
  skipPenalty: -1.5,      // per skip
  completionBonus: 0.3,   // per completion
  replayBonus: 2,         // per replay — strongest positive signal
  recencyBonus: 2,        // decays over time
  artistBoost: 0.3,       // fraction of artist score added
};

export function computeTasteScore(signals: TrackSignals): number {
  let score = 0;

  // Library presence
  if (signals.inLikedSongs) score += WEIGHTS.liked;
  if (signals.inTopTracksShort) score += WEIGHTS.topShort;
  if (signals.inTopTracksMedium) score += WEIGHTS.topMedium;
  if (signals.inTopTracksLong) score += WEIGHTS.topLong;

  // Seasonal playlists
  score += signals.seasonalPlaylistCount * WEIGHTS.seasonalPerPlaylist;
  if (signals.currentSeasonPresent) score += WEIGHTS.currentSeason;

  // Play history (diminishing returns on play count)
  if (signals.playCount > 0) {
    score += Math.log2(1 + signals.playCount) * WEIGHTS.playCountBase;
  }
  score += signals.skipCount * WEIGHTS.skipPenalty;
  score += signals.completeCount * WEIGHTS.completionBonus;
  score += signals.replayCount * WEIGHTS.replayBonus;

  // Recency: bonus decays over 30 days
  if (signals.lastPlayedAt) {
    const daysSincePlay = (Date.now() / 1000 - signals.lastPlayedAt) / 86400;
    if (daysSincePlay < 30) {
      score += WEIGHTS.recencyBonus * (1 - daysSincePlay / 30);
    }
  }

  // Artist boost
  score += signals.artistTasteScore * WEIGHTS.artistBoost;

  return Math.round(score * 100) / 100;
}

/** Compute artist taste score from signals */
export function computeArtistTasteScore(signals: {
  inTopShort: boolean;
  inTopMedium: boolean;
  inTopLong: boolean;
  isFollowed: boolean;
  totalPlays: number;
  uniqueTracksPlayed: number;
}): number {
  let score = 0;

  if (signals.inTopShort) score += 5;
  if (signals.inTopMedium) score += 3;
  if (signals.inTopLong) score += 2;
  if (signals.isFollowed) score += 2;

  if (signals.totalPlays > 0) {
    score += Math.log2(1 + signals.totalPlays) * 0.5;
  }
  score += Math.min(signals.uniqueTracksPlayed, 10) * 0.3;

  return Math.round(score * 100) / 100;
}
