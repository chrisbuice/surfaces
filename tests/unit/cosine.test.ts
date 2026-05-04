import { describe, it, expect } from "vitest";
import { cosineSimilarity } from "../../src/lyrics_analysis/cosine";

describe("cosineSimilarity", () => {
  it("returns 1.0 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3, 4]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("returns 1.0 for scaled identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([2, 4, 6]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });

  it("returns 0.0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it("returns -1.0 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it("returns 0 for zero vector (not NaN)", () => {
    const zero = new Float32Array([0, 0, 0]);
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(zero, v)).toBe(0);
    expect(cosineSimilarity(v, zero)).toBe(0);
    expect(cosineSimilarity(zero, zero)).toBe(0);
  });

  it("computes correct value for known angle", () => {
    // 45-degree angle: cos(π/4) ≈ 0.7071
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(Math.SQRT1_2, 4);
  });

  it("handles 1024-D vectors", () => {
    const a = new Float32Array(1024);
    const b = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) {
      a[i] = Math.sin(i);
      b[i] = Math.sin(i);
    }
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 5);
  });
});
