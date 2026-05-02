/**
 * types.ts — JSON contract types for the constellation.
 *
 * The shape below is the interface between the Surfaces backend and
 * chrisbuice.com. See spec §6. Do not change without flagging — both
 * halves of the system depend on it.
 *
 * Coordinates are precomputed and absolute. The renderer does no
 * layout math; it just paints dots where the JSON says.
 */

export interface ConstellationStats {
  total_plays: number;
  total_artists: number;
  total_seasons: number;
  data_starts: string;            // ISO date, e.g. "2011-12-10"
}

export interface EraBucket {
  label: string;                  // "2011–2014"
  color: string;                  // "#c8956d"
}

export interface Viewbox {
  width: number;
  height: number;
}

export interface ConstellationNode {
  // Three id forms. The renderer keys click behavior off the prefix:
  //   "spotify:artist:<id>"  → opens the artist page on Spotify
  //   "name:<slug>"          → opens a Spotify artist-name search
  //   "ambiguous:<slug>"     → click is disabled (display name maps to
  //                            multiple distinct Spotify artists, so we
  //                            won't promise a destination we can't pick)
  id: string;
  name: string;
  x: number;                      // viewbox-space, absolute
  y: number;
  r: number;                      // pixels (3–24 desktop)
  opacity: number;                // 0.4–1.0
  era: number;                    // index into era_buckets
  plays: number;
  peak_year: number;
  years_active: number;
  top_neighbors: string[];        // up to 3, by edge weight
  is_labeled: boolean;
}

export interface ConstellationEdge {
  from: number;                   // index into nodes
  to: number;                     // index into nodes
  weight: number;                 // 0..1, normalized
}

export interface ConstellationJson {
  generated_at: string;           // ISO timestamp
  stats: ConstellationStats;
  era_buckets: EraBucket[];
  viewbox: Viewbox;
  nodes: ConstellationNode[];
  edges: ConstellationEdge[];
}

// ── Internal types ─────────────────────────────────────────
// These mirror DB row shapes used between query / layout / labels;
// they are not part of the public JSON contract.

export interface NodeRow {
  artist_name: string;
  // Three resolution states for the Spotify artist URI lookup against
  // artist_taste:
  //   { kind: "resolved", id }   — exactly one matching artist_taste row
  //   { kind: "ambiguous" }      — name appears with multiple distinct ids
  //   { kind: "unresolved" }     — name not in artist_taste at all
  artist_id: ArtistIdResolution;
  total_plays: number;
  peak_year: number;
  years_active: number;
}

export type ArtistIdResolution =
  | { kind: "resolved"; id: string }
  | { kind: "ambiguous" }
  | { kind: "unresolved" };

export interface EdgeRow {
  artist_a: string;                   // alphabetically first
  artist_b: string;
  session_co: number;
  playlist_co: number;                // weighted: seasonal counts as 1.5
  weight: number;                     // log(session) + 2 * log(playlist + 1)
}

export interface EraBoundary {
  start_year: number;
  end_year: number;
}
