import { describe, expect, it, vi } from "vitest";
import { countWords, readingMinutes, splitSentences, splitWords } from "../lib/text";

describe("splitSentences", () => {
  it("returns [] for empty or whitespace-only input", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   \n\t  ")).toEqual([]);
  });

  it("splits sentences with consistent global offsets", () => {
    const text = "Hello world. How are you? Fine!";
    const out = splitSentences(text);
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Every span must round-trip through the source text.
    for (const s of out) {
      expect(s.text.trim().length).toBeGreaterThan(0);
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
    expect(out[0]!.start).toBe(0);
    expect(out[out.length - 1]!.end).toBe(text.length);
    // Offsets are ordered and non-overlapping.
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.start).toBeGreaterThanOrEqual(out[i - 1]!.end);
    }
  });

  it("falls back to regex when Intl.Segmenter is unavailable", () => {
    vi.stubGlobal(
      "Intl",
      new Proxy(Intl, {
        get(target, prop) {
          if (prop === "Segmenter") {
            return class {
              constructor() {
                throw new Error("Segmenter unavailable");
              }
            };
          }
          return Reflect.get(target, prop);
        },
      })
    );
    try {
      const out = splitSentences("Hello world. Bye now.");
      expect(out).toHaveLength(2);
      expect(out[0]).toMatchObject({ text: "Hello world. ", start: 0 });
      expect(out[1]!.text).toContain("Bye now.");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("regex fallback returns the whole text when nothing matches", () => {
    vi.stubGlobal("Intl", { Segmenter: undefined });
    try {
      const out = splitSentences("no punctuation here");
      expect(out).toEqual([{ text: "no punctuation here", start: 0, end: 19 }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("splitWords / countWords", () => {
  it("splits on whitespace with global offsets", () => {
    const out = splitWords("  hello   world\nfoo ");
    expect(out).toEqual([
      { text: "hello", start: 2, end: 7 },
      { text: "world", start: 10, end: 15 },
      { text: "foo", start: 16, end: 19 },
    ]);
  });

  it("returns [] for empty input", () => {
    expect(splitWords("")).toEqual([]);
    expect(splitWords("   ")).toEqual([]);
  });

  it("countWords counts non-whitespace tokens", () => {
    expect(countWords("")).toBe(0);
    expect(countWords("one two  three\nfour")).toBe(4);
  });
});

describe("readingMinutes", () => {
  it("clamps to a minimum of 1", () => {
    expect(readingMinutes(0)).toBe(1);
    expect(readingMinutes(-50)).toBe(1);
    expect(readingMinutes(1)).toBe(1);
  });

  it("rounds wordCount / wpm", () => {
    expect(readingMinutes(200)).toBe(1);
    expect(readingMinutes(400)).toBe(2);
    expect(readingMinutes(10000)).toBe(50);
    expect(readingMinutes(400, 100)).toBe(4);
  });
});
