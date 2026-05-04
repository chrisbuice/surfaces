/**
 * clusters.ts — Louvain community detection for the constellation.
 *
 * Runs after d3-force layout settles. Detects communities in the
 * artist co-occurrence graph, computes centroids from the laid-out
 * positions, and assigns rotation rates for the orbit motion layer
 * (spec section 5.14).
 *
 * The algorithm is a basic Louvain pass: greedily assign each node
 * to the neighboring community that maximizes modularity gain,
 * iterate until no moves improve. Deterministic via the same
 * mulberry32 PRNG used in layout.ts.
 */

import type { LayoutNode } from "./layout";
import type { EdgeRow } from "./types";
import type { ConstellationCluster } from "./types";
import { mulberry32 } from "./layout";

const ROTATION_MIN = 0.25;
const ROTATION_MAX = 0.36;

export interface ClusterResult {
  /** cluster_id for each node, indexed by position in layoutNodes. -1 for singletons. */
  assignments: number[];
  clusters: ConstellationCluster[];
}

/**
 * Detect communities via Louvain modularity optimization, then compute
 * centroids and rotation rates from the laid-out node positions.
 */
export function detectClusters(
  layoutNodes: LayoutNode[],
  edges: EdgeRow[],
  opts: { seed?: number } = {},
): ClusterResult {
  const n = layoutNodes.length;
  if (n === 0) return { assignments: [], clusters: [] };

  // Build adjacency: name -> index
  const nameToIdx = new Map<string, number>();
  layoutNodes.forEach((node, i) => nameToIdx.set(node.artist_name, i));

  // Build weighted adjacency list (only edges whose endpoints are in the node list)
  const adj: Map<number, Map<number, number>> = new Map();
  let totalWeight = 0;

  for (const e of edges) {
    const a = nameToIdx.get(e.artist_a);
    const b = nameToIdx.get(e.artist_b);
    if (a === undefined || b === undefined) continue;

    const w = e.weight;
    totalWeight += w;

    if (!adj.has(a)) adj.set(a, new Map());
    if (!adj.has(b)) adj.set(b, new Map());
    adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + w);
    adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + w);
  }

  if (totalWeight === 0) {
    // No edges — all nodes are singletons
    return {
      assignments: new Array(n).fill(-1),
      clusters: [],
    };
  }

  // Node strengths (sum of edge weights per node)
  const k = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const neighbors = adj.get(i);
    if (!neighbors) continue;
    for (const w of neighbors.values()) k[i] += w;
  }

  // Initialize: each node in its own community
  const community = new Int32Array(n);
  for (let i = 0; i < n; i++) community[i] = i;

  // Louvain iteration — use deterministic node visit order
  const rng = mulberry32(opts.seed ?? 0xC1057E);
  const order = Array.from({ length: n }, (_, i) => i);

  // Fisher-Yates shuffle with deterministic PRNG
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const m2 = 2 * totalWeight; // 2m in the modularity formula

  let changed = true;
  let passes = 0;
  const maxPasses = 20;

  while (changed && passes < maxPasses) {
    changed = false;
    passes++;

    for (const i of order) {
      const neighbors = adj.get(i);
      if (!neighbors || neighbors.size === 0) continue;

      const currentComm = community[i];

      // Sum of weights from i to each neighboring community
      const commWeights = new Map<number, number>();
      // Weight to own community
      let wSelf = 0;

      for (const [j, w] of neighbors) {
        const c = community[j];
        commWeights.set(c, (commWeights.get(c) ?? 0) + w);
        if (c === currentComm) wSelf += w;
      }

      // Sum of k values in each community (excluding i)
      const commK = new Map<number, number>();
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const c = community[j];
        if (commWeights.has(c)) {
          commK.set(c, (commK.get(c) ?? 0) + k[j]);
        }
      }
      // Also compute for current community (used in removal delta)
      if (!commWeights.has(currentComm)) {
        // i has no neighbors in its own community — compute commK for removal
        let ck = 0;
        for (let j = 0; j < n; j++) {
          if (j === i && community[j] === currentComm) continue;
          if (community[j] === currentComm) ck += k[j];
        }
        commK.set(currentComm, ck);
      }

      // Find the community that gives the best modularity gain
      let bestComm = currentComm;
      let bestDelta = 0;

      // Delta Q for removing i from current community
      const sumInCurrent = commK.get(currentComm) ?? 0;
      const removeDelta = -wSelf / m2 + (k[i] * sumInCurrent) / (m2 * m2);

      for (const [c, wc] of commWeights) {
        if (c === currentComm) continue;
        const sumInC = commK.get(c) ?? 0;
        // Delta Q for inserting i into community c
        const insertDelta = wc / m2 - (k[i] * sumInC) / (m2 * m2);
        const totalDelta = removeDelta + insertDelta;

        if (totalDelta > bestDelta) {
          bestDelta = totalDelta;
          bestComm = c;
        }
      }

      if (bestComm !== currentComm) {
        community[i] = bestComm;
        changed = true;
      }
    }
  }

  // Renumber communities to contiguous 0..K-1
  const uniqueComms = [...new Set(community)].sort((a, b) => a - b);
  const commMap = new Map<number, number>();
  uniqueComms.forEach((c, i) => commMap.set(c, i));

  const assignments = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    assignments[i] = commMap.get(community[i])!;
  }

  // Mark singletons: nodes with no edges get cluster_id = -1
  for (let i = 0; i < n; i++) {
    const neighbors = adj.get(i);
    if (!neighbors || neighbors.size === 0) {
      assignments[i] = -1;
    }
  }

  // Also mark single-member clusters as singletons
  const clusterSizes = new Map<number, number>();
  for (const c of assignments) {
    if (c >= 0) clusterSizes.set(c, (clusterSizes.get(c) ?? 0) + 1);
  }
  for (let i = 0; i < n; i++) {
    if (assignments[i] >= 0 && (clusterSizes.get(assignments[i]) ?? 0) <= 1) {
      assignments[i] = -1;
    }
  }

  // Build cluster objects with centroids and rotation rates
  const clusterNodes = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = assignments[i];
    if (c < 0) continue;
    if (!clusterNodes.has(c)) clusterNodes.set(c, []);
    clusterNodes.get(c)!.push(i);
  }

  // Renumber again after singleton removal (to keep contiguous IDs)
  const finalIds = [...clusterNodes.keys()].sort((a, b) => a - b);
  const finalMap = new Map<number, number>();
  finalIds.forEach((oldId, newId) => finalMap.set(oldId, newId));

  for (let i = 0; i < n; i++) {
    if (assignments[i] >= 0) {
      assignments[i] = finalMap.get(assignments[i])!;
    }
  }

  // Rebuild clusterNodes with final IDs
  const finalClusterNodes = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = assignments[i];
    if (c < 0) continue;
    if (!finalClusterNodes.has(c)) finalClusterNodes.set(c, []);
    finalClusterNodes.get(c)!.push(i);
  }

  const clusters: ConstellationCluster[] = [];
  const rotRng = mulberry32((opts.seed ?? 0xC1057E) + 1);

  for (const [id, members] of [...finalClusterNodes.entries()].sort((a, b) => a[0] - b[0])) {
    let cx = 0, cy = 0;
    for (const i of members) {
      cx += layoutNodes[i].x;
      cy += layoutNodes[i].y;
    }
    cx /= members.length;
    cy /= members.length;

    clusters.push({
      id,
      centroid_x: Math.round(cx * 10) / 10,
      centroid_y: Math.round(cy * 10) / 10,
      rotation_rate_deg_per_sec: Math.round((ROTATION_MIN + rotRng() * (ROTATION_MAX - ROTATION_MIN)) * 100) / 100,
      node_count: members.length,
    });
  }

  return { assignments, clusters };
}
