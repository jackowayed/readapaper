import { describe, expect, it } from "vitest";
import {
  estimateDurationSecForText,
  estimateOffsetInSentence,
  parseWavDurationSec,
  readU32LE,
  wavArrayToBlob,
} from "../lib/wav";

/** Minimal 44-byte RIFF header + N data bytes (22050Hz 16-bit mono). */
function wavHeader(dataSize: number, byteRate = 44100): number[] {
  const h = new Array(44).fill(0);
  const tag = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) h[off + i] = s.charCodeAt(i);
  };
  const u32 = (off: number, v: number) => {
    h[off] = v & 0xff;
    h[off + 1] = (v >> 8) & 0xff;
    h[off + 2] = (v >> 16) & 0xff;
    h[off + 3] = (v >> 24) & 0xff;
  };
  tag(0, "RIFF");
  tag(8, "WAVE");
  u32(28, byteRate);
  u32(40, dataSize);
  return h.concat(new Array(dataSize).fill(0));
}

describe("readU32LE", () => {
  it("reads little-endian words", () => {
    expect(readU32LE([0x78, 0x56, 0x34, 0x12], 0)).toBe(0x12345678);
    expect(readU32LE([1, 2, 3], 0)).toBeNull();
    expect(readU32LE([1, 2, 3, 4], 1)).toBeNull();
  });
});

describe("parseWavDurationSec", () => {
  it("divides data size by byte rate", () => {
    // 44100 bytes at 44100 B/s -> exactly 1s.
    expect(parseWavDurationSec(wavHeader(44100))).toBeCloseTo(1, 6);
    expect(parseWavDurationSec(wavHeader(22050))).toBeCloseTo(0.5, 6);
  });

  it("rejects truncated or non-WAV buffers", () => {
    expect(parseWavDurationSec(new Array(43).fill(0))).toBeNull();
    const bad = wavHeader(100);
    bad[0] = "X".charCodeAt(0);
    expect(parseWavDurationSec(bad)).toBeNull();
    const zeroRate = wavHeader(100, 0);
    expect(parseWavDurationSec(zeroRate)).toBeNull();
  });
});

describe("estimateDurationSecForText", () => {
  it("scales words at the given wpm with a 0.3s floor", () => {
    // 175 words at 175wpm -> 60s.
    const words = new Array(175).fill("w").join(" ");
    expect(estimateDurationSecForText(words, 175)).toBeCloseTo(60, 6);
    // 1 word at 175wpm -> ~0.34s (above the floor).
    expect(estimateDurationSecForText("hi", 175)).toBeCloseTo((1 / 175) * 60, 6);
    expect(estimateDurationSecForText("", 175)).toBe(0.3);
    expect(estimateDurationSecForText("   ", 175)).toBe(0.3);
  });
});

describe("estimateOffsetInSentence", () => {
  it("interpolates progress over the slice and clamps", () => {
    expect(estimateOffsetInSentence(10, 100, 0)).toBe(10);
    expect(estimateOffsetInSentence(10, 100, 0.5)).toBe(60);
    expect(estimateOffsetInSentence(10, 100, 1)).toBe(110);
    expect(estimateOffsetInSentence(10, 100, 2)).toBe(110);
    expect(estimateOffsetInSentence(10, 100, -1)).toBe(10);
    expect(estimateOffsetInSentence(10, 100, Number.NaN)).toBe(10);
  });
});

describe("wavArrayToBlob", () => {
  it("wraps bytes as audio/wav", () => {
    const wav = wavHeader(16);
    const blob = wavArrayToBlob(wav);
    expect(blob.type).toBe("audio/wav");
    expect(blob.size).toBe(wav.length);
  });
});
