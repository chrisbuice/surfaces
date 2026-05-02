/**
 * musicbrainz.ts — MusicBrainz client for songwriter/producer credits.
 *
 * API: https://musicbrainz.org/ws/2
 * - No API key required
 * - Strict 1 req/sec rate limit (enforced internally)
 * - Custom User-Agent required (format: AppName/Version ( contact ))
 * - Two-step lookup: find recording by ISRC or search, then get work relations
 */

const MB_BASE = "https://musicbrainz.org/ws/2";
const USER_AGENT = "Surfaces/0.1 ( https://www.github.com/chrisbuice/surfaces )";
const MIN_SEARCH_SCORE = 90;

export interface MusicBrainzCredit {
  personName: string;
  role: "composer" | "lyricist" | "writer" | "producer" | "arranger" | "other";
  roleRaw: string;
  mbArtistId: string;
}

export interface MusicBrainzLookupResult {
  mbRecordingId: string | null;
  mbWorkId: string | null;
  credits: MusicBrainzCredit[];
  status: "ok" | "no_recording" | "no_work" | "error";
}

// Map MB relationship type strings to our enum
const ROLE_MAP: Record<string, MusicBrainzCredit["role"]> = {
  composer: "composer",
  lyricist: "lyricist",
  writer: "writer",
  producer: "producer",
  arranger: "arranger",
};

function mapRole(rawType: string): MusicBrainzCredit["role"] {
  return ROLE_MAP[rawType] ?? "other";
}

export class MusicBrainzClient {
  private lastRequestAt = 0;
  private minIntervalMs = 1100; // slightly over 1 req/sec for safety

  private async throttle(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestAt;
    if (elapsed < this.minIntervalMs) {
      await new Promise(r => setTimeout(r, this.minIntervalMs - elapsed));
    }
    this.lastRequestAt = Date.now();
  }

  private async mbFetch(path: string): Promise<Response> {
    await this.throttle();
    const resp = await fetch(`${MB_BASE}${path}`, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
    });
    return resp;
  }

  /**
   * Look up credits for a track. Uses ISRC if available, falls back to
   * name+artist search with score threshold.
   */
  async lookupCredits(args: {
    isrc?: string;
    trackName: string;
    artistName: string;
  }): Promise<MusicBrainzLookupResult> {
    // Step 1: Find the recording
    let recordingId: string | null = null;

    if (args.isrc) {
      recordingId = await this.findRecordingByIsrc(args.isrc);
    }

    if (!recordingId) {
      recordingId = await this.findRecordingBySearch(args.trackName, args.artistName);
    }

    if (!recordingId) {
      return { mbRecordingId: null, mbWorkId: null, credits: [], status: "no_recording" };
    }

    // Step 2: Get recording with work relations
    return this.getCreditsFromRecording(recordingId);
  }

  private async findRecordingByIsrc(isrc: string): Promise<string | null> {
    const resp = await this.mbFetch(`/isrc/${isrc}?fmt=json`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      recordings?: Array<{ id: string; title: string }>;
    };

    return data.recordings?.[0]?.id ?? null;
  }

  private async findRecordingBySearch(trackName: string, artistName: string): Promise<string | null> {
    const query = encodeURIComponent(`recording:"${trackName}" AND artist:"${artistName}"`);
    const resp = await this.mbFetch(`/recording?query=${query}&fmt=json&limit=3`);
    if (!resp.ok) return null;

    const data = (await resp.json()) as {
      recordings?: Array<{ id: string; score: number; title: string }>;
    };

    const top = data.recordings?.[0];
    if (!top || top.score < MIN_SEARCH_SCORE) return null;

    return top.id;
  }

  private async getCreditsFromRecording(recordingId: string): Promise<MusicBrainzLookupResult> {
    const resp = await this.mbFetch(
      `/recording/${recordingId}?inc=work-rels+work-level-rels+artist-rels&fmt=json`,
    );

    if (!resp.ok) {
      return { mbRecordingId: recordingId, mbWorkId: null, credits: [], status: "error" };
    }

    const data = (await resp.json()) as {
      id: string;
      relations?: Array<{
        type: string;
        "target-type": string;
        artist?: { id: string; name: string };
        work?: {
          id: string;
          relations?: Array<{
            type: string;
            "target-type": string;
            artist?: { id: string; name: string };
          }>;
        };
      }>;
    };

    const credits: MusicBrainzCredit[] = [];
    let workId: string | null = null;

    // Collect producer/arranger credits from recording-level relations
    for (const rel of data.relations ?? []) {
      if (rel["target-type"] === "artist" && rel.artist) {
        const role = mapRole(rel.type);
        if (role === "producer" || role === "arranger") {
          credits.push({
            personName: rel.artist.name,
            role,
            roleRaw: rel.type,
            mbArtistId: rel.artist.id,
          });
        }
      }

      // Find linked work and extract writer credits
      if (rel["target-type"] === "work" && rel.work) {
        workId = rel.work.id;
        for (const workRel of rel.work.relations ?? []) {
          if (workRel["target-type"] === "artist" && workRel.artist) {
            const role = mapRole(workRel.type);
            credits.push({
              personName: workRel.artist.name,
              role,
              roleRaw: workRel.type,
              mbArtistId: workRel.artist.id,
            });
          }
        }
      }
    }

    if (!workId && credits.length === 0) {
      return { mbRecordingId: recordingId, mbWorkId: null, credits: [], status: "no_work" };
    }

    return { mbRecordingId: recordingId, mbWorkId: workId, credits, status: "ok" };
  }
}
