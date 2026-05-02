import { describe, it, expect } from "vitest";
import {
  runForceLayout, sqrtScale, opacityFor, mulberry32,
  VIEWBOX_SIZE, VIEWBOX_INSET, SIZE_MIN_PX, SIZE_MAX_PX,
  OPACITY_MIN, OPACITY_MAX,
} from "../../src/constellation/layout";
import { selectLabeledEight } from "../../src/constellation/labels";
import { formatNodeId, slug } from "../../src/constellation/cron";
import type { NodeRow, EdgeRow } from "../../src/constellation/types";

function fakeNode(name: string, plays: number, peakYear: number, yearsActive: number): NodeRow {
  return {
    artist_name: name,
    artist_id: { kind: "unresolved" },
    total_plays: plays,
    peak_year: peakYear,
    years_active: yearsActive,
  };
}

function fakeEdge(a: string, b: string, weight: number): EdgeRow {
  const [artist_a, artist_b] = a < b ? [a, b] : [b, a];
  return { artist_a, artist_b, session_co: 5, playlist_co: 0, weight };
}

describe("layout — sqrtScale", () => {
  it("maps the minimum to outMin and the maximum to outMax", () => {
    const all = [16, 64, 256];
    expect(sqrtScale(16, all, 3, 24)).toBeCloseTo(3);
    expect(sqrtScale(256, all, 3, 24)).toBeCloseTo(24);
  });

  it("places intermediate values via sqrt scaling, not linear", () => {
    const all = [16, 256];
    // sqrt midpoint of 16..256 is sqrt(16) + (sqrt(256)-sqrt(16))/2 = 4 + 6 = 10
    // value 100: sqrt = 10 → t = (10-4)/(16-4) = 0.5 → midway between out bounds.
    const r = sqrtScale(100, all, 3, 24);
    expect(r).toBeCloseTo(13.5, 1);
  });
});

describe("layout — opacityFor", () => {
  it("clamps to [OPACITY_MIN, OPACITY_MAX]", () => {
    expect(opacityFor(0, 10)).toBeCloseTo(OPACITY_MIN);
    expect(opacityFor(10, 10)).toBeCloseTo(OPACITY_MAX);
    expect(opacityFor(100, 10)).toBeCloseTo(OPACITY_MAX);    // saturated
    expect(opacityFor(-5, 10)).toBeCloseTo(OPACITY_MIN);     // clamped
  });
});

describe("layout — runForceLayout", () => {
  const nodes = [
    fakeNode("A", 100, 2015, 5),
    fakeNode("B", 400, 2020, 8),
    fakeNode("C", 50, 2012, 2),
    fakeNode("D", 200, 2018, 6),
  ];
  const edges = [
    fakeEdge("A", "B", 3.5),
    fakeEdge("B", "D", 2.1),
  ];

  it("places every node inside the viewbox with the inset", () => {
    const laid = runForceLayout(nodes, edges, { ticks: 50, seed: 1 });
    expect(laid).toHaveLength(nodes.length);
    for (const n of laid) {
      expect(n.x).toBeGreaterThanOrEqual(VIEWBOX_INSET - 1);
      expect(n.x).toBeLessThanOrEqual(VIEWBOX_SIZE - VIEWBOX_INSET + 1);
      expect(n.y).toBeGreaterThanOrEqual(VIEWBOX_INSET - 1);
      expect(n.y).toBeLessThanOrEqual(VIEWBOX_SIZE - VIEWBOX_INSET + 1);
    }
  });

  it("size lands inside [SIZE_MIN_PX, SIZE_MAX_PX]", () => {
    const laid = runForceLayout(nodes, edges, { ticks: 50, seed: 1 });
    for (const n of laid) {
      expect(n.r).toBeGreaterThanOrEqual(SIZE_MIN_PX - 0.05);
      expect(n.r).toBeLessThanOrEqual(SIZE_MAX_PX + 0.05);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = runForceLayout(nodes, edges, { ticks: 30, seed: 42 });
    const b = runForceLayout(nodes, edges, { ticks: 30, seed: 42 });
    expect(a.map(n => [n.artist_name, n.x, n.y]))
      .toEqual(b.map(n => [n.artist_name, n.x, n.y]));
  });

  it("returns [] for empty input", () => {
    expect(runForceLayout([], [], { ticks: 1, seed: 1 })).toEqual([]);
  });
});

describe("layout — mulberry32 PRNG", () => {
  it("produces values in [0,1)", () => {
    const r = mulberry32(0xDEADBEEF);
    for (let i = 0; i < 100; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("is deterministic for the same seed", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 5; i++) expect(a()).toBe(b());
  });
});

describe("cron — formatNodeId", () => {
  it("emits the spotify URI form when resolved", () => {
    expect(formatNodeId("Radiohead", { kind: "resolved", id: "abc123" }))
      .toBe("spotify:artist:abc123");
  });

  it("emits the ambiguous: prefix when the display name maps to multiple ids", () => {
    expect(formatNodeId("Common", { kind: "ambiguous" })).toBe("ambiguous:common");
  });

  it("emits the name: prefix when no artist_taste row exists", () => {
    expect(formatNodeId("Sufjan Stevens", { kind: "unresolved" })).toBe("name:sufjan-stevens");
  });

  it("slug strips punctuation and collapses whitespace", () => {
    expect(slug("M.I.A.")).toBe("m-i-a");
    expect(slug("  Beyoncé!  ")).toBe("beyonc");
  });
});

describe("labels — selectLabeledEight", () => {
  it("picks 8 by composite score when no manual list is set", () => {
    // 10 nodes; the highest score wins.
    const ns: NodeRow[] = [];
    for (let i = 0; i < 10; i++) {
      ns.push(fakeNode(`n${i}`, (i + 1) * 100, 2020, i + 1));
    }
    const labeled = selectLabeledEight(ns);
    expect(labeled.size).toBe(8);
    // n9 has plays=1000 × years_active/total_years, n0 has plays=100 × 1/total_years.
    // n9 must be in the set; n0 must not.
    expect(labeled.has("n9")).toBe(true);
    expect(labeled.has("n0")).toBe(false);
  });

  it("returns at most LABEL_TOTAL even when input is small", () => {
    const ns: NodeRow[] = [];
    for (let i = 0; i < 3; i++) ns.push(fakeNode(`n${i}`, 50, 2020, 1));
    const labeled = selectLabeledEight(ns);
    expect(labeled.size).toBe(3);
  });
});
