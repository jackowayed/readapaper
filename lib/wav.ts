/**
 * wav — tiny WAV helpers for the offline (`<audio>`) TTS path.
 *
 * mespeak returns a complete WAV file as `number[]` (uint8). We turn it
 * into a `Blob` for `<audio src>`, read its natural duration from the
 * 44-byte RIFF header for highlight sync, and estimate intra-sentence
 * offsets by uniform time interpolation (same degradation level as the
 * Firefox sentence-only fallback — no word timestamps from eSpeak v1).
 *
 * All functions are DOM-free except `wavArrayToBlob` (needs `Blob`, present
 * in browsers and Node 18+); object-URL creation stays in the component so
 * tests never touch `URL.createObjectURL`.
 */

/** Read a little-endian uint32. Returns null on short buffers. */
export function readU32LE(data: ArrayLike<number>, offset: number): number | null {
  const b0 = data[offset];
  const b1 = data[offset + 1];
  const b2 = data[offset + 2];
  const b3 = data[offset + 3];
  if (
    b0 == null ||
    b1 == null ||
    b2 == null ||
    b3 == null ||
    offset < 0 ||
    data.length < offset + 4
  ) {
    return null;
  }
  return (b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)) >>> 0;
}

function tagEquals(data: ArrayLike<number>, offset: number, tag: string): boolean {
  for (let i = 0; i < tag.length; i++) {
    if (data[offset + i] !== tag.charCodeAt(i)) return false;
  }
  return true;
}

/**
 * Natural duration of a WAV file in seconds, from the RIFF header
 * (`dataSize / byteRate`). Null when the header is missing/truncated —
 * callers fall back to `estimateDurationSecForText`.
 */
export function parseWavDurationSec(data: ArrayLike<number>): number | null {
  if (data.length < 44) return null;
  if (!tagEquals(data, 0, "RIFF") || !tagEquals(data, 8, "WAVE")) return null;
  const byteRate = readU32LE(data, 28);
  const dataSize = readU32LE(data, 40);
  if (byteRate == null || dataSize == null || byteRate <= 0) return null;
  const dur = dataSize / byteRate;
  if (!Number.isFinite(dur) || dur <= 0) return null;
  return dur;
}

/**
 * Fallback duration when the WAV header is unusable: words at `wpm`,
 * floored at 0.3s so single-word sentences still get a highlight beat.
 */
export function estimateDurationSecForText(text: string, wpm: number): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const safeWpm = Number.isFinite(wpm) && wpm > 0 ? wpm : 175;
  return Math.max(0.3, (words / safeWpm) * 60);
}

/**
 * Map playback progress (0..1, `currentTime / duration`) to a global char
 * offset inside the spoken sentence slice. Clamped; floors so the playhead
 * never runs past the slice end.
 */
export function estimateOffsetInSentence(
  utterStart: number,
  utterLength: number,
  progress01: number
): number {
  const p = Number.isFinite(progress01) ? Math.min(1, Math.max(0, progress01)) : 0;
  const len = Math.max(0, Math.floor(utterLength));
  return utterStart + Math.min(len, Math.floor(p * len));
}

/** Wrap raw WAV bytes as an `audio/wav` Blob for `<audio src>`. */
export function wavArrayToBlob(wav: ArrayLike<number>): Blob {
  const bytes = new Uint8Array(Array.prototype.slice.call(wav));
  return new Blob([bytes.buffer as ArrayBuffer], { type: "audio/wav" });
}
