import { describe, expect, it } from "vitest";
import { clampOffset, fractionToOffset, offsetToFraction } from "../lib/progress-sync";

describe("clampOffset", () => {
  it("returns 0 for empty text", () => {
    expect(clampOffset(0, 0)).toBe(0);
    expect(clampOffset(50, 0)).toBe(0);
    expect(clampOffset(-5, 0)).toBe(0);
  });

  it("clamps below 0 and above textLength", () => {
    expect(clampOffset(-1, 100)).toBe(0);
    expect(clampOffset(-9999, 100)).toBe(0);
    expect(clampOffset(101, 100)).toBe(100);
    expect(clampOffset(9999, 100)).toBe(100);
    expect(clampOffset(0, 100)).toBe(0);
    expect(clampOffset(100, 100)).toBe(100);
  });

  it("rounds to whole chars", () => {
    expect(clampOffset(10.4, 100)).toBe(10);
    expect(clampOffset(10.5, 100)).toBe(11);
  });

  it("maps NaN/non-finite offset to 0", () => {
    expect(clampOffset(NaN, 100)).toBe(0);
    expect(clampOffset(Infinity, 100)).toBe(0);
    expect(clampOffset(-Infinity, 100)).toBe(0);
  });

  it("treats bad textLength as empty text", () => {
    expect(clampOffset(5, NaN)).toBe(0);
    expect(clampOffset(5, Infinity)).toBe(0);
    expect(clampOffset(5, -10)).toBe(0);
  });
});

describe("offsetToFraction", () => {
  it("returns 0 for empty text", () => {
    expect(offsetToFraction(0, 0)).toBe(0);
    expect(offsetToFraction(10, 0)).toBe(0);
  });

  it("maps offset / textLength and clamps both ends", () => {
    expect(offsetToFraction(0, 100)).toBe(0);
    expect(offsetToFraction(50, 100)).toBe(0.5);
    expect(offsetToFraction(100, 100)).toBe(1);
    expect(offsetToFraction(-5, 100)).toBe(0);
    expect(offsetToFraction(500, 100)).toBe(1);
  });

  it("maps NaN/non-finite offset to 0", () => {
    expect(offsetToFraction(NaN, 100)).toBe(0);
    expect(offsetToFraction(Infinity, 100)).toBe(0);
  });
});

describe("fractionToOffset", () => {
  it("returns 0 for empty text", () => {
    expect(fractionToOffset(0, 0)).toBe(0);
    expect(fractionToOffset(0.5, 0)).toBe(0);
  });

  it("maps fraction * textLength and clamps both ends", () => {
    expect(fractionToOffset(0, 100)).toBe(0);
    expect(fractionToOffset(0.5, 100)).toBe(50);
    expect(fractionToOffset(1, 100)).toBe(100);
    expect(fractionToOffset(-0.5, 100)).toBe(0);
    expect(fractionToOffset(1.5, 100)).toBe(100);
  });

  it("maps NaN/non-finite fraction to 0", () => {
    expect(fractionToOffset(NaN, 100)).toBe(0);
    expect(fractionToOffset(Infinity, 100)).toBe(0);
    expect(fractionToOffset(-Infinity, 100)).toBe(0);
  });
});

describe("round-trip offset → fraction → offset", () => {
  it("stays within ±1 char", () => {
    const len = 1000;
    for (let offset = 0; offset <= len; offset += 7) {
      const back = fractionToOffset(offsetToFraction(offset, len), len);
      expect(Math.abs(back - offset)).toBeLessThanOrEqual(1);
    }
  });
});
