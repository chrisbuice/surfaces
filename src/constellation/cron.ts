/**
 * cron.ts — nightly constellation rebuild.
 *
 * Runs once per night per spec §7.1. Steps:
 *   1. Sync owned playlists into playlist_tracks (curatorial signal)
 *   2. Build node list (≥10 plays artists, peak year, years active)
 *   3. Build edge list (chained per-year session co-occurrence + playlist co-occurrence)
 *   4. Compute reflection buckets (data-driven quintiles by peak_year)
 *   5. Run d3-force layout + size + opacity
 *   6. Detect clusters (Louvain community detection for orbit motion)
 *   7. Compute labeled-8
 *   8. Assemble JSON, write to KV with 26h TTL
 *
 * Output JSON conforms to spec §6 — the public contract with chrisbuice.com.
 */

import { SpotifyClient } from "../spotify/client";
import {
  buildNodes, buildEdges, buildStats,
  computeReflectionBuckets, reflectionIndexFor, reflectionLabel,
} from "./queries";
import { runForceLayout } from "./layout";
import { selectLabeledEight } from "./labels";
import { detectClusters } from "./clusters";
import { syncOwnedPlaylistsForConstellation } from "./sync_playlists";
import type {
  ConstellationJson, ConstellationNode, ConstellationEdge, ReflectionBucket,
} from "./types";

export const KV_KEY = "constellation:latest";
export const KV_TTL_SECONDS = 26 * 60 * 60;     // 26 hours — covers a missed nightly run

// Bichromatic palette per spec §5.4: warm amber → cream → hunter green.
// Five interpolated stops; first is warmest (earliest reflection), last is hunter green.
const REFLECTION_PALETTE: string[] = [
  "#c8956d",  // warm amber
  "#b8a07a",
  "#9ba588",
  "#6a8b6a",
  "#3e5e3a",  // deep hunter green
];

// Edges rendered: top-3 per node visible at base opacity (spec §5.7).
// Remaining edges are kept in the layout calculation but not emitted —
// shipping all of them inflates the JSON unnecessarily.
const EDGES_PER_NODE = 3;

export interface BuildConstellationOptions {
  /** Skip the playlist sync. Useful in tests. */
  skipPlaylistSync?: boolean;
  /** d3-force ticks override. Defaults to module constant. */
  ticks?: number;
}

/**
 * Build the constellation JSON. Pure-ish — does read DB and call
 * Spotify (via syncOwnedPlaylistsForConstellation) but does not write
 * to KV. The cron handler in src/index.ts wraps this with the KV write.
 */
export async function buildConstellation(
  db: D1Database,
  spotify: SpotifyClient,
  userSpotifyId: string,
  opts: BuildConstellationOptions = {},
): Promise<ConstellationJson> {
  // Phase 0 — sync playlist track membership. Best-effort; if Spotify
  // is unreachable we still build the constellation from session data
  // alone (the playlist term collapses to zero for missing pairs).
  if (!opts.skipPlaylistSync) {
    try {
      await syncOwnedPlaylistsForConstellation(db, spotify, userSpotifyId);
    } catch (err) {
      console.warn(`constellation: playlist sync failed, continuing without playlist signal: ${err}`);
    }
  }

  // Phase 1 — nodes.
  const nodeRows = await buildNodes(db);
  const nodeArtists = new Set(nodeRows.map(n => n.artist_name));

  // Phase 2 — edges.
  const edgeRows = await buildEdges(db, nodeArtists);

  // Phase 3 — reflection buckets.
  const peakYears = nodeRows.map(n => n.peak_year);
  const reflectionBoundaries = computeReflectionBuckets(peakYears);
  const reflectionBuckets: ReflectionBucket[] = reflectionBoundaries.map((b, i) => ({
    label: reflectionLabel(b, i === reflectionBoundaries.length - 1),
    color: REFLECTION_PALETTE[i] ?? REFLECTION_PALETTE[REFLECTION_PALETTE.length - 1],
  }));

  // Phase 4 — layout.
  const layoutNodes = runForceLayout(nodeRows, edgeRows, { ticks: opts.ticks });

  // Phase 5 — clusters (Louvain community detection for orbit motion, spec §5.14).
  const clusterResult = detectClusters(layoutNodes, edgeRows);

  // Phase 6 — labeled-8.
  const labeledNames = selectLabeledEight(nodeRows);

  // Phase 7 — top-3 neighbors per node + edge selection.
  const indexByName = new Map<string, number>();
  layoutNodes.forEach((n, i) => indexByName.set(n.artist_name, i));

  // Group edges by node so we can take the top-3-by-weight per node.
  const edgesByNode: Map<string, Array<{ neighbor: string; weight: number }>> = new Map();
  for (const e of edgeRows) {
    pushEdge(edgesByNode, e.artist_a, { neighbor: e.artist_b, weight: e.weight });
    pushEdge(edgesByNode, e.artist_b, { neighbor: e.artist_a, weight: e.weight });
  }
  for (const list of edgesByNode.values()) list.sort((a, b) => b.weight - a.weight);

  // Final edge set: union of top-3 per node, deduplicated.
  const finalEdgeKeys = new Set<string>();
  const finalEdges: ConstellationEdge[] = [];
  const maxWeight = edgeRows.reduce((m, e) => Math.max(m, e.weight), 0) || 1;
  for (const n of layoutNodes) {
    const list = edgesByNode.get(n.artist_name) ?? [];
    for (const top of list.slice(0, EDGES_PER_NODE)) {
      const a = n.artist_name < top.neighbor ? n.artist_name : top.neighbor;
      const b = n.artist_name < top.neighbor ? top.neighbor : n.artist_name;
      const k = `${a}||${b}`;
      if (finalEdgeKeys.has(k)) continue;
      finalEdgeKeys.add(k);
      const fromIdx = indexByName.get(a);
      const toIdx = indexByName.get(b);
      if (fromIdx === undefined || toIdx === undefined) continue;
      finalEdges.push({
        from: fromIdx,
        to: toIdx,
        weight: round2(top.weight / maxWeight),
      });
    }
  }

  // Phase 8 — assemble nodes JSON. id, top_neighbors, reflection index, label flag, cluster_id.
  const nodes: ConstellationNode[] = layoutNodes.map((n, i) => {
    const id = formatNodeId(n.artist_name, n.artist_id);
    const neighbors = (edgesByNode.get(n.artist_name) ?? [])
      .slice(0, EDGES_PER_NODE)
      .map(x => x.neighbor);
    return {
      id,
      name: n.artist_name,
      x: n.x,
      y: n.y,
      r: n.r,
      opacity: n.opacity,
      reflection: reflectionIndexFor(n.peak_year, reflectionBoundaries),
      plays: n.total_plays,
      peak_year: n.peak_year,
      years_active: n.years_active,
      ...(n.top_track_id ? { top_track_id: n.top_track_id } : {}),
      cluster_id: clusterResult.assignments[i],
      top_neighbors: neighbors,
      is_labeled: labeledNames.has(n.artist_name),
    };
  });

  // Phase 9 — stats.
  const stats = await buildStats(db);

  return {
    generated_at: new Date().toISOString(),
    stats,
    reflection_buckets: reflectionBuckets,
    viewbox: { width: 1000, height: 1000 },
    clusters: clusterResult.clusters,
    nodes,
    edges: finalEdges,
  };
}

/**
 * Public cron entry point — builds and persists the JSON to KV.
 * Called from src/index.ts's scheduled() handler.
 */
export async function runConstellationCron(
  db: D1Database,
  spotify: SpotifyClient,
  kv: KVNamespace,
  userSpotifyId: string,
): Promise<{ nodes: number; edges: number }> {
  const json = await buildConstellation(db, spotify, userSpotifyId);
  await kv.put(KV_KEY, JSON.stringify(json), { expirationTtl: KV_TTL_SECONDS });
  return { nodes: json.nodes.length, edges: json.edges.length };
}

// ── helpers ───────────────────────────────────────────────────────────

function pushEdge(
  m: Map<string, Array<{ neighbor: string; weight: number }>>,
  key: string,
  v: { neighbor: string; weight: number },
): void {
  const list = m.get(key);
  if (list) list.push(v);
  else m.set(key, [v]);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Lowercase + non-alphanumerics-as-dashes fallback id. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Format the JSON `id` field per the three-state policy. The renderer
 * keys click behavior off the prefix (see types.ts's ConstellationNode):
 *   resolved   → "spotify:artist:<id>"   → opens artist page
 *   unresolved → "name:<slug>"           → opens Spotify search
 *   ambiguous  → "ambiguous:<slug>"      → click disabled
 */
export function formatNodeId(
  artistName: string,
  resolution: { kind: "resolved"; id: string } | { kind: "ambiguous" } | { kind: "unresolved" },
): string {
  switch (resolution.kind) {
    case "resolved":   return `spotify:artist:${resolution.id}`;
    case "ambiguous":  return `ambiguous:${slug(artistName)}`;
    case "unresolved": return `name:${slug(artistName)}`;
  }
}
