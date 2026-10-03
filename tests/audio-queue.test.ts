import { describe, expect, it } from "vitest";
import {
  audioCacheKey,
  estimateGlobalOffset,
  hashText,
  planAudioFromOffset,
  planAudioNext,
  type SentenceSpan,
} from "../lib/audio-queue";

const SENTENCES: SentenceSpan[] = [
  { text: "Hello world. ", start: 0, end: 13 },
  { text: "   ", start: 13, end: 16 },
  { text: "How are you? ", start: 16, end: 29 },
  { text: "Fine!", start: 29, end: 34 },
];

describe("planAudioFromOffset", () => {
  it("starts at the sentence containing the offset", () => {
    const p = planAudioFromOffset(SENTENCES, 0);
    expect(p).toMatchObject({ sentenceIndex: 0, utterStart: 0, utterText: "Hello world. " });
  });

  it("slices mid-sentence seeks", () => {
    const p = planAudioFromOffset(SENTENCES, 6);
    expect(p).toMatchObject({ sentenceIndex: 0, utterStart: 6 });
    expect(p?.utterText).toBe("Hello world. ".slice(6));
  });

  it("skips whitespace-only sentences", () => {
    const p = planAudioFromOffset(SENTENCES, 13);
    expect(p).toMatchObject({ sentenceIndex: 2, utterStart: 16 });
  });

  it("wraps past the end to the first speakable (mirrored quirk)", () => {
    // findStartSentence wraps to 0, then blank-skipping lands on idx 2.
    expect(planAudioFromOffset(SENTENCES, 999)?.sentenceIndex).toBe(2);
  });

  it("returns null for empty input", () => {
    expect(planAudioFromOffset([], 0)).toBeNull();
  });
});

describe("planAudioNext", () => {
  it("advances whole sentences and skips blanks", () => {
    expect(planAudioNext(SENTENCES, 0)).toMatchObject({ sentenceIndex: 2 });
    expect(planAudioNext(SENTENCES, 2)).toMatchObject({ sentenceIndex: 3 });
  });

  it("returns null at the tail", () => {
    expect(planAudioNext(SENTENCES, 3)).toBeNull();
  });
});

describe("estimateGlobalOffset", () => {
  const plan = { utterStart: 16, utterText: "How are you? " };

  it("interpolates currentTime over the slice", () => {
    expect(estimateGlobalOffset(plan, 0, 2)).toBe(16);
    expect(estimateGlobalOffset(plan, 2, 2)).toBe(16 + plan.utterText.length);
    expect(estimateGlobalOffset(plan, 1, 2)).toBe(16 + Math.floor(plan.utterText.length / 2));
  });

  it("falls back to the slice start on bad timings", () => {
    expect(estimateGlobalOffset(plan, 1, 0)).toBe(16);
    expect(estimateGlobalOffset(plan, Number.NaN, 2)).toBe(16);
    expect(estimateGlobalOffset(plan, 1, Number.NaN)).toBe(16);
  });
});

describe("audioCacheKey", () => {
  it("is stable per content+rate and rate-sensitive", () => {
    expect(audioCacheKey("hello", 175)).toBe(audioCacheKey("hello", 175));
    expect(audioCacheKey("hello", 175)).not.toBe(audioCacheKey("hello", 350));
    expect(audioCacheKey("hello", 175)).not.toBe(audioCacheKey("world", 175));
    expect(hashText("hello")).toMatch(/^[0-9a-f]+$/);
  });
});
