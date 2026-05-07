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
  reflection: string | null;
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
  reflection: string | null;
}

export interface AffinityRow {
  name: string;
  uri?: string;
  plays: number;
  affinity: number;
  lastPlayed: string;
}

export interface OnThisDayTrack {
  track: string;
  artist: string;
  uri: string;
  totalPlays: number;
  peakYear: number;
  peakYearPlays: number;
  yearsPlayed: number[];
}

export interface OnThisDayResult {
  source: "local_history";
  date: string;
  yearsCovered: number[];
  totalPlaysAcrossYears: number;
  totalHoursAcrossYears: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topTracks: OnThisDayTrack[];
}

export interface DateRangeTrack {
  track: string;
  artist: string;
  uri: string;          // canonical (most-played) URI for the song in the range
  plays: number;
  minutes: number;
}

export interface DateRangeArtist {
  artist: string;
  plays: number;
  minutes: number;
}

export interface DateRangeDay {
  date: string;         // YYYY-MM-DD (Eastern)
  plays: number;
  minutes: number;
  topTrack: { track: string; artist: string; plays: number } | null;
}

export interface DateRangeResult {
  source: "local_history";
  startDate: string;          // requested start, echoed back as YYYY-MM-DD
  endDate: string;            // requested end, echoed back
  effectiveStartDate: string; // after clamping to dataset bounds
  effectiveEndDate: string;
  daysInRange: number;        // inclusive count of days in effective range
  daysWithPlays: number;
  totalPlays: number;
  totalMinutes: number;
  uniqueTracks: number;
  uniqueArtists: number;
  topTracks: DateRangeTrack[];
  topArtists: DateRangeArtist[];
  daily: DateRangeDay[];      // one entry per day in effective range, including zero-play days
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
