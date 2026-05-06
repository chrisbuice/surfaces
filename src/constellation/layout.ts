/**
 * layout.ts — server-side force-directed layout + visual encoding.
 *
 * Browser does no layout math (spec §6); positions are precomputed
 * absolute coordinates inside a 1000×1000 viewbox. d3-force is run
 * with edges as links and a small repulsion charge for ~300 ticks,
 * then coordinates are normalized into the viewbox with an inset.
 *
 * Size encoding (spec §5.5): r = sqrt(plays) mapped 3..24 (desktop).
 * Opacity encoding (spec §5.6): years_active / total_years mapped
 * 0.4..1.0.
 *
 * d3-force requires a Math.random shim under Workers — provided here.
 * The simulation is seeded via a deterministic PRNG override so the
 * nightly output is stable run-over-run for the same inputs.
 */

import {
  forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide,
  type SimulationNodeDatum, type SimulationLinkDatum,
} from "d3-force";
import type { NodeRow, EdgeRow, ArtistIdResolution } from "./types";

// d3-force's typed API expects nodes/links to extend its base shapes.
// We carry our own fields alongside the simulation's internal ones.
interface SimNode extends SimulationNodeDatum {
  id: string;
  index: number;
}
interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string;
  target: string;
  strength: number;
}

export const VIEWBOX_SIZE = 1000;
export const VIEWBOX_INSET = 30;            // keep nothing touching the edge
export const SIZE_MIN_PX = 3;
export const SIZE_MAX_PX = 24;
export const OPACITY_MIN = 0.4;
export const OPACITY_MAX = 1.0;
export const FORCE_TICKS = 500;

export interface LayoutNode {
  artist_name: string;
  artist_id: ArtistIdResolution;
  top_track_id: string | null;
  total_plays: number;
  peak_year: number;
  years_active: number;
  x: number;
  y: number;
  r: number;
  opacity: number;
}

/**
 * Run d3-force with the given nodes and edges, returning nodes with
 * (x, y) coordinates normalized into the viewbox plus precomputed
 * radius and opacity. Inputs are not mutated.
 */
export function runForceLayout(
  nodes: NodeRow[],
  edges: EdgeRow[],
  opts: { ticks?: number; seed?: number } = {},
): LayoutNode[] {
  if (nodes.length === 0) return [];

  const ticks = opts.ticks ?? FORCE_TICKS;
  const rng = mulberry32(opts.seed ?? 0xC0FFEE);
  const origRandom = Math.random;
  // Determinism: d3-force uses Math.random for initial jitter and
  // velocity damping. Override across the simulation, restore after.
  // (Reentrant calls in tests are fine — origRandom is captured per call.)
  Math.random = rng;

  try {
    const idIndex = new Map<string, number>();
    nodes.forEach((n, i) => idIndex.set(n.artist_name, i));

    const simNodes: SimNode[] = nodes.map((n, i) => ({ id: n.artist_name, index: i }));

    // Filter edges to those whose endpoints are in the node list. To
    // keep the simulation from collapsing into a dense ball, only feed
    // the top 3 edges per node into the force layout (strongest
    // connections). All edges are still available for rendering — this
    // only affects how d3-force positions nodes.
    const maxWeight = edges.reduce((m, e) => Math.max(m, e.weight), 0) || 1;
    const validEdges = edges.filter(e => idIndex.has(e.artist_a) && idIndex.has(e.artist_b));

    // Select top 3 per node (by weight)
    const topPerNode = new Map<string, Array<typeof validEdges[0]>>();
    for (const e of validEdges) {
      for (const name of [e.artist_a, e.artist_b]) {
        const list = topPerNode.get(name) ?? [];
        list.push(e);
        topPerNode.set(name, list);
      }
    }
    const layoutEdgeSet = new Set<string>();
    for (const [, list] of topPerNode) {
      list.sort((a, b) => b.weight - a.weight);
      for (const e of list.slice(0, 3)) {
        const key = e.artist_a < e.artist_b ? `${e.artist_a}::${e.artist_b}` : `${e.artist_b}::${e.artist_a}`;
        layoutEdgeSet.add(key);
      }
    }

    const simEdges: SimLink[] = [];
    for (const e of validEdges) {
      const key = e.artist_a < e.artist_b ? `${e.artist_a}::${e.artist_b}` : `${e.artist_b}::${e.artist_a}`;
      if (!layoutEdgeSet.has(key)) continue;
      simEdges.push({
        source: e.artist_a,
        target: e.artist_b,
        strength: 0.05 + 0.6 * (e.weight / maxWeight),
      });
    }

    const totalPlays = nodes.map(n => n.total_plays);
    const radii = totalPlays.map(p => sqrtScale(p, totalPlays, SIZE_MIN_PX, SIZE_MAX_PX));

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simEdges)
          .id(d => d.id)
          .strength(d => d.strength * 0.15)
          .distance(120),
      )
      .force("charge", forceManyBody<SimNode>().strength(-800))
      .force("center", forceCenter<SimNode>(0, 0))
      .force("collide", forceCollide<SimNode>(d => (radii[d.index ?? 0] ?? SIZE_MIN_PX) + 3))
      .stop();

    for (let i = 0; i < ticks; i++) sim.tick();

    // Compute the bounding box of the settled simulation, then map it
    // into [VIEWBOX_INSET, VIEWBOX_SIZE - VIEWBOX_INSET] on each axis.
    const xs = simNodes.map(n => n.x ?? 0);
    const ys = simNodes.map(n => n.y ?? 0);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const spanX = Math.max(1e-6, maxX - minX);
    const spanY = Math.max(1e-6, maxY - minY);
    // Stretch each axis independently to fill the viewbox. The
    // constellation is a visual composition, not a geographic map —
    // filling the square produces a better result than preserving
    // the simulation's (often lopsided) aspect ratio.
    const targetSize = VIEWBOX_SIZE - 2 * VIEWBOX_INSET;
    const scaleX = targetSize / spanX;
    const scaleY = targetSize / spanY;
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const center = VIEWBOX_SIZE / 2;

    // Compute total years actually represented (max - min year + 1) for
    // the opacity normalizer. Falls back to 1 if all peak_years collapse.
    const peakYears = nodes.map(n => n.peak_year);
    const totalYears = Math.max(1, Math.max(...peakYears) - Math.min(...peakYears) + 1);

    return nodes.map((n, i) => ({
      artist_name: n.artist_name,
      artist_id: n.artist_id,
      top_track_id: n.top_track_id,
      total_plays: n.total_plays,
      peak_year: n.peak_year,
      years_active: n.years_active,
      x: round(center + (xs[i] - cx) * scaleX),
      y: round(center + (ys[i] - cy) * scaleY),
      r: round(radii[i]),
      opacity: round(opacityFor(n.years_active, totalYears)),
    }));
  } finally {
    Math.random = origRandom;
  }
}

/**
 * sqrt-scaled radius in [outMin, outMax]. The square root keeps top
 * artists from being absurdly larger than the median — see spec §5.5.
 */
export function sqrtScale(value: number, all: number[], outMin: number, outMax: number): number {
  const minIn = Math.min(...all);
  const maxIn = Math.max(...all);
  if (maxIn <= minIn) return outMin;
  const t = (Math.sqrt(value) - Math.sqrt(minIn)) / (Math.sqrt(maxIn) - Math.sqrt(minIn));
  return outMin + Math.max(0, Math.min(1, t)) * (outMax - outMin);
}

/** Opacity = years_active / total_years_in_data, mapped to [OPACITY_MIN, OPACITY_MAX]. */
export function opacityFor(yearsActive: number, totalYears: number): number {
  const t = totalYears > 0 ? yearsActive / totalYears : 0;
  return OPACITY_MIN + Math.max(0, Math.min(1, t)) * (OPACITY_MAX - OPACITY_MIN);
}

/** Round to one decimal — keeps the JSON compact without losing precision. */
function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Deterministic PRNG (mulberry32) used to seed Math.random for the
 * d3-force simulation. Same seed → same layout every night.
 */
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return function () {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
