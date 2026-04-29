/**
 * reccobeats.ts — ReccoBeats audio features client.
 *
 * Implements AudioFeaturesProvider so a second provider (SoundStat)
 * could be swapped in without changing callers.
 *
 * ReccoBeats API: https://api.reccobeats.com
 * - No authentication required
 * - Batch endpoint: GET /v1/audio-features?ids=id1,id2,...
 * - Returns { content: [...] } with tracks that have features;
 *   missing tracks are silently omitted from the array
 * - Rate limit: undisclosed, returns 429 with Retry-After header
 */

const RECCOBEATS_BASE = "https://api.reccobeats.com";

export interface AudioFeatures {
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

/** Provider-agnostic interface. ReccoBeats implements this; SoundStat could too. */
export interface AudioFeaturesProvider {
  fetchBatch(trackIds: string[]): Promise<Map<string, AudioFeatures>>;
}

interface ReccoBeatsItem {
  id: string;
  href: string;
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

export class ReccoBeatsProvider implements AudioFeaturesProvider {
  /**
   * Fetch audio features for a batch of Spotify track IDs.
   * Returns a Map keyed by track ID — tracks not in ReccoBeats'
   * database are simply absent from the map.
   */
  async fetchBatch(trackIds: string[]): Promise<Map<string, AudioFeatures>> {
    if (trackIds.length === 0) return new Map();

    const resp = await fetch(
      `${RECCOBEATS_BASE}/v1/audio-features?ids=${trackIds.join(",")}`,
    );

    if (!resp.ok) {
      if (resp.status === 429) {
        console.warn("ReccoBeats rate limited");
      }
      throw new Error(`ReccoBeats API error ${resp.status}`);
    }

    const data = (await resp.json()) as { content: ReccoBeatsItem[] };
    const result = new Map<string, AudioFeatures>();

    for (const item of data.content) {
      // Extract Spotify track ID from the href (https://open.spotify.com/track/{id})
      const trackId = item.href.split("/").pop() ?? "";
      if (!trackId) continue;

      result.set(trackId, {
        acousticness: item.acousticness,
        danceability: item.danceability,
        energy: item.energy,
        instrumentalness: item.instrumentalness,
        liveness: item.liveness,
        loudness: item.loudness,
        speechiness: item.speechiness,
        tempo: item.tempo,
        valence: item.valence,
      });
    }

    return result;
  }
}
