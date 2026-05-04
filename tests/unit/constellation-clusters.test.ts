import { describe, it, expect } from "vitest";
import { detectClusters } from "../../src/constellation/clusters";
import type { LayoutNode } from "../../src/constellation/layout";
import type { EdgeRow } from "../../src/constellation/types";

function fakeLayoutNode(name: string, x: number, y: number): LayoutNode {
  return {
    artist_name: name,
    artist_id: { kind: "unresolved" },
    total_plays: 100,
    peak_year: 2020,
    years_active: 5,
    x, y,
    r: 10,
    opacity: 0.8,
  };
}

function fakeEdge(a: string, b: string, weight: number): EdgeRow {
  const [artist_a, artist_b] = a < b ? [a, b] : [b, a];
  return { artist_a, artist_b, session_co: 5, playlist_co: 0, weight };
}

describe("detectClusters", () => {
  it("returns empty for no nodes", () => {
    const result = detectClusters([], []);
    expect(result.assignments).toEqual([]);
    expect(result.clusters).toEqual([]);
  });

  it("marks nodes with no edges as singletons (cluster_id = -1)", () => {
    const nodes = [
      fakeLayoutNode("A", 100, 100),
      fakeLayoutNode("B", 500, 500),
    ];
    const result = detectClusters(nodes, []);
    expect(result.assignments).toEqual([-1, -1]);
    expect(result.clusters).toEqual([]);
  });

  it("detects two clear clusters in a barbell graph", () => {
    // Two tight clusters connected by a weak bridge
    const nodes = [
      fakeLayoutNode("A1", 100, 100),
      fakeLayoutNode("A2", 120, 110),
      fakeLayoutNode("A3", 110, 130),
      fakeLayoutNode("B1", 800, 800),
      fakeLayoutNode("B2", 820, 810),
      fakeLayoutNode("B3", 810, 830),
    ];
    const edges = [
      // Cluster A: strong internal edges
      fakeEdge("A1", "A2", 10),
      fakeEdge("A1", "A3", 10),
      fakeEdge("A2", "A3", 10),
      // Cluster B: strong internal edges
      fakeEdge("B1", "B2", 10),
      fakeEdge("B1", "B3", 10),
      fakeEdge("B2", "B3", 10),
      // Weak bridge
      fakeEdge("A1", "B1", 0.1),
    ];

    const result = detectClusters(nodes, edges);

    // A nodes should share a cluster, B nodes should share a cluster
    expect(result.assignments[0]).toBe(result.assignments[1]);
    expect(result.assignments[0]).toBe(result.assignments[2]);
    expect(result.assignments[3]).toBe(result.assignments[4]);
    expect(result.assignments[3]).toBe(result.assignments[5]);
    // The two clusters should be different
    expect(result.assignments[0]).not.toBe(result.assignments[3]);
    // Both should be >= 0 (not singletons)
    expect(result.assignments[0]).toBeGreaterThanOrEqual(0);
    expect(result.assignments[3]).toBeGreaterThanOrEqual(0);

    expect(result.clusters).toHaveLength(2);
  });

  it("computes centroids as mean of member positions", () => {
    const nodes = [
      fakeLayoutNode("A", 100, 200),
      fakeLayoutNode("B", 200, 400),
      fakeLayoutNode("C", 300, 300),
    ];
    const edges = [
      fakeEdge("A", "B", 10),
      fakeEdge("A", "C", 10),
      fakeEdge("B", "C", 10),
    ];

    const result = detectClusters(nodes, edges);
    // All three should be in one cluster
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].centroid_x).toBeCloseTo(200, 0);
    expect(result.clusters[0].centroid_y).toBeCloseTo(300, 0);
    expect(result.clusters[0].node_count).toBe(3);
  });

  it("rotation rates are within the 0.25-0.36 range", () => {
    const nodes = [
      fakeLayoutNode("A1", 100, 100),
      fakeLayoutNode("A2", 120, 110),
      fakeLayoutNode("B1", 800, 800),
      fakeLayoutNode("B2", 820, 810),
    ];
    const edges = [
      fakeEdge("A1", "A2", 10),
      fakeEdge("B1", "B2", 10),
    ];

    const result = detectClusters(nodes, edges);
    for (const c of result.clusters) {
      expect(c.rotation_rate_deg_per_sec).toBeGreaterThanOrEqual(0.25);
      expect(c.rotation_rate_deg_per_sec).toBeLessThanOrEqual(0.36);
    }
  });

  it("is deterministic — same input produces same output", () => {
    const nodes = [
      fakeLayoutNode("A", 100, 100),
      fakeLayoutNode("B", 120, 110),
      fakeLayoutNode("C", 110, 130),
      fakeLayoutNode("D", 800, 800),
      fakeLayoutNode("E", 820, 810),
    ];
    const edges = [
      fakeEdge("A", "B", 10),
      fakeEdge("A", "C", 10),
      fakeEdge("B", "C", 10),
      fakeEdge("D", "E", 10),
      fakeEdge("A", "D", 0.1),
    ];

    const r1 = detectClusters(nodes, edges, { seed: 42 });
    const r2 = detectClusters(nodes, edges, { seed: 42 });

    expect(r1.assignments).toEqual(r2.assignments);
    expect(r1.clusters).toEqual(r2.clusters);
  });

  it("cluster IDs are contiguous starting from 0", () => {
    const nodes = [
      fakeLayoutNode("A", 100, 100),
      fakeLayoutNode("B", 120, 110),
      fakeLayoutNode("C", 800, 800),
      fakeLayoutNode("D", 820, 810),
    ];
    const edges = [
      fakeEdge("A", "B", 10),
      fakeEdge("C", "D", 10),
    ];

    const result = detectClusters(nodes, edges);
    const ids = result.clusters.map(c => c.id);
    expect(ids).toEqual([0, 1]);
  });
});
