import { describe, expect, it } from "vitest";
import {
  buildWordAlignment,
  estimateTextOffsetForHtmlIndex,
  findTextWordAtOffset,
  htmlIndexToTextOffset,
  normalizeWordForMatch,
  textOffsetToHtmlIndex,
  type TextWord,
} from "../lib/html-sync";
import { splitWords } from "../lib/text";

function words(text: string): TextWord[] {
  return splitWords(text);
}

describe("normalizeWordForMatch", () => {
  it("lowercases and trims edge punctuation", () => {
    expect(normalizeWordForMatch("Hello,")).toBe("hello");
    expect(normalizeWordForMatch('"Quoted"')).toBe("quoted");
    expect(normalizeWordForMatch("(parenthetical)")).toBe("parenthetical");
  });

  it("folds curly quotes/dashes so typographic variants match", () => {
    expect(normalizeWordForMatch("don’t")).toBe(normalizeWordForMatch("don't"));
    expect(normalizeWordForMatch("—")).toBe(normalizeWordForMatch("—"));
  });

  it("keeps distinct punctuation-only tokens apart", () => {
    expect(normalizeWordForMatch("—")).not.toBe(normalizeWordForMatch("..."));
  });
});

describe("buildWordAlignment", () => {
  it("aligns identical sequences 1:1", () => {
    const text = words("hello brave new world");
    const a = buildWordAlignment(text, ["hello", "brave", "new", "world"]);
    expect(a.textToHtml).toEqual([0, 1, 2, 3]);
    expect(a.htmlToText).toEqual([0, 1, 2, 3]);
  });

  it("matches across case/punctuation drift", () => {
    const text = words("Hello, brave new WORLD!");
    const a = buildWordAlignment(text, ["hello", "brave", "new", "world"]);
    expect(a.textToHtml).toEqual([0, 1, 2, 3]);
  });

  it("skips inserted html words (captions) without desyncing the tail", () => {
    const text = words("the cat sat on the mat");
    const a = buildWordAlignment(text, ["the", "cat", "PHOTO", "sat", "on", "the", "mat"]);
    // "sat" (text 2) still lands on html 3 despite the inserted caption word.
    expect(a.textToHtml).toEqual([0, 1, 3, 4, 5, 6]);
    expect(a.htmlToText[2]).toBeNull();
  });

  it("skips deleted text words without desyncing the tail", () => {
    const text = words("the cat fluffy sat");
    const a = buildWordAlignment(text, ["the", "cat", "sat"]);
    expect(a.htmlToText).toEqual([0, 1, 3]);
    expect(a.textToHtml[2]).toBeNull();
  });

  it("leaves one bad word unmapped instead of stalling", () => {
    const text = words("alpha beta gamma delta");
    const a = buildWordAlignment(text, ["alpha", "XXXX", "gamma", "delta"]);
    expect(a.textToHtml[0]).toBe(0);
    expect(a.textToHtml[2]).toBe(2);
    expect(a.textToHtml[3]).toBe(3);
  });

  it("handles empty inputs", () => {
    expect(buildWordAlignment([], [])).toEqual({ textToHtml: [], htmlToText: [] });
    expect(buildWordAlignment(words("hi"), []).htmlToText).toEqual([]);
  });
});

describe("offset mapping with fallbacks", () => {
  it("maps offsets to html indices via the containing word", () => {
    const text = words("hello brave world");
    const a = buildWordAlignment(text, ["hello", "brave", "world"]);
    expect(textOffsetToHtmlIndex(0, text, a)).toBe(0);
    // Mid-"brave" offset lands on html 1.
    expect(textOffsetToHtmlIndex(text[1]!.start + 2, text, a)).toBe(1);
    // Whitespace between words falls back to the preceding word.
    expect(textOffsetToHtmlIndex(text[1]!.start - 1, text, a)).toBe(0);
  });

  it("falls back to neighbors when the exact word is unmapped", () => {
    const text = words("the cat fluffy sat");
    const a = buildWordAlignment(text, ["the", "cat", "sat"]);
    // "fluffy" (text 2) is deleted; its offset highlights the preceding "cat".
    expect(textOffsetToHtmlIndex(text[2]!.start, text, a)).toBe(1);
  });

  it("maps html clicks to text offsets with neighbor fallback", () => {
    const text = words("the cat sat on the mat");
    const a = buildWordAlignment(text, ["the", "cat", "PHOTO", "sat", "on", "the", "mat"]);
    expect(htmlIndexToTextOffset(3, text, a)).toBe(text[2]!.start);
    // Clicking the inserted caption seeks from the preceding word.
    expect(htmlIndexToTextOffset(2, text, a)).toBe(text[1]!.start);
  });

  it("returns null when nothing aligns or inputs are empty", () => {
    expect(htmlIndexToTextOffset(0, [], { textToHtml: [], htmlToText: [] })).toBeNull();
    expect(textOffsetToHtmlIndex(5, [], { textToHtml: [], htmlToText: [] })).toBeNull();
    expect(
      htmlIndexToTextOffset(99, words("hi"), buildWordAlignment(words("hi"), ["hi"]))
    ).toBeNull();
  });

  it("findTextWordAtOffset handles edges", () => {
    expect(findTextWordAtOffset([], 0)).toBeNull();
    const text = words("ab cd");
    expect(findTextWordAtOffset(text, 0)).toBe(0);
    expect(findTextWordAtOffset(text, 99)).toBe(1);
    expect(findTextWordAtOffset(text, Number.NaN)).toBeNull();
  });

  it("estimates a fractional offset so unmapped taps still seek", () => {
    expect(estimateTextOffsetForHtmlIndex(0, 10, 1000)).toBe(100);
    expect(estimateTextOffsetForHtmlIndex(9, 10, 1000)).toBe(1000);
    expect(estimateTextOffsetForHtmlIndex(4, 10, 1000)).toBe(500);
    expect(estimateTextOffsetForHtmlIndex(0, 0, 1000)).toBe(0);
    expect(estimateTextOffsetForHtmlIndex(0, 10, 0)).toBe(0);
  });
});
