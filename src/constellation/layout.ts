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
export const FORCE_TICKS = 300;

export interface LayoutNode {
  artist_name: string;
  artist_id: ArtistIdResolution;
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

    // Filter edges to those whose endpoints are in the node list. Edge
    // weights are normalized into a 0..1 strength for the link force.
    const maxWeight = edges.reduce((m, e) => Math.max(m, e.weight), 0) || 1;
    const simEdges: SimLink[] = [];
    for (const e of edges) {
      if (!idIndex.has(e.artist_a) || !idIndex.has(e.artist_b)) continue;
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
          .strength(d => d.strength)
          .distance(40),
      )
      .force("charge", forceManyBody<SimNode>().strength(-30))
      .force("center", forceCenter<SimNode>(0, 0))
      .force("collide", forceCollide<SimNode>(d => (radii[d.index ?? 0] ?? SIZE_MIN_PX) + 1))
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
    // Use the larger span so we keep the constellation's aspect ratio
    // rather than stretching it into a square.
    const span = Math.max(spanX, spanY);
    const targetSize = VIEWBOX_SIZE - 2 * VIEWBOX_INSET;
    const scale = targetSize / span;
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
      total_plays: n.total_plays,
      peak_year: n.peak_year,
      years_active: n.years_active,
      x: round(center + (xs[i] - cx) * scale),
      y: round(center + (ys[i] - cy) * scale),
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
