/**
 * types.ts — shared types for the listening-history layer.
 */

export interface PlayRow {
  id: number;
  ts: number;
  platform: string;
  ms_played: number;
  conn_country: string;
  track_name: string;
  artist_name: string;
  album_name: string;
  spotify_track_uri: string;
  reason_start: string;
  reason_end: string;
  shuffle: number;
  offline: number;
  year: number;
  month: number;
  hour: number;
  local_hour: number;
  minutes: number;
}

export interface GeoResult {
  city: string;
  region: string;
  country: string;
  lat: number;
  lon: number;
}

export type IpGeoCache = Record<string, GeoResult>;

export interface TimeMachineResult {
  period: string;
  totalPlays: number;
  totalHours: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topTracks: { track: string; artist: string; plays: number; minutes: number }[];
  topArtists: { artist: string; plays: number; minutes: number }[];
  era: string | null;
  vibe: string | null;
}

export interface LostFavorite {
  track: string;
  artist: string;
  uri: string;
  lifetimePlays: number;
  lastPlayed: string;
  peakMonth: string;
  peakPlays: number;
  era: string | null;
}

export interface AffinityRow {
  name: string;
  uri?: string;
  plays: number;
  affinity: number;
  lastPlayed: string;
}

export interface QueueCandidate {
  uri: string;
  track: string;
  artist: string;
  reason: string;
  affinityScore: number;
  isNeverStaleCore: boolean;
}

export interface QueueResult {
  source: string;
  mode: string;
  targetMinutes: number;
  actualMinutes: number;
  trackCount: number;
  tracks: QueueCandidate[];
  excluded: { skipPenalized: number; reason: string };
}
